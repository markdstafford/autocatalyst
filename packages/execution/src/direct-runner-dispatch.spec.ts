import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import { ProviderConfigurationError } from './agent-provider-adapter.js';
import type { DirectProviderAdapter } from './direct-provider-adapter.js';
import type {
  DirectCallFactoryInput,
  DirectProfileResolution,
  CreateDirectCallFactoryOptions
} from './direct-runner-dispatch.js';
import {
  getDirectProviderAdapterKey,
  createDirectProviderAdapterRegistry,
  createDirectCallFactory
} from './direct-runner-dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
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

function makeFakeDirectAdapter(overrides: Partial<DirectProviderAdapter> = {}): DirectProviderAdapter {
  return {
    providerKind: 'anthropic',
    adapterId: 'anthropic-direct',
    supportedConnectionMechanism: 'fetch_transport',
    call: vi.fn(async () => ({
      candidate: { intent: 'review' },
      metadata: {
        outcome: 'succeeded' as const,
        tokenUsage: { available: false },
        degradedCapabilities: []
      }
    })),
    ...overrides
  };
}

function makeConnection(profile: ResolvedAgentRunnerProfile): AgentConnection {
  return {
    profile,
    credentialResolved: true,
    createFetchTransport() {
      return { fetch: vi.fn().mockResolvedValue(new Response()) };
    },
    createProcessLaunchConfig(_input: unknown) {
      return {
        environment: {},
        secretVariableNames: [],
        degradedCapabilities: [],
        redacted: {}
      };
    }
  } as unknown as AgentConnection;
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

function makeFactoryInput(overrides: Partial<DirectCallFactoryInput> = {}): DirectCallFactoryInput {
  return {
    runId: 'run_test_1',
    tenant: 'tenant_1',
    phase: 'execute',
    step: 'classify',
    directCall: makeCallRequest(),
    ...overrides
  };
}

function makeProfileResolution(profileOverrides: Partial<ResolvedAgentRunnerProfile> = {}): DirectProfileResolution {
  const profile = makeProfile(profileOverrides);
  return {
    profile,
    credentialReference: { required: false }
  };
}

function makeDefaultOptions(
  adapterOverrides: Partial<DirectProviderAdapter> = {},
  profileOverrides: Partial<ResolvedAgentRunnerProfile> = {}
): CreateDirectCallFactoryOptions {
  const adapter = makeFakeDirectAdapter(adapterOverrides);
  const resolution = makeProfileResolution(profileOverrides);

  const adapters: DirectProviderAdapter[] = [adapter];

  return {
    adapters,
    resolveProfile: vi.fn().mockResolvedValue(resolution),
    createConnection: vi.fn().mockResolvedValue(makeConnection(resolution.profile))
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDirectProviderAdapterKey', () => {
  it('returns JSON.stringify([providerKind, adapterId])', () => {
    expect(getDirectProviderAdapterKey('anthropic', 'anthropic-direct')).toBe(
      JSON.stringify(['anthropic', 'anthropic-direct'])
    );
  });

  it('produces different keys for different pairs', () => {
    const k1 = getDirectProviderAdapterKey('anthropic', 'anthropic-direct');
    const k2 = getDirectProviderAdapterKey('openai', 'anthropic-direct');
    const k3 = getDirectProviderAdapterKey('anthropic', 'openai-direct');
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });
});

describe('createDirectProviderAdapterRegistry', () => {
  it('creates a registry with one adapter', () => {
    const adapter = makeFakeDirectAdapter();
    const registry = createDirectProviderAdapterRegistry([adapter]);
    const key = getDirectProviderAdapterKey(adapter.providerKind, adapter.adapterId);
    expect(registry.get(key)).toBe(adapter);
  });

  it('throws ProviderConfigurationError(duplicate_adapter) for duplicate adapters', () => {
    const adapter1 = makeFakeDirectAdapter();
    const adapter2 = makeFakeDirectAdapter(); // same providerKind and adapterId
    expect(() => createDirectProviderAdapterRegistry([adapter1, adapter2])).toThrow(ProviderConfigurationError);
    expect(() => createDirectProviderAdapterRegistry([adapter1, adapter2])).toThrowError(
      expect.objectContaining({ code: 'duplicate_adapter' })
    );
  });

  it('allows adapters with different keys', () => {
    const adapter1 = makeFakeDirectAdapter({ adapterId: 'adapter-a' });
    const adapter2 = makeFakeDirectAdapter({ adapterId: 'adapter-b' });
    const registry = createDirectProviderAdapterRegistry([adapter1, adapter2]);
    expect(registry.size).toBe(2);
  });
});

describe('createDirectCallFactory', () => {
  describe('happy path', () => {
    it('calls fake adapter through factory and returns validated result', async () => {
      const options = makeDefaultOptions();
      const factory = createDirectCallFactory(options);
      const input = makeFactoryInput();

      const result = await factory.call(input);

      expect(result.value).toEqual({ intent: 'review' });
      expect(result.validation.status).toBe('valid');
      expect(result.metadata.outcome).toBe('succeeded');
    });

    it('calls resolveProfile and createConnection', async () => {
      const options = makeDefaultOptions();
      const factory = createDirectCallFactory(options);
      await factory.call(makeFactoryInput());

      expect(options.resolveProfile).toHaveBeenCalledOnce();
      expect(options.createConnection).toHaveBeenCalledOnce();
    });

    it('passes a ReadonlyMap directly as registry without re-wrapping', async () => {
      const adapter = makeFakeDirectAdapter();
      const resolution = makeProfileResolution();
      const registryMap = new Map([
        [getDirectProviderAdapterKey(adapter.providerKind, adapter.adapterId), adapter]
      ]);

      const options: CreateDirectCallFactoryOptions = {
        adapters: registryMap,
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockResolvedValue(makeConnection(resolution.profile))
      };

      const factory = createDirectCallFactory(options);
      const result = await factory.call(makeFactoryInput());
      expect(result.value).toEqual({ intent: 'review' });
    });
  });

  describe('error: missing adapter', () => {
    it('throws ProviderConfigurationError(unsupported_adapter) when no adapter registered', async () => {
      const profile = makeProfile({ providerKind: 'unknown', adapterId: 'not-registered' });
      const resolution: DirectProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      const options: CreateDirectCallFactoryOptions = {
        adapters: [], // empty — no adapters
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn()
      };

      const factory = createDirectCallFactory(options);
      await expect(factory.call(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.call(makeFactoryInput())).rejects.toMatchObject({
        code: 'unsupported_adapter'
      });
    });
  });

  describe('error: profile mode mismatch', () => {
    it('throws ProviderConfigurationError(mechanism_mismatch) when profile mode is agent', async () => {
      const options = makeDefaultOptions({}, { mode: 'agent' });
      const factory = createDirectCallFactory(options);
      await expect(factory.call(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.call(makeFactoryInput())).rejects.toMatchObject({
        code: 'mechanism_mismatch'
      });
    });
  });

  describe('error: provider mismatch (caught in orchestrator preflight)', () => {
    it('throws ProviderConfigurationError when adapter providerKind does not match profile providerKind', async () => {
      // Profile says 'anthropic' but adapter claims 'openai' — registered under the anthropic key
      // so the registry lookup succeeds, but orchestrator preflight catches the mismatch
      const adapterWithWrongProvider = makeFakeDirectAdapter({ providerKind: 'openai' });
      const profile = makeProfile({ providerKind: 'anthropic', adapterId: 'anthropic-direct' });
      const resolution: DirectProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      // Register the adapter under the profile's key (anthropic/anthropic-direct) so lookup succeeds
      const registryMap = new Map([
        [getDirectProviderAdapterKey('anthropic', 'anthropic-direct'), adapterWithWrongProvider]
      ]);

      const options: CreateDirectCallFactoryOptions = {
        adapters: registryMap,
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockResolvedValue(makeConnection(profile))
      };

      const factory = createDirectCallFactory(options);
      // The orchestrator preflight catches providerKind mismatch
      await expect(factory.call(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.call(makeFactoryInput())).rejects.toMatchObject({
        code: 'mechanism_mismatch'
      });
    });
  });

  describe('error: mechanism mismatch (caught in orchestrator preflight)', () => {
    it('throws ProviderConfigurationError when connectionMechanism does not match adapter', async () => {
      const adapter = makeFakeDirectAdapter({ supportedConnectionMechanism: 'process_environment' });
      const profile = makeProfile({ connectionMechanism: 'fetch_transport' });
      const resolution: DirectProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      const registryMap = new Map([
        [getDirectProviderAdapterKey(profile.providerKind, profile.adapterId), adapter]
      ]);

      const options: CreateDirectCallFactoryOptions = {
        adapters: registryMap,
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockResolvedValue(makeConnection(profile))
      };

      const factory = createDirectCallFactory(options);
      await expect(factory.call(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.call(makeFactoryInput())).rejects.toMatchObject({
        code: 'mechanism_mismatch'
      });
    });
  });

  describe('telemetry context', () => {
    it('default telemetry context does NOT have role field for direct calls', async () => {
      const adapter = makeFakeDirectAdapter();
      const profile = makeProfile();
      const resolution: DirectProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      let capturedTelemetryContext: AgentConnectionTelemetryContext | undefined;

      const options: CreateDirectCallFactoryOptions = {
        adapters: [adapter],
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockImplementation(
          (args: DirectProfileResolution & { telemetryContext: AgentConnectionTelemetryContext }) => {
            capturedTelemetryContext = args.telemetryContext;
            return Promise.resolve(makeConnection(profile));
          }
        )
      };

      const factory = createDirectCallFactory(options);
      await factory.call(makeFactoryInput({ runId: 'run_xyz', phase: 'build', step: 'test_step' }));

      expect(capturedTelemetryContext).toBeDefined();
      expect('role' in capturedTelemetryContext!).toBe(false);
    });

    it('default telemetry context includes runId, phase, and step', async () => {
      const adapter = makeFakeDirectAdapter();
      const profile = makeProfile();
      const resolution: DirectProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      let capturedTelemetryContext: AgentConnectionTelemetryContext | undefined;

      const options: CreateDirectCallFactoryOptions = {
        adapters: [adapter],
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockImplementation(
          (args: DirectProfileResolution & { telemetryContext: AgentConnectionTelemetryContext }) => {
            capturedTelemetryContext = args.telemetryContext;
            return Promise.resolve(makeConnection(profile));
          }
        )
      };

      const factory = createDirectCallFactory(options);
      await factory.call(makeFactoryInput({ runId: 'run_xyz', phase: 'build', step: 'test_step' }));

      expect(capturedTelemetryContext!.runId).toBe('run_xyz');
      expect(capturedTelemetryContext!.phase).toBe('build');
      expect(capturedTelemetryContext!.step).toBe('test_step');
    });

    it('uses custom telemetryContext function when provided', async () => {
      const adapter = makeFakeDirectAdapter();
      const profile = makeProfile();
      const resolution: DirectProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      const customCtx: AgentConnectionTelemetryContext = {
        runId: 'custom_run',
        step: 'custom_step'
      };

      let capturedTelemetryContext: AgentConnectionTelemetryContext | undefined;

      const options: CreateDirectCallFactoryOptions = {
        adapters: [adapter],
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockImplementation(
          (args: DirectProfileResolution & { telemetryContext: AgentConnectionTelemetryContext }) => {
            capturedTelemetryContext = args.telemetryContext;
            return Promise.resolve(makeConnection(profile));
          }
        ),
        telemetryContext: vi.fn().mockReturnValue(customCtx)
      };

      const factory = createDirectCallFactory(options);
      await factory.call(makeFactoryInput());

      expect(capturedTelemetryContext).toBe(customCtx);
    });
  });
});
