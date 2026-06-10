import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createDirectOrchestrator } from './direct-orchestrator.js';
import type { DirectProviderAdapter } from './direct-provider-adapter.js';
import { DirectProviderProtocolError, DirectResultValidationError } from './direct-provider-adapter.js';
import { ProviderConfigurationError, ProviderConnectionError } from './agent-provider-adapter.js';
import type { ResolvedAgentRunnerProfile, AgentConnection, AgentConnectionTelemetryContext } from './agent-provider-adapter.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<ResolvedAgentRunnerProfile> = {}): ResolvedAgentRunnerProfile {
  return {
    mode: 'direct',
    providerKind: 'anthropic',
    adapterId: 'anthropic-direct',
    profileName: 'test-direct',
    model: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'fetch_transport',
    ...overrides
  };
}

function makeAdapter(overrides: Partial<DirectProviderAdapter> = {}): DirectProviderAdapter {
  return {
    providerKind: 'anthropic',
    adapterId: 'anthropic-direct',
    supportedConnectionMechanism: 'fetch_transport',
    call: vi.fn(async () => ({
      candidate: { intent: 'review' },
      metadata: {
        outcome: 'succeeded' as const,
        tokenUsage: { available: true, tokens: { input: 12, output: 4, total: 16 } },
        degradedCapabilities: [],
        purpose: 'intent_classification'
      }
    })),
    ...overrides
  };
}

function makeConnection(): AgentConnection {
  return {
    profile: makeProfile(),
    credentialResolved: true,
    createFetchTransport: vi.fn(),
    createProcessLaunchConfig: vi.fn()
  } as unknown as AgentConnection;
}

function makeTelemetryContext(): AgentConnectionTelemetryContext {
  return { runId: 'run_1', phase: 'main', step: 'classify_intent' };
}

const intentSchema = z.object({ intent: z.string() });

