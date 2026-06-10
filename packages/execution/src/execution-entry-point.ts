import type { z } from 'zod';

import {
  runnerEventSchema,
  type ExecutionContext,
  type RunnerEvent
} from '@autocatalyst/api-contract';

import type { ExecutionBoundaryEvent, ExecutionTerminalResultEvent } from './execution-boundary-events.js';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import type { ResultCorrectionRequester } from './result-correction.js';
import {
  resolveStepResultContract,
  type StepResultContractDefinition,
  type StepResultContractRegistry
} from './result-contracts.js';
import { readScratchStepResultFile } from './result-file.js';
import type { ResultNormalizer, ResultNormalizerRegistry } from './result-normalizers.js';
import { validateStepResult, type ResultDegradationPolicy } from './result-tolerance.js';
import { RunnerProtocolError } from './runner.js';
import type { Runner } from './runner.js';

export interface ExecutionEntryPointInput {
  readonly context: ExecutionContext;
  readonly correlationId?: string;
}

export interface NoExecutionResultValidationConfig {
  readonly mode: 'none';
}

export interface ScratchFileExecutionResultValidationConfig {
  readonly mode: 'scratch_file';
  readonly step?: string;
  readonly schemaId?: string;
  readonly schema?: z.ZodTypeAny;
  readonly resultFile?: string;
  readonly contract?: StepResultContractDefinition;
  readonly contractRegistry?: StepResultContractRegistry;
  readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[];
  readonly correctionRequester?: ResultCorrectionRequester;
  readonly maxCorrectionAttempts?: number;
  readonly degradationPolicy?: ResultDegradationPolicy;
}

export type ExecutionResultValidationConfig =
  | NoExecutionResultValidationConfig
  | ScratchFileExecutionResultValidationConfig;

export type ExecutionResultValidationResolver = (
  input: ExecutionEntryPointInput
) => ExecutionResultValidationConfig | Promise<ExecutionResultValidationConfig>;

export interface ExecutionEntryPoint {
  execute(input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent>;
}

export interface CreateExecutionEntryPointOptions {
  readonly runner: Runner;
  readonly materialize: (context: ExecutionContext) => Promise<MaterializedExecutionEnvironment>;
  readonly resultValidation: ExecutionResultValidationConfig | ExecutionResultValidationResolver;
}

type RawTerminalEvent = Extract<RunnerEvent, { type: 'runner_terminal_result' }>;

export function createExecutionEntryPoint(options: CreateExecutionEntryPointOptions): ExecutionEntryPoint {
  assertResultValidationOption(options.resultValidation);

  return {
    async *execute(input: ExecutionEntryPointInput): AsyncIterable<ExecutionBoundaryEvent> {
      const environment = await options.materialize(input.context);
      const runnerInput = {
        environment,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {})
      };
      const expectedRunId = input.context.run.id;
      let streamError: unknown = undefined;
      let closeProtocolError: RunnerProtocolError | undefined;
      let rawTerminal: RawTerminalEvent | undefined;

      // Validate the raw RunnerEvent stream before result transformation.
      // Non-terminal events are yielded immediately for live delivery; the terminal event
      // is buffered until runner.close() completes and async result validation runs.
      try {
        for await (const event of options.runner.run(runnerInput)) {
          const parsed = runnerEventSchema.safeParse(event);
          if (!parsed.success) {
            throw new RunnerProtocolError('invalid_event', 'Runner produced an invalid event.');
          }
          const validated = parsed.data;
          if (validated.runId !== expectedRunId) {
            throw new RunnerProtocolError('wrong_run', 'Runner event has wrong run id.');
          }
          if (validated.type === 'runner_terminal_result') {
            if (rawTerminal !== undefined) {
              throw new RunnerProtocolError(
                'duplicate_terminal_result',
                'Runner emitted a duplicate terminal event.'
              );
            }
            rawTerminal = validated;
            continue;
          }
          if (rawTerminal !== undefined) {
            throw new RunnerProtocolError(
              'event_after_terminal',
              'Runner emitted an event after the terminal event.'
            );
          }
          yield validated as Exclude<RunnerEvent, { type: 'runner_terminal_result' }>;
        }
      } catch (error) {
        streamError = error;
      } finally {
        try {
          await options.runner.close();
        } catch {
          if (streamError === undefined && rawTerminal !== undefined) {
            closeProtocolError = new RunnerProtocolError(
              'runner_close_failed',
              'Runner close failed after successful stream completion.'
            );
          }
        }
      }

      if (closeProtocolError !== undefined) {
        throw closeProtocolError;
      }
      if (streamError !== undefined) {
        throw streamError;
      }

      if (rawTerminal === undefined) {
        // Match legacy behaviour: stream completes without yielding a terminal.
        // Downstream boundary validators surface missing_terminal_result.
        return;
      }

      const config = await resolveResultValidationConfig(options.resultValidation, input);
      const terminal = await buildTerminalBoundaryEvent({
        rawTerminal,
        environment,
        config,
        runId: expectedRunId
      });
      yield terminal;
    }
  };
}

function assertResultValidationOption(
  option: CreateExecutionEntryPointOptions['resultValidation']
): void {
  if (option === undefined || option === null) {
    throw new TypeError('Invalid execution resultValidation configuration.');
  }
  if (typeof option === 'function') return;
  if (typeof option !== 'object') {
    throw new TypeError('Invalid execution resultValidation configuration.');
  }
  if (option.mode === 'none') return;
  if (option.mode === 'scratch_file') {
    const hasContract = option.contract !== undefined;
    const hasInlineSchema = option.schema !== undefined && option.schemaId !== undefined;
    const hasRegistry =
      option.contractRegistry !== undefined &&
      option.step !== undefined &&
      option.schemaId !== undefined;
    if (!hasContract && !hasInlineSchema && !hasRegistry) {
      throw new TypeError('Invalid execution resultValidation configuration.');
    }
    return;
  }
  throw new TypeError('Invalid execution resultValidation configuration.');
}

