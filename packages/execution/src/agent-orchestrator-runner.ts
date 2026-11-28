import { isReviewedSpecCapture } from './structured-result-capture.js';
import { runnerEventSchema, sessionUsageSchema, type RunnerEvent } from '@autocatalyst/api-contract';
import { createNoopAgentModelMemoryStore } from './agent-model-memory.js';
import { createScratchAgentModelMemoryStore } from './scratch-model-memory.js';

import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentProviderAdapter,
  AgentProviderSession,
  AgentTokenUsage,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import { ProviderConfigurationError, ProviderConnectionError } from './agent-provider-adapter.js';
import type { Runner, RunnerCloseResult, RunnerRunInput, RunnerSessionMetadata } from './runner.js';
import { RunnerProtocolError } from './runner.js';

export interface AgentOrchestratorTelemetryEmitter {
  emit(event: string, fields: Record<string, unknown>): void;
}

export interface CreateAgentOrchestratorRunnerOptions {
  readonly adapter: AgentProviderAdapter;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
  readonly telemetry?: AgentOrchestratorTelemetryEmitter;
  readonly clock?: () => number;
}

export function createAgentOrchestratorRunner(options: CreateAgentOrchestratorRunnerOptions): Runner {
  const { adapter, profile, connection, telemetryContext, telemetry, clock = Date.now } = options;

  // State for close idempotency — shared between run() generator and close().
  let activeSession: AgentProviderSession | undefined;
  let closeRequested = false;
  let launchFacts: Parameters<NonNullable<RunnerRunInput['onAttemptLaunch']>>[0] | undefined;
  let assistantTurnCount = 0;
  let toolCallCount = 0;
  let sessionClosed = false;
  let adapterClosed = false;
  let connectionClosed = false;

  // Cached safe session metadata — populated in the run() finally block.
  let cachedSessionMetadata: RunnerSessionMetadata | null = null;

  return {
    async *run(input: RunnerRunInput): AsyncIterable<RunnerEvent> {
      if (closeRequested || input.signal?.aborted) return;
      // Pre-flight validation
      if (profile.mode !== 'agent') {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          'Agent orchestrator requires an agent profile.',
          { mode: profile.mode }
        );
      }
      if (adapter.providerKind !== profile.providerKind) {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          `Adapter providerKind '${adapter.providerKind}' does not match profile providerKind '${profile.providerKind}'.`
        );
      }
      if (adapter.supportedConnectionMechanism !== profile.connectionMechanism) {
        throw new ProviderConfigurationError(
          'mechanism_mismatch',
          `Adapter supportedConnectionMechanism '${adapter.supportedConnectionMechanism}' does not match profile connectionMechanism '${profile.connectionMechanism}'.`
        );
      }

      const coldSpecReviewer = telemetryContext.step === 'spec.author' && telemetryContext.role === 'reviewer';
      if (coldSpecReviewer && (!adapter.supportsSpecReview || !input.structuredResultCapture ||
          input.environment.workspace.shape !== 'two_roots' ||
          input.environment.toolPolicy.allowedTools.some(tool => !['Read', 'Glob', 'Grep'].includes(tool)))) {
        throw new ProviderConfigurationError('unsupported_adapter', 'The reviewer adapter cannot enforce scoped spec review.');
      }
      const startedAt = clock();
      const startedAtIso = new Date(startedAt).toISOString();

      telemetry?.emit('agent_orchestrator_session_start', {
        runId: telemetryContext.runId,
        phase: telemetryContext.phase,
        step: telemetryContext.step,
        role: telemetryContext.role,
        profileName: profile.profileName,
        providerKind: profile.providerKind,
        adapterId: profile.adapterId,
        connectionMechanism: profile.connectionMechanism,
        model: profile.model,
        inferenceSettings: profile.inferenceSettings,
        // Safe structured capture metadata (no raw result values)
        ...(input.structuredResultCapture !== undefined ? {
          structuredResultCapture: true,
          schemaId: input.structuredResultCapture.schemaId,
          captureStep: input.structuredResultCapture.step,
          ...(!isReviewedSpecCapture(input.structuredResultCapture) ? { resultFile: input.structuredResultCapture.resultFile } : {})
        } : {})
      });

      const memoryKey = JSON.stringify([
        input.environment.context.run.id,
        telemetryContext.role ?? 'implementer',
        profile.providerKind,
        profile.adapterId,
        profile.profileName
      ]);
      const workspace = input.environment.workspace;
      const scratchRoot = workspace.shape === 'none'
        ? input.environment.capabilities.paths.scratchRoot
        : workspace.scratchRoot;
      const defaultModelMemory = () => ({
        key: memoryKey,
        store: scratchRoot === undefined
          ? createNoopAgentModelMemoryStore()
          : createScratchAgentModelMemoryStore({
              scratchRoot,
              key: memoryKey,
              onWarning(operation) {
                const fields = {
                  runId: telemetryContext.runId,
                  step: telemetryContext.step,
                  role: telemetryContext.role,
                  level: 'warn',
                  operation
                };
                if (telemetry !== undefined) telemetry.emit('agent_model_memory_cache_warning', fields);
                else console.warn({ event: 'agent_model_memory_cache_warning', ...fields });
              }
            })
      });
      const scopedModelMemory = coldSpecReviewer || input.environment.context.run.currentStep === 'pr.finalize' ? undefined : input.modelMemory?.forProvider?.({
        providerKind: profile.providerKind,
        adapterId: profile.adapterId,
        profileName: profile.profileName
      }) ?? input.modelMemory ?? defaultModelMemory();
      const sessionRunInput =
        scopedModelMemory !== undefined && scopedModelMemory !== input.modelMemory
          ? { ...input, modelMemory: scopedModelMemory }
          : input;

      if (closeRequested || input.signal?.aborted) return;
      // Start session
      const session = await adapter.startSession({
        runInput: sessionRunInput,
        profile,
        connection,
        telemetryContext,
        ...(input.structuredResultCapture !== undefined ? { structuredResultCapture: input.structuredResultCapture } : {}),
        ...(scopedModelMemory !== undefined ? { modelMemory: scopedModelMemory } : {})
      });
      if (closeRequested || input.signal?.aborted) {
        void session.metadata.catch(() => undefined);
        await session.close?.();
        return;
      }
      activeSession = session;
      launchFacts = { model: profile.model, inferenceSettings: profile.inferenceSettings, startedAt: startedAtIso };
      input.onAttemptLaunch?.(launchFacts);

      let seenTerminal = false;
      let outcome: RunnerSessionMetadata['outcome'] = 'succeeded';

      try {
        for await (const rawEvent of session.events) {
          if (closeRequested || input.signal?.aborted) return;
          // Validate the event
          const parsed = runnerEventSchema.safeParse(rawEvent);
          if (!parsed.success) {
            throw new RunnerProtocolError(
              'invalid_event',
              'Adapter produced an invalid event.',
              parsed.error.issues
            );
          }
          const event = parsed.data;

          // Protocol checks
          if (event.type === 'runner_terminal_result') {
            if (seenTerminal) {
              throw new RunnerProtocolError(
                'duplicate_terminal_result',
                'Adapter emitted a duplicate terminal event.'
              );
            }
            seenTerminal = true;
          } else if (seenTerminal) {
            throw new RunnerProtocolError(
              'event_after_terminal',
              'Adapter emitted an event after the terminal event.'
            );
          }

          // Count event types
          if (event.type === 'runner_assistant_turn') {
            assistantTurnCount++;
          } else if (event.type === 'runner_tool_activity' &&
              (input.nativeConversation?.mode !== 'retained' || event.tool.action !== 'result')) {
            toolCallCount++;
          }

          yield event;
        }

        if (!seenTerminal) {
          throw new RunnerProtocolError(
            'missing_terminal_result',
            'Adapter stream ended without emitting a terminal event.'
          );
        }
      } catch (err) {
        outcome = err instanceof ProviderConnectionError && err.code === 'timeout' ? 'timeout'
          : err instanceof Error && err.name === 'AbortError' ? 'cancelled' : 'failed';
        throw err;
      } finally {
        // Resolve metadata (best-effort; don't throw if unavailable)
        let metadata: Awaited<typeof session.metadata> | undefined;
        try {
          metadata = await session.metadata;
        } catch {
          // metadata unavailable
        }

        // Session close is intentionally NOT called here. Closing is delegated
        // entirely to the public close() method so the execution entry point
        // can observe close failures and surface runner_close_failed on clean
        // paths. On error paths the entry point's finally still calls close(),
        // and its catch block suppresses the close error when a stream error is
        // already in flight.

        const endedAtMs = clock();
        const endedAtIso = new Date(endedAtMs).toISOString();
        const durationMs = endedAtMs - startedAt;
        // Local outcome takes priority when stream errored; use session metadata otherwise.
        const resolvedOutcome = input.signal?.aborted ? 'cancelled' : outcome !== 'succeeded' ? outcome : (metadata?.outcome ?? outcome);
        let tokenUsage = metadata?.tokenUsage;
        let accountingFailed = false;
        try {
          tokenUsage = session.getTokenUsage?.() ?? tokenUsage;
        } catch {
          accountingFailed = true;
        }
        const evidence = sessionUsageSchema.safeParse(tokenUsage?.usage);
        if (accountingFailed || (tokenUsage?.usage !== undefined && !evidence.success)) {
          telemetry?.emit('agent_orchestrator_accounting_unavailable',
            { code: 'invalid_usage_evidence', runId: telemetryContext.runId, step: telemetryContext.step });
        }
        telemetry?.emit('agent_orchestrator_session_end', {
          runId: telemetryContext.runId,
          phase: telemetryContext.phase,
          step: telemetryContext.step,
          durationMs,
          outcome: resolvedOutcome,
          launchMechanism: metadata?.launchMechanism,
          assistantTurnCount,
          toolCallCount,
          degradedCapabilities: metadata?.degradedCapabilities ?? [],
          tokenUsage: tokenUsage ?? { available: false }
        });

        // Cache safe session metadata for getSessionMetadata()
        const sessionModel = metadata?.model ?? profile.model;
        const mappedOutcome: RunnerSessionMetadata['outcome'] =
          resolvedOutcome === 'canceled' ? 'cancelled' : resolvedOutcome;
        cachedSessionMetadata = {
          model: sessionModel,
          inferenceSettings: profile.inferenceSettings,
          startedAt: startedAtIso,
          endedAt: endedAtIso,
          outcome: mappedOutcome,
          ...usageFields(tokenUsage),
          assistantTurnCount,
          toolCallCount
        };
      }
    },

    snapshotSessionMetadata(): RunnerSessionMetadata | null {
      if (cachedSessionMetadata) return cachedSessionMetadata;
      if (!launchFacts) return null;
      let tokenUsage: AgentTokenUsage | undefined;
      try { tokenUsage = activeSession?.getTokenUsage?.(); } catch { /* usage unavailable */ }
      return { ...launchFacts, endedAt: null, outcome: 'cancelled', ...usageFields(tokenUsage),
        assistantTurnCount, toolCallCount };
    },

    async getSessionMetadata(): Promise<RunnerSessionMetadata | null> {
      return cachedSessionMetadata;
    },

    async close(): Promise<RunnerCloseResult> {
      closeRequested = true;
      // Propagate close failures so the entry point can surface
      // runner_close_failed on clean-stream paths. The entry point's catch
      // block already suppresses close errors when a stream error is in flight.
      if (!sessionClosed && activeSession?.close !== undefined) {
        sessionClosed = true;
        await activeSession.close!();
      }
      if (!adapterClosed && adapter.close !== undefined) {
        adapterClosed = true;
        await adapter.close!();
      }
      if (!connectionClosed && connection.close !== undefined) {
        connectionClosed = true;
        await connection.close();
      }
      return { status: 'closed' };
    }
  };
}

/** Normalize already-available accounting, keeping missing usage distinct from measured zero. */
function usageFields(tokenUsage: AgentTokenUsage | undefined) {
  const evidence = sessionUsageSchema.safeParse(tokenUsage?.usage);
  const tokens = tokenUsage?.available === true ? tokenUsage.tokens : undefined;
  return {
    ...(evidence.success ? { usage: evidence.data } : {}),
    ...(tokens ? { tokens: {
      input: tokens.input ?? 0, output: tokens.output ?? 0,
      cacheRead: tokens.cacheRead ?? 0, cacheWrite: tokens.cacheWrite ?? 0
    }, usageAvailable: true } : { usageAvailable: tokenUsage?.available ?? false })
  };
}
