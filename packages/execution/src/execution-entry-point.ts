import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import {
  runnerEventSchema,
  type ExecutionContext,
  type RunnerEvent
} from '@autocatalyst/api-contract';
import { abortable, detachCleanup } from './abortable.js';
import type { AgentModelMemoryContinuity } from './agent-model-memory.js';

import type { ExecutionBoundaryEvent, ExecutionTerminalResultEvent } from './execution-boundary-events.js';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import { createStructuredAgentResultCapture } from './structured-result-capture.js';
import type { StructuredAgentResultCapture } from './structured-result-capture.js';
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
import type { Runner, RunnerSessionMetadata } from './runner.js';

/**
 * Thrown when the execution stream fails before emitting a terminal event and the runner has
 * cached session metadata from the failed session. Callers can extract `sessionMetadata` to
 * persist a failed durable session row without losing the original `cause` error for reason
 * classification.
 */
export class PreTerminalRunnerFailure extends Error {
  override readonly cause: unknown;
  readonly sessionMetadata: RunnerSessionMetadata;

  constructor(cause: unknown, sessionMetadata: RunnerSessionMetadata) {
    super('Runner failed before terminal result.');
    this.name = 'PreTerminalRunnerFailure';
    this.cause = cause;
    this.sessionMetadata = sessionMetadata;
  }
}

export interface ExecutionEntryPointInput {
  readonly context: ExecutionContext;
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly modelMemory?: AgentModelMemoryContinuity;
  readonly transportRetry?: number;
  readonly attemptId?: string;
  readonly freshHandoff?: string;
  readonly onAttemptLaunch?: import('./runner.js').RunnerRunInput['onAttemptLaunch'];
  readonly nativeConversation?: import('./native-conversation.js').NativeConversationTurn;
  readonly prepareConversation?: (environment: MaterializedExecutionEnvironment,
    profile?: import('./agent-provider-adapter.js').ResolvedAgentRunnerProfile) =>
    Promise<import('./native-conversation.js').NativeConversationTurn | undefined>;
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
    async *execute(input): AsyncIterable<ExecutionBoundaryEvent> {
      const { signal } = input;
      let launch: Parameters<NonNullable<ExecutionEntryPointInput['onAttemptLaunch']>>[0] | undefined;
      let bufferedMetadata: ExecutionTerminalResultEvent['sessionMetadata'];
      let closing: ReturnType<Runner['close']> | undefined;
      const close = () => closing ??= Promise.resolve().then(() => options.runner.close());
      const onAttemptLaunch: ExecutionEntryPointInput['onAttemptLaunch'] = signal ? facts => {
        if (signal.aborted) return;
        launch = facts;
        input.onAttemptLaunch?.(facts);
      } : input.onAttemptLaunch;
      try {
        signal?.throwIfAborted();
        for await (const event of executeAttempt(options, input, close, onAttemptLaunch)) {
          if (event.type === 'runner_terminal_result') bufferedMetadata = event.sessionMetadata;
          signal?.throwIfAborted();
          yield event;
        }
      } catch (error) {
        if (!signal?.aborted) throw error;
        let snapshot: RunnerSessionMetadata | null | undefined;
        if (launch) {
          try { snapshot = options.runner.snapshotSessionMetadata?.(); } catch { /* metadata is best-effort */ }
        }
        const facts = bufferedMetadata ?? snapshot ?? launch;
        const endedAt = new Date().toISOString();
        void close().catch(() => undefined);
        yield cancellationTerminal(input, facts ? {
          usageAvailable: false,
          ...facts,
          endedAt,
          outcome: 'cancelled'
        } : undefined, endedAt);
      }
    }
  };
}