async function resolveResultValidationConfig(
  option: ExecutionResultValidationConfig | ExecutionResultValidationResolver,
  input: ExecutionEntryPointInput
): Promise<ExecutionResultValidationConfig> {
  const resolved = typeof option === 'function' ? await option(input) : option;
  assertResultValidationOption(resolved);
  return resolved;
}

interface BuildTerminalInput {
  readonly rawTerminal: RawTerminalEvent;
  readonly environment: MaterializedExecutionEnvironment;
  readonly config: ExecutionResultValidationConfig;
  readonly runId: string;
}

async function buildTerminalBoundaryEvent(input: BuildTerminalInput): Promise<ExecutionTerminalResultEvent> {
  const { rawTerminal, config } = input;
  if (config.mode === 'none') {
    return {
      id: rawTerminal.id,
      type: 'runner_terminal_result',
      runId: rawTerminal.runId,
      step: rawTerminal.step,
      importance: rawTerminal.importance,
      createdAt: rawTerminal.createdAt,
      result: { ...rawTerminal.result }
    };
  }

  // In scratch_file mode, only validate a result file for advance directives.
  // needs_input and fail terminals write no result file; pass them through unchanged.
  if (rawTerminal.result.directive !== 'advance') {
    return {
      id: rawTerminal.id,
      type: 'runner_terminal_result',
      runId: rawTerminal.runId,
      step: rawTerminal.step,
      importance: rawTerminal.importance,
      createdAt: rawTerminal.createdAt,
      result: { ...rawTerminal.result }
    };
  }

  // scratch_file mode
  const resolution = resolveScratchFileContract(config, rawTerminal.step);
  if (resolution.kind === 'failed') {
    return makeFailTerminal(rawTerminal, `Execution failed: ${resolution.code}`);
  }

  const contract = resolution.contract;
  const resultFile = config.resultFile ?? contract.resultFile;
  if (resultFile === undefined || resultFile.length === 0) {
    return makeFailTerminal(rawTerminal, 'Execution failed: result_file_missing');
  }

  const read = await readScratchStepResultFile({
    environment: input.environment,
    resultFile
  });
  if (read.status === 'failed') {
    return makeFailTerminal(rawTerminal, `Execution failed: ${read.code}`);
  }

  const validation = await validateStepResult({
    runId: input.runId,
    step: contract.step,
    schemaId: contract.schemaId,
    schema: contract.schema,
    candidate: read.value,
    ...(config.normalizers !== undefined ? { normalizers: config.normalizers } : {}),
    ...(config.correctionRequester !== undefined ? { correctionRequester: config.correctionRequester } : {}),
    ...(config.maxCorrectionAttempts !== undefined ? { maxCorrectionAttempts: config.maxCorrectionAttempts } : {}),
    ...(config.degradationPolicy !== undefined
      ? { degradationPolicy: config.degradationPolicy }
      : contract.degradationPolicy !== undefined
        ? { degradationPolicy: contract.degradationPolicy }
        : {})
  });

  if (validation.status === 'failed') {
    return makeFailTerminal(rawTerminal, `Execution failed: ${validation.code}`);
  }

  // The schema type is erased by the registry's ZodTypeAny bound; validateStepResult has already guaranteed the shape.
  const validatedResult = validation.value as Record<string, unknown>;

  return {
    id: rawTerminal.id,
    type: 'runner_terminal_result',
    runId: rawTerminal.runId,
    step: rawTerminal.step,
    importance: rawTerminal.importance,
    createdAt: rawTerminal.createdAt,
    result: {
      ...rawTerminal.result,
      result: validatedResult
    },
    resultContract: { step: contract.step, schemaId: contract.schemaId }
  };
}

type ContractResolutionOutcome =
  | { readonly kind: 'resolved'; readonly contract: StepResultContractDefinition }
  | { readonly kind: 'failed'; readonly code: 'result_contract_missing' | 'result_contract_unknown' };

function resolveScratchFileContract(
  config: ScratchFileExecutionResultValidationConfig,
  terminalStep: string
): ContractResolutionOutcome {
  if (config.contract !== undefined) {
    return { kind: 'resolved', contract: config.contract };
  }
  if (config.contractRegistry !== undefined) {
    if (config.step === undefined || config.schemaId === undefined) {
      return { kind: 'failed', code: 'result_contract_missing' };
    }
    const resolution = resolveStepResultContract({
      registry: config.contractRegistry,
      step: config.step,
      schemaId: config.schemaId
    });
    if (resolution.status === 'failed') {
      return { kind: 'failed', code: resolution.code };
    }
    return { kind: 'resolved', contract: resolution.contract };
  }
  if (config.schema !== undefined && config.schemaId !== undefined) {
    return {
      kind: 'resolved',
      contract: {
        step: config.step ?? terminalStep,
        schemaId: config.schemaId,
        schema: config.schema,
        ...(config.resultFile !== undefined ? { resultFile: config.resultFile } : {}),
        ...(config.degradationPolicy !== undefined ? { degradationPolicy: config.degradationPolicy } : {})
      }
    };
  }
  return { kind: 'failed', code: 'result_contract_missing' };
}

function makeFailTerminal(rawTerminal: RawTerminalEvent, reason: string): ExecutionTerminalResultEvent {
  return {
    id: rawTerminal.id,
    type: 'runner_terminal_result',
    runId: rawTerminal.runId,
    step: rawTerminal.step,
    importance: rawTerminal.importance,
    createdAt: rawTerminal.createdAt,
    result: { directive: 'fail', reason }
  };
}
