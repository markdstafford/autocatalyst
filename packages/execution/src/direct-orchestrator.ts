import { z } from 'zod';
import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import { ProviderConfigurationError } from './agent-provider-adapter.js';
import type {
  DirectCallRequest,
  DirectProviderAdapter,
  DirectProviderCallMetadata
} from './direct-provider-adapter.js';
import { DirectProviderProtocolError, DirectResultValidationError } from './direct-provider-adapter.js';
import type { StepResultValidationSuccess } from './result-tolerance.js';
import { validateStepResult } from './result-tolerance.js';

export interface DirectOrchestratorTelemetryEmitter {
  emit(event: string, fields: Record<string, unknown>): void;
}

export interface DirectOrchestratorLogger {
  info?(event: string, fields: Record<string, unknown>): void;
  warn?(event: string, fields: Record<string, unknown>): void;
  error?(event: string, fields: Record<string, unknown>): void;
}

export interface CreateDirectOrchestratorOptions {
  readonly adapter: DirectProviderAdapter;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
  readonly telemetry?: DirectOrchestratorTelemetryEmitter;
  readonly logger?: DirectOrchestratorLogger;
  readonly clock?: () => number;
}

export interface DirectOrchestratorCallResult<TValue = unknown> {
  readonly value: TValue;
  readonly validation: StepResultValidationSuccess<TValue>;
  readonly metadata: DirectProviderCallMetadata;
}

export interface DirectOrchestrator {
  call<TSchema extends z.ZodTypeAny>(call: DirectCallRequest<TSchema>): Promise<DirectOrchestratorCallResult<z.infer<TSchema>>>;
  close(): Promise<void>;
}