async function* executeAttempt(
  options: CreateExecutionEntryPointOptions,
  input: ExecutionEntryPointInput,
  close: Runner['close'],
  onAttemptLaunch: ExecutionEntryPointInput['onAttemptLaunch']
): AsyncIterable<ExecutionBoundaryEvent> {
  const { signal } = input;
  const environment = await options.materialize(input.context);
  signal?.throwIfAborted();
  const expectedRunId = input.context.run.id;

  // Resolve config before starting the runner so we can attach structuredResultCapture
  // to the runner input and fail-fast if the contract is missing.
  const config = await resolveResultValidationConfig(options.resultValidation, input);

  signal?.throwIfAborted();

  // Resolve structured result capture before starting the provider session.
  // For mode:none or no-contract steps, capture is undefined (no-op).
  // For contract-required steps, capture is attached to the runner input.
  // Pre-run failures fail-terminal before the provider session starts.
  let resolvedCapture: StructuredAgentResultCapture | undefined;
  if (config.mode === 'scratch_file') {
    const contractResolution = resolveScratchFileContract(config, input.context.run.currentStep ?? '');
    if (contractResolution.kind === 'failed') {
      const failEvent = makePreRunFailTerminal(input, contractResolution.code, expectedRunId);
      yield failEvent;
      return;
    }
    const contract = contractResolution.contract;
    const captureContract =
      config.resultFile !== undefined
        ? { ...contract, resultFile: config.resultFile }
        : contract;
    const captureResolution = createStructuredAgentResultCapture({
      mode: 'scratch_file',
      step: contract.step,
      contract: captureContract
    });
    if (captureResolution.status === 'failed') {
      const failEvent = makePreRunFailTerminal(input, captureResolution.code, expectedRunId);
      yield failEvent;
      return;
    }
    if (captureResolution.status === 'capture') {
      resolvedCapture = captureResolution.capture;
    }
  }

  const nativeConversation = input.prepareConversation ? await input.prepareConversation(environment) : input.nativeConversation;
  signal?.throwIfAborted();
  const freshHandoff = (input.prepareConversation && nativeConversation === undefined) ||
    (nativeConversation?.mode === 'retained' && nativeConversation.resumeId) ||
    (nativeConversation?.mode === 'in_memory' && nativeConversation.resource) ? undefined : input.freshHandoff;
  const runnerEnvironment = freshHandoff ? {
    ...environment,
    context: { ...environment.context, task: {
      ...environment.context.task, prompt: [environment.context.task.prompt, freshHandoff].join('\n\n')
    } }
  } : environment;
  const runnerInput = {
    environment: runnerEnvironment,
    ...(signal ? { signal } : {}),
    ...(nativeConversation !== undefined ? { nativeConversation } : {}),
    ...(onAttemptLaunch ? { onAttemptLaunch } : {}),
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(resolvedCapture !== undefined ? { structuredResultCapture: resolvedCapture } : {}),
    ...(input.modelMemory !== undefined ? { modelMemory: input.modelMemory } : {})
  };
  let streamError: unknown = undefined;
  let closeProtocolError: RunnerProtocolError | undefined;
  let rawTerminal: RawTerminalEvent | undefined;

  // Validate the raw RunnerEvent stream before result transformation.
  // Non-terminal events are yielded immediately for live delivery; the terminal event
  // is buffered until runner.close() completes and async result validation runs.
  try {
    const events = options.runner.run(runnerInput);
    for await (const event of signal ? interruptibleEvents(events, signal) : events) {
      signal?.throwIfAborted();
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
      await abortable(signal, close);
    } catch {
      if (streamError === undefined && rawTerminal !== undefined) {
        closeProtocolError = new RunnerProtocolError(
          'runner_close_failed',
          'Runner close failed after successful stream completion.'
        );
      }
    }
  }

  signal?.throwIfAborted();
  if (closeProtocolError !== undefined) {
    throw closeProtocolError;
  }
  if (streamError !== undefined) {
    // If the runner cached session metadata during the failed stream, wrap the error so
    // callers (e.g. execution-run-unit-of-work) can persist a failed durable session row.
    // getSessionMetadata() is called after close() to match the successful-path ordering.
    const failedMeta = await abortable(signal, async () => options.runner.getSessionMetadata?.().catch(() => null) ?? null);
    if (failedMeta !== null) {
      throw new PreTerminalRunnerFailure(streamError, failedMeta);
    }
    throw streamError;
  }

  if (rawTerminal === undefined) {
    // Match legacy behaviour: stream completes without yielding a terminal.
    // Downstream boundary validators surface missing_terminal_result.
    return;
  }

  const terminal = await abortable(signal, () => buildTerminalBoundaryEvent({
    rawTerminal,
    environment,
    config,
    runId: expectedRunId,
    signal
  }));
  const sessionMetadata = await abortable(signal, async () => options.runner.getSessionMetadata?.() ?? null);
  signal?.throwIfAborted();
  const terminalWithMetadata =
    sessionMetadata === null
      ? terminal
      : { ...terminal, sessionMetadata };
  yield terminalWithMetadata;
}