function makeCallRequest(schemaOverride?: z.ZodTypeAny) {
  return {
    purpose: 'intent_classification',
    input: { text: 'please review my code' },
    resultValidation: {
      schemaId: 'intent',
      schema: schemaOverride ?? intentSchema
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDirectOrchestrator', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('calls adapter once and returns validated result', async () => {
      const adapter = makeAdapter();
      const telemetryEmits: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const telemetry = {
        emit: (event: string, fields: Record<string, unknown>) => {
          telemetryEmits.push({ event, fields });
        }
      };

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry
      });

      const result = await orchestrator.call(makeCallRequest());

      expect(adapter.call).toHaveBeenCalledOnce();
      expect(result.value).toEqual({ intent: 'review' });
      expect(result.validation.status).toBe('valid');
      expect(result.metadata.outcome).toBe('succeeded');
    });

    it('emits start and end telemetry on success', async () => {
      const telemetryEmits: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const telemetry = {
        emit: (event: string, fields: Record<string, unknown>) => {
          telemetryEmits.push({ event, fields });
        }
      };

      const orchestrator = createDirectOrchestrator({
        adapter: makeAdapter(),
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry
      });

      await orchestrator.call(makeCallRequest());

      const events = telemetryEmits.map((e) => e.event);
      expect(events).toContain('direct_orchestrator_call_start');
      expect(events).toContain('direct_orchestrator_call_end');

      const startEvent = telemetryEmits.find((e) => e.event === 'direct_orchestrator_call_start')!;
      expect(startEvent.fields.runId).toBe('run_1');
      expect(startEvent.fields.purpose).toBe('intent_classification');
      expect(startEvent.fields.providerKind).toBe('anthropic');

      const endEvent = telemetryEmits.find((e) => e.event === 'direct_orchestrator_call_end')!;
      expect(endEvent.fields.outcome).toBe('succeeded');
      expect(endEvent.fields.runId).toBe('run_1');
    });

    it('includes durationMs in end telemetry', async () => {
      let clockVal = 1000;
      const clock = () => clockVal;
      const telemetryEmits: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const telemetry = {
        emit: (event: string, fields: Record<string, unknown>) => {
          clockVal += 50; // advance clock on each emit call
          telemetryEmits.push({ event, fields });
        }
      };

      const orchestrator = createDirectOrchestrator({
        adapter: makeAdapter(),
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry,
        clock
      });

      await orchestrator.call(makeCallRequest());

      const endEvent = telemetryEmits.find((e) => e.event === 'direct_orchestrator_call_end')!;
      expect(typeof endEvent.fields.durationMs).toBe('number');
    });

    it('calls adapter.close after successful call', async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ close: closeFn });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await orchestrator.call(makeCallRequest());
      expect(closeFn).toHaveBeenCalledOnce();
    });

    it('works when adapter has no close function', async () => {
      const adapter = makeAdapter();
      // Ensure no close property
      const adapterWithoutClose: DirectProviderAdapter = {
        providerKind: adapter.providerKind,
        adapterId: adapter.adapterId,
        supportedConnectionMechanism: adapter.supportedConnectionMechanism,
        call: adapter.call
      };

      const orchestrator = createDirectOrchestrator({
        adapter: adapterWithoutClose,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Preflight failures — adapter.call must NOT be called
  // -------------------------------------------------------------------------

  describe('preflight failures', () => {
    it('throws ProviderConfigurationError when profile mode is agent', async () => {
      const adapter = makeAdapter();
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ mode: 'agent' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow(ProviderConfigurationError);
      expect(adapter.call).not.toHaveBeenCalled();
    });

    it('throws ProviderConfigurationError with mechanism_mismatch code for mode mismatch', async () => {
      const adapter = makeAdapter();
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ mode: 'agent' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      let thrown: ProviderConfigurationError | undefined;
      try {
        await orchestrator.call(makeCallRequest());
      } catch (e) {
        thrown = e as ProviderConfigurationError;
      }

      expect(thrown?.code).toBe('mechanism_mismatch');
    });

    it('throws ProviderConfigurationError when adapter providerKind does not match profile', async () => {
      const adapter = makeAdapter({ providerKind: 'openai' });
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ providerKind: 'anthropic' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow(ProviderConfigurationError);
      expect(adapter.call).not.toHaveBeenCalled();
    });

    it('throws ProviderConfigurationError with mechanism_mismatch code for providerKind mismatch', async () => {
      const adapter = makeAdapter({ providerKind: 'openai' });
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ providerKind: 'anthropic' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      let thrown: ProviderConfigurationError | undefined;
      try {
        await orchestrator.call(makeCallRequest());
      } catch (e) {
        thrown = e as ProviderConfigurationError;
      }
      expect(thrown?.code).toBe('mechanism_mismatch');
    });

    it('throws ProviderConfigurationError when adapterId does not match profile', async () => {
      const adapter = makeAdapter({ adapterId: 'other-adapter' });
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ adapterId: 'anthropic-direct' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow(ProviderConfigurationError);
      expect(adapter.call).not.toHaveBeenCalled();
    });

    it('throws ProviderConfigurationError with unsupported_adapter code for adapterId mismatch', async () => {
      const adapter = makeAdapter({ adapterId: 'other-adapter' });
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ adapterId: 'anthropic-direct' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      let thrown: ProviderConfigurationError | undefined;
      try {
        await orchestrator.call(makeCallRequest());
      } catch (e) {
        thrown = e as ProviderConfigurationError;
      }
      expect(thrown?.code).toBe('unsupported_adapter');
    });

    it('throws ProviderConfigurationError when connection mechanism does not match profile', async () => {
      const adapter = makeAdapter({ supportedConnectionMechanism: 'process_environment' });
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ connectionMechanism: 'fetch_transport' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow(ProviderConfigurationError);
      expect(adapter.call).not.toHaveBeenCalled();
    });

    it('throws ProviderConfigurationError with mechanism_mismatch code for connection mechanism mismatch', async () => {
      const adapter = makeAdapter({ supportedConnectionMechanism: 'process_environment' });
      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile({ connectionMechanism: 'fetch_transport' }),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      let thrown: ProviderConfigurationError | undefined;
      try {
        await orchestrator.call(makeCallRequest());
      } catch (e) {
        thrown = e as ProviderConfigurationError;
      }
      expect(thrown?.code).toBe('mechanism_mismatch');
    });
  });

  // -------------------------------------------------------------------------
  // Protocol failures
  // -------------------------------------------------------------------------

  describe('protocol failures', () => {
    it('throws DirectProviderProtocolError with missing_candidate when candidate is null', async () => {
      const adapter = makeAdapter({
        call: vi.fn().mockResolvedValue({
          candidate: null,
          metadata: { outcome: 'succeeded', tokenUsage: { available: false }, degradedCapabilities: [] }
        })
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow(DirectProviderProtocolError);

      let thrown: DirectProviderProtocolError | undefined;
      try {
        // reset mock to return null again since close was called
        (adapter.call as ReturnType<typeof vi.fn>).mockResolvedValue({
          candidate: null,
          metadata: { outcome: 'succeeded', tokenUsage: { available: false }, degradedCapabilities: [] }
        });
        // Create fresh orchestrator
        const fresh = createDirectOrchestrator({
          adapter,
          profile: makeProfile(),
          connection: makeConnection(),
          telemetryContext: makeTelemetryContext()
        });
        await fresh.call(makeCallRequest());
      } catch (e) {
        thrown = e as DirectProviderProtocolError;
      }
      expect(thrown?.code).toBe('missing_candidate');
    });

    it('throws DirectProviderProtocolError with missing_candidate when candidate is undefined', async () => {
      const adapter = makeAdapter({
        call: vi.fn().mockResolvedValue({
          candidate: undefined,
          metadata: { outcome: 'succeeded', tokenUsage: { available: false }, degradedCapabilities: [] }
        })
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      let thrown: DirectProviderProtocolError | undefined;
      try {
        await orchestrator.call(makeCallRequest());
      } catch (e) {
        thrown = e as DirectProviderProtocolError;
      }
      expect(thrown).toBeInstanceOf(DirectProviderProtocolError);
      expect(thrown?.code).toBe('missing_candidate');
    });

    it('emits failure telemetry on missing_candidate', async () => {
      const telemetryEmits: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const telemetry = { emit: (event: string, fields: Record<string, unknown>) => telemetryEmits.push({ event, fields }) };

      const adapter = makeAdapter({
        call: vi.fn().mockResolvedValue({
          candidate: null,
          metadata: { outcome: 'succeeded', tokenUsage: { available: false }, degradedCapabilities: [] }
        })
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow(DirectProviderProtocolError);

      const endEvent = telemetryEmits.find((e) => e.event === 'direct_orchestrator_call_end')!;
      expect(endEvent?.fields.outcome).toBe('failed');
      expect(endEvent?.fields.safeErrorCode).toBe('missing_candidate');
    });

    it('throws DirectProviderProtocolError with invalid_direct_metadata when outcome is not succeeded', async () => {
      const adapter = makeAdapter({
        call: vi.fn().mockResolvedValue({
          candidate: { intent: 'review' },
          metadata: {
            outcome: 'failed',
            tokenUsage: { available: false },
            degradedCapabilities: []
          }
        })
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      let thrown: DirectProviderProtocolError | undefined;
      try {
        await orchestrator.call(makeCallRequest());
      } catch (e) {
        thrown = e as DirectProviderProtocolError;
      }
      expect(thrown).toBeInstanceOf(DirectProviderProtocolError);
      expect(thrown?.code).toBe('invalid_direct_metadata');
    });
  });

  // -------------------------------------------------------------------------
  // Adapter throws
  // -------------------------------------------------------------------------

  describe('adapter throws', () => {
    it('propagates ProviderConnectionError from adapter.call', async () => {
      const connectionError = new ProviderConnectionError('timeout', 'Request timed out.');
      const adapter = makeAdapter({
        call: vi.fn().mockRejectedValue(connectionError)
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow(ProviderConnectionError);
    });

    it('emits failure telemetry when adapter.call throws', async () => {
      const telemetryEmits: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const telemetry = { emit: (event: string, fields: Record<string, unknown>) => telemetryEmits.push({ event, fields }) };

      const connectionError = new ProviderConnectionError('timeout', 'Request timed out.');
      const adapter = makeAdapter({
        call: vi.fn().mockRejectedValue(connectionError)
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow();

      const endEvent = telemetryEmits.find((e) => e.event === 'direct_orchestrator_call_end')!;
      expect(endEvent?.fields.outcome).toBe('failed');
      expect(endEvent?.fields.safeErrorCode).toBe('timeout');
      expect(endEvent?.fields.safeErrorName).toBe('ProviderConnectionError');
    });

    it('calls adapter.close after adapter.call throws', async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const connectionError = new ProviderConnectionError('timeout', 'Request timed out.');
      const adapter = makeAdapter({
        call: vi.fn().mockRejectedValue(connectionError),
        close: closeFn
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow();
      expect(closeFn).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Validation failure
  // -------------------------------------------------------------------------

  describe('validation failure', () => {
    it('throws DirectResultValidationError when candidate fails schema', async () => {
      const strictSchema = z.object({ intent: z.literal('approve') });
      const adapter = makeAdapter({
        call: vi.fn().mockResolvedValue({
          candidate: { intent: 'review' }, // does not match literal 'approve'
          metadata: {
            outcome: 'succeeded' as const,
            tokenUsage: { available: false },
            degradedCapabilities: []
          }
        })
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(
        orchestrator.call(makeCallRequest(strictSchema))
      ).rejects.toThrow(DirectResultValidationError);
    });

    it('emits failure telemetry on validation failure', async () => {
      const telemetryEmits: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const telemetry = { emit: (event: string, fields: Record<string, unknown>) => telemetryEmits.push({ event, fields }) };

      const strictSchema = z.object({ intent: z.literal('approve') });
      const adapter = makeAdapter({
        call: vi.fn().mockResolvedValue({
          candidate: { intent: 'review' },
          metadata: {
            outcome: 'succeeded' as const,
            tokenUsage: { available: false },
            degradedCapabilities: []
          }
        })
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry
      });

      await expect(orchestrator.call(makeCallRequest(strictSchema))).rejects.toThrow(DirectResultValidationError);

      const endEvent = telemetryEmits.find((e) => e.event === 'direct_orchestrator_call_end')!;
      expect(endEvent?.fields.outcome).toBe('failed');
    });

    it('calls adapter.close after validation failure', async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const strictSchema = z.object({ intent: z.literal('approve') });
      const adapter = makeAdapter({
        call: vi.fn().mockResolvedValue({
          candidate: { intent: 'review' },
          metadata: {
            outcome: 'succeeded' as const,
            tokenUsage: { available: false },
            degradedCapabilities: []
          }
        }),
        close: closeFn
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest(strictSchema))).rejects.toThrow(DirectResultValidationError);
      expect(closeFn).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup — adapter.close idempotency
  // -------------------------------------------------------------------------

  describe('cleanup', () => {
    it('adapter.close is called exactly once on success', async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ close: closeFn });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await orchestrator.call(makeCallRequest());
      expect(closeFn).toHaveBeenCalledOnce();
    });

    it('explicit close() after successful call is a no-op (idempotent)', async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ close: closeFn });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await orchestrator.call(makeCallRequest());
      await orchestrator.close();
      await orchestrator.close();

      // Should have been called only once (during call, not again on explicit close)
      expect(closeFn).toHaveBeenCalledOnce();
    });

    it('adapter.close is called exactly once on adapter.call failure', async () => {
      const closeFn = vi.fn().mockResolvedValue(undefined);
      const connectionError = new ProviderConnectionError('timeout', 'Request timed out.');
      const adapter = makeAdapter({
        call: vi.fn().mockRejectedValue(connectionError),
        close: closeFn
      });

      const orchestrator = createDirectOrchestrator({
        adapter,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await expect(orchestrator.call(makeCallRequest())).rejects.toThrow();
      // Should not double-close even if explicit close is called
      await orchestrator.close();
      expect(closeFn).toHaveBeenCalledOnce();
    });

    it('close() is safe to call multiple times with no adapter.close', async () => {
      const adapter = makeAdapter();
      const adapterWithoutClose: DirectProviderAdapter = {
        providerKind: adapter.providerKind,
        adapterId: adapter.adapterId,
        supportedConnectionMechanism: adapter.supportedConnectionMechanism,
        call: adapter.call
      };

      const orchestrator = createDirectOrchestrator({
        adapter: adapterWithoutClose,
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext()
      });

      await orchestrator.close();
      await orchestrator.close();
      // No error expected
    });
  });

  // -------------------------------------------------------------------------
  // Redaction — telemetry must not include sensitive values
  // -------------------------------------------------------------------------

  describe('redaction', () => {
    it('telemetry does not include raw API keys or credentials', async () => {
      const emittedFields: string[] = [];
      const telemetry = {
        emit: (_event: string, fields: Record<string, unknown>) => {
          emittedFields.push(JSON.stringify(fields));
        }
      };

      // Simulate a scenario where the profile might contain sensitive info
      const profileWithSensitiveEndpoint = makeProfile({
        endpoint: { baseUrl: 'https://api.anthropic.com', headers: {} }
      });

      const orchestrator = createDirectOrchestrator({
        adapter: makeAdapter(),
        profile: profileWithSensitiveEndpoint,
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry
      });

      await orchestrator.call(makeCallRequest());

      const allEmitted = emittedFields.join('\n');
      expect(allEmitted).not.toContain('sk-test-secret');
      expect(allEmitted).not.toContain('Authorization');
    });

    it('start telemetry does not include call.input (raw prompt)', async () => {
      const emittedEvents: Array<{ event: string; fields: Record<string, unknown> }> = [];
      const telemetry = {
        emit: (event: string, fields: Record<string, unknown>) => {
          emittedEvents.push({ event, fields });
        }
      };

      const orchestrator = createDirectOrchestrator({
        adapter: makeAdapter(),
        profile: makeProfile(),
        connection: makeConnection(),
        telemetryContext: makeTelemetryContext(),
        telemetry
      });

      const callReq = {
        purpose: 'intent_classification',
        input: { sensitivePromptText: 'sk-test-secret user data' },
        resultValidation: {
          schemaId: 'intent',
          schema: intentSchema
        }
      };

      await orchestrator.call(callReq);

      const startEvent = emittedEvents.find((e) => e.event === 'direct_orchestrator_call_start')!;
      const serialized = JSON.stringify(startEvent.fields);
      expect(serialized).not.toContain('sensitivePromptText');
      expect(serialized).not.toContain('sk-test-secret user data');
    });
  });
});