export function createDirectOrchestrator(options: CreateDirectOrchestratorOptions): DirectOrchestrator {
  const { adapter, profile, connection, telemetryContext, telemetry, clock = Date.now } = options;

  let adapterClosed = false;
  let callCompleted = false;
  let connectionClosed = false;

  const orchestrator: DirectOrchestrator = {
    async call<TSchema extends z.ZodTypeAny>(call: DirectCallRequest<TSchema>): Promise<DirectOrchestratorCallResult<z.infer<TSchema>>> {
      // Preflight checks
      if (callCompleted) {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          'DirectOrchestrator.call() may only be called once. The orchestrator closes adapter resources on completion.',
          { providerKind: profile.providerKind, adapterId: profile.adapterId }
        );
      }
      if (profile.mode !== 'direct') {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          'Direct orchestrator requires a direct profile.',
          { mode: profile.mode }
        );
      }
      if (adapter.providerKind !== profile.providerKind) {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          'Adapter providerKind does not match profile providerKind.',
          { profileProviderKind: profile.providerKind, adapterProviderKind: adapter.providerKind }
        );
      }
      if (adapter.adapterId !== profile.adapterId) {
        throw new ProviderConfigurationError(
          'unsupported_adapter',
          'Adapter id does not match profile adapter id.',
          { profileAdapterId: profile.adapterId, adapterId: adapter.adapterId }
        );
      }
      if (adapter.supportedConnectionMechanism !== profile.connectionMechanism) {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          'Adapter connection mechanism does not match profile.',
          { profileConnectionMechanism: profile.connectionMechanism, adapterConnectionMechanism: adapter.supportedConnectionMechanism }
        );
      }

      const startedAt = clock();

      telemetry?.emit('direct_orchestrator_call_start', {
        runId: telemetryContext.runId,
        phase: telemetryContext.phase,
        step: telemetryContext.step,
        role: undefined,
        providerKind: profile.providerKind,
        adapterId: profile.adapterId,
        profileName: profile.profileName,
        connectionMechanism: profile.connectionMechanism,
        model: profile.model,
        inferenceSettings: profile.inferenceSettings,
        purpose: call.purpose
      });

      let adapterResult: import('./direct-provider-adapter.js').DirectProviderCallResult;

      try {
        adapterResult = await adapter.call({ call, profile, connection, telemetryContext });
      } catch (err) {
        const durationMs = clock() - startedAt;
        let safeErrorCode: string;
        let safeErrorName: string;
        if (err instanceof Error) {
          safeErrorName = err.name;
          const e = err as { code?: string };
          safeErrorCode = e.code ?? 'unknown';
        } else {
          safeErrorName = 'UnknownError';
          safeErrorCode = 'unknown';
        }

        telemetry?.emit('direct_orchestrator_call_end', {
          runId: telemetryContext.runId,
          phase: telemetryContext.phase,
          step: telemetryContext.step,
          durationMs,
          outcome: 'failed',
          providerKind: profile.providerKind,
          adapterId: profile.adapterId,
          safeErrorCode,
          safeErrorName
        });

        try {
          await orchestrator.close();
        } catch {
          // suppress close errors during failure cleanup
        }

        throw err;
      }

      // Validate adapter result metadata
      if (adapterResult.candidate === undefined || adapterResult.candidate === null) {
        const durationMs = clock() - startedAt;
        telemetry?.emit('direct_orchestrator_call_end', {
          runId: telemetryContext.runId,
          phase: telemetryContext.phase,
          step: telemetryContext.step,
          durationMs,
          outcome: 'failed',
          providerKind: profile.providerKind,
          adapterId: profile.adapterId,
          safeErrorCode: 'missing_candidate'
        });
        await orchestrator.close().catch(() => {});
        throw new DirectProviderProtocolError(
          'missing_candidate',
          'Adapter returned missing candidate.',
          { providerKind: profile.providerKind, adapterId: profile.adapterId }
        );
      }

      if (adapterResult.metadata.outcome !== 'succeeded') {
        const durationMs = clock() - startedAt;
        telemetry?.emit('direct_orchestrator_call_end', {
          runId: telemetryContext.runId,
          phase: telemetryContext.phase,
          step: telemetryContext.step,
          durationMs,
          outcome: 'failed',
          providerKind: profile.providerKind,
          adapterId: profile.adapterId,
          safeErrorCode: 'invalid_direct_metadata'
        });
        await orchestrator.close().catch(() => {});
        throw new DirectProviderProtocolError(
          'invalid_direct_metadata',
          'Adapter returned non-success outcome metadata.',
          { outcome: adapterResult.metadata.outcome }
        );
      }

      // Run result validation
      const { resultValidation } = call;
      const validationStep = resultValidation.step ?? telemetryContext.step;

      const validationOutcome = await validateStepResult({
        runId: telemetryContext.runId,
        step: validationStep,
        schemaId: resultValidation.schemaId,
        schema: resultValidation.schema,
        candidate: adapterResult.candidate,
        ...(resultValidation.normalizers !== undefined && { normalizers: resultValidation.normalizers }),
        ...(resultValidation.correctionRequester !== undefined && { correctionRequester: resultValidation.correctionRequester }),
        ...(resultValidation.maxCorrectionAttempts !== undefined && { maxCorrectionAttempts: resultValidation.maxCorrectionAttempts }),
        ...(resultValidation.degradationPolicy !== undefined && { degradationPolicy: resultValidation.degradationPolicy })
      });

      const durationMs = clock() - startedAt;

      if (validationOutcome.status === 'failed') {
        telemetry?.emit('direct_orchestrator_call_end', {
          runId: telemetryContext.runId,
          phase: telemetryContext.phase,
          step: telemetryContext.step,
          durationMs,
          outcome: 'failed',
          providerKind: profile.providerKind,
          adapterId: profile.adapterId,
          safeErrorCode: validationOutcome.code,
          schemaId: validationOutcome.schemaId
        });
        await orchestrator.close().catch(() => {});
        throw new DirectResultValidationError(
          validationOutcome.code,
          'Direct call result failed validation.',
          { runId: telemetryContext.runId, step: validationStep, schemaId: resultValidation.schemaId }
        );
      }

      telemetry?.emit('direct_orchestrator_call_end', {
        runId: telemetryContext.runId,
        phase: telemetryContext.phase,
        step: telemetryContext.step,
        durationMs,
        outcome: 'succeeded',
        providerKind: profile.providerKind,
        adapterId: profile.adapterId,
        tokenUsage: adapterResult.metadata.tokenUsage,
        degradedCapabilities: adapterResult.metadata.degradedCapabilities,
        model: adapterResult.metadata.model
      });

      callCompleted = true;
      await orchestrator.close();

      return {
        value: validationOutcome.value as z.infer<TSchema>,
        validation: validationOutcome as StepResultValidationSuccess<z.infer<TSchema>>,
        metadata: adapterResult.metadata
      };
    },

    async close(): Promise<void> {
      if (!adapterClosed && adapter.close !== undefined) {
        adapterClosed = true;
        await adapter.close();
      }
      if (!connectionClosed) {
        connectionClosed = true;
        await connection.close();
      }
    }
  };

  return orchestrator;
}