/** The boundary cancellation terminal is internal; it is never published as a client failure. */
export function cancellationTerminal(
  input: ExecutionEntryPointInput,
  sessionMetadata?: ExecutionTerminalResultEvent['sessionMetadata'],
  createdAt = new Date().toISOString()
): ExecutionTerminalResultEvent {
  return {
    id: `evt_${randomUUID()}`,
    type: 'runner_terminal_result',
    runId: input.context.run.id,
    step: input.context.run.currentStep,
    importance: 'normal',
    createdAt,
    outcome: 'cancelled',
    result: { directive: 'fail', reason: 'Execution cancelled.' },
    ...(sessionMetadata ? { sessionMetadata } : {})
  };
}

async function* interruptibleEvents(events: AsyncIterable<RunnerEvent>, signal: AbortSignal): AsyncIterable<RunnerEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let done = false;
  try {
    for (;;) {
      const next = await abortable(signal, () => iterator.next());
      done = next.done === true;
      if (done) return;
      signal.throwIfAborted();
      yield next.value;
    }
  } finally {
    if (!done && iterator.return) {
      if (signal.aborted) detachCleanup(() => iterator.return?.());
      else await abortable(signal, () => iterator.return!());
    }
  }
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
  readonly signal: AbortSignal | undefined;
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
  input.signal?.throwIfAborted();
  if (read.status === 'failed') {
    return makeFailTerminal(rawTerminal, `Execution failed: ${read.code}`);
  }

  const normalizers = composeNormalizers(contract.normalizers, config.normalizers);
  const validation = await validateStepResult({
    runId: input.runId,
    step: contract.step,
    schemaId: contract.schemaId,
    schema: contract.schema,
    candidate: read.value,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(normalizers !== undefined ? { normalizers } : {}),
    ...(config.correctionRequester !== undefined
      ? { correctionRequester: config.correctionRequester }
      : contract.correctionRequester !== undefined
        ? { correctionRequester: contract.correctionRequester }
        : {}),
    ...(config.maxCorrectionAttempts !== undefined
      ? { maxCorrectionAttempts: config.maxCorrectionAttempts }
      : contract.maxCorrectionAttempts !== undefined
        ? { maxCorrectionAttempts: contract.maxCorrectionAttempts }
        : {}),
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

function listNormalizers(value: ResultNormalizerRegistry | readonly ResultNormalizer[] | undefined): readonly ResultNormalizer[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return (value as ResultNormalizerRegistry).normalizers;
}

function composeNormalizers(
  contractNormalizers: ResultNormalizerRegistry | readonly ResultNormalizer[] | undefined,
  configNormalizers: ResultNormalizerRegistry | readonly ResultNormalizer[] | undefined
): readonly ResultNormalizer[] | undefined {
  const composed = [...listNormalizers(contractNormalizers), ...listNormalizers(configNormalizers)];
  return composed.length > 0 ? composed : undefined;
}

function makePreRunFailTerminal(
  input: ExecutionEntryPointInput,
  code: string,
  runId: string
): ExecutionTerminalResultEvent {
  return {
    id: `pre_run_fail_${Date.now()}`,
    type: 'runner_terminal_result',
    runId,
    step: input.context.run.currentStep ?? '',
    importance: 'high',
    createdAt: new Date().toISOString(),
    result: { directive: 'fail', reason: `Execution failed: ${code}` }
  };
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
