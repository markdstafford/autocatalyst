import { runnerEventSchema, type RunnerEvent } from '@autocatalyst/api-contract';

import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentProviderAdapter,
  AgentProviderSession,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import { ProviderConfigurationError } from './agent-provider-adapter.js';
import type { Runner, RunnerCloseResult, RunnerRunInput } from './runner.js';
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
  let sessionClosed = false;
  let adapterClosed = false;

  return {
    async *run(input: RunnerRunInput): AsyncIterable<RunnerEvent> {
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

      const startedAt = clock();

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
        inferenceSettings: profile.inferenceSettings
      });

      // Start session
      const session = await adapter.startSession({
        runInput: input,
        profile,
        connection,
        telemetryContext
      });
      activeSession = session;

      let seenTerminal = false;
      let assistantTurnCount = 0;
      let toolCallCount = 0;
      let outcome: 'succeeded' | 'failed' = 'succeeded';

      try {
        for await (const rawEvent of session.events) {
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
          } else if (event.type === 'runner_tool_activity') {
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
        outcome = 'failed';
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

        const durationMs = clock() - startedAt;
        telemetry?.emit('agent_orchestrator_session_end', {
          runId: telemetryContext.runId,
          phase: telemetryContext.phase,
          step: telemetryContext.step,
          durationMs,
          outcome: metadata?.outcome ?? outcome,
          launchMechanism: metadata?.launchMechanism,
          assistantTurnCount,
          toolCallCount,
          degradedCapabilities: metadata?.degradedCapabilities ?? [],
          tokenUsage: metadata?.tokenUsage ?? { available: false }
        });
      }
    },

    async close(): Promise<RunnerCloseResult> {
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
      return { status: 'closed' };
    }
  };
}
