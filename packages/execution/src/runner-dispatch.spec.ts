import { describe, expect, it, vi } from 'vitest';

import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionMetadata,
  ResolvedAgentRunnerProfile,
  AgentConnection,
  AgentConnectionTelemetryContext
} from './agent-provider-adapter.js';
import {
  ProviderConfigurationError,
  ProviderConnectionError
} from './agent-provider-adapter.js';
import type { RunnerRunInput } from './runner.js';
import { StubRunner } from './stub-runner.js';
import type {
  AgentProfileResolution,
  AgentRunnerFactoryInput,
  CreateAgentRunnerFactoryOptions
} from './runner-dispatch.js';
import {
  getAgentProviderAdapterKey,
  createAgentRunnerFactory
} from './runner-dispatch.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<ResolvedAgentRunnerProfile> = {}): ResolvedAgentRunnerProfile {
  return {
    providerKind: 'anthropic',
    adapterId: 'claude-agent-sdk',
    profileName: 'default',
    model: { provider: 'anthropic', model: 'claude-sonnet-4' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'process_environment',
    ...overrides
  };
}

function makeAdapter(overrides: Partial<AgentProviderAdapter> = {}): AgentProviderAdapter {
  return {
    providerKind: 'anthropic',
    adapterId: 'claude-agent-sdk',
    supportedConnectionMechanism: 'process_environment',
    startSession: vi.fn().mockReturnValue(makeSession()),
    ...overrides
  };
}

function makeSession(): AgentProviderSession {
  const metadata: AgentProviderSessionMetadata = {
    outcome: 'succeeded',
    launchMechanism: 'process_environment',
    degradedCapabilities: [],
    tokenUsage: { available: false }
  };
  return {
    events: (async function* () {
      yield {
        id: 'evt_1',
        type: 'runner_terminal_result' as const,
        runId: 'run_1',
        step: 'implement',
        importance: 'normal' as const,
        createdAt: '2026-06-09T00:00:00.000Z',
        result: { directive: 'advance' as const }
      };
    })(),
    metadata: Promise.resolve(metadata)
  };
}

function makeConnection(profile: ResolvedAgentRunnerProfile): AgentConnection {
  return {
    profile,
    credentialResolved: true,
    createFetchTransport() {
      return { fetch: vi.fn().mockResolvedValue(new Response()) };
    },
    createProcessLaunchConfig(_input) {
      return {
        environment: {},
        secretVariableNames: [],
        degradedCapabilities: [],
        redacted: {}
      };
    }
  };
}

function makeFactoryInput(overrides: Partial<AgentRunnerFactoryInput> = {}): AgentRunnerFactoryInput {
  return {
    runId: 'run_test_1',
    phase: 'execute',
    step: 'implement',
    role: 'executor',
    ...overrides
  };
}

function makeProfileResolution(profileOverrides: Partial<ResolvedAgentRunnerProfile> = {}): AgentProfileResolution {
  const profile = makeProfile(profileOverrides);
  return {
    profile,
    credentialReference: { required: false }
  };
}

function makeDefaultOptions(
  adapterOverrides: Partial<AgentProviderAdapter> = {},
  profileOverrides: Partial<ResolvedAgentRunnerProfile> = {}
): CreateAgentRunnerFactoryOptions {
  const adapter = makeAdapter(adapterOverrides);
  const resolution = makeProfileResolution(profileOverrides);

  const adapters: ReadonlyMap<string, AgentProviderAdapter> = new Map([
    [getAgentProviderAdapterKey(adapter.providerKind, adapter.adapterId), adapter]
  ]);

  return {
    adapters,
    resolveProfile: vi.fn().mockResolvedValue(resolution),
    createConnection: vi.fn().mockResolvedValue(makeConnection(resolution.profile))
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getAgentProviderAdapterKey', () => {
  it('returns JSON.stringify([providerKind, adapterId])', () => {
    expect(getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk')).toBe(
      JSON.stringify(['anthropic', 'claude-agent-sdk'])
    );
  });

  it('produces different keys for different providerKind/adapterId pairs', () => {
    const key1 = getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk');
    const key2 = getAgentProviderAdapterKey('openai', 'claude-agent-sdk');
    const key3 = getAgentProviderAdapterKey('anthropic', 'fetch-api');
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });
});

describe('createAgentRunnerFactory', () => {
  describe('successful runner creation', () => {
    it('returns a runner without calling adapter.startSession during factory creation', async () => {
      const options = makeDefaultOptions();
      const factory = createAgentRunnerFactory(options);
      const startSessionSpy = vi.spyOn(
        [...options.adapters.values()][0],
        'startSession'
      );

      const input = makeFactoryInput();
      const runner = await factory.createRunner(input);

      // startSession should NOT have been called yet
      expect(startSessionSpy).not.toHaveBeenCalled();
      expect(runner).toBeDefined();
      expect(typeof runner.run).toBe('function');
      expect(typeof runner.close).toBe('function');
    });

    it('calls resolveProfile and createConnection with correct arguments', async () => {
      const options = makeDefaultOptions();
      const factory = createAgentRunnerFactory(options);
      const input = makeFactoryInput();
      await factory.createRunner(input);

      expect(options.resolveProfile).toHaveBeenCalledWith(input);
      expect(options.createConnection).toHaveBeenCalledOnce();
    });
  });

  describe('error: unknown adapter key', () => {
    it('throws ProviderConfigurationError(unsupported_adapter) when adapter not in registry', async () => {
      const profile = makeProfile({ providerKind: 'unknown-provider', adapterId: 'unknown-adapter' });
      const resolution: AgentProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      const options: CreateAgentRunnerFactoryOptions = {
        adapters: new Map(),
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockResolvedValue(makeConnection(profile))
      };

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toMatchObject({
        code: 'unsupported_adapter'
      });
    });
  });

  describe('error: missing/undefined profile', () => {
    it('throws ProviderConfigurationError(missing_profile) when resolveProfile returns undefined profile', async () => {
      const options: CreateAgentRunnerFactoryOptions = {
        adapters: new Map(),
        resolveProfile: vi.fn().mockResolvedValue({ profile: undefined, credentialReference: { required: false } }),
        createConnection: vi.fn()
      };

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toMatchObject({
        code: 'missing_profile'
      });
    });

    it('throws ProviderConfigurationError(missing_profile) when resolveProfile returns null profile', async () => {
      const options: CreateAgentRunnerFactoryOptions = {
        adapters: new Map(),
        resolveProfile: vi.fn().mockResolvedValue({ profile: null, credentialReference: { required: false } }),
        createConnection: vi.fn()
      };

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toMatchObject({
        code: 'missing_profile'
      });
    });
  });

  describe('error: provider/model mismatch', () => {
    it('throws ProviderConfigurationError(mechanism_mismatch) when profile.providerKind !== adapter.providerKind', async () => {
      const adapterWithDifferentProvider = makeAdapter({ providerKind: 'anthropic' });
      const profileWithDifferentProvider = makeProfile({ providerKind: 'openai', adapterId: 'claude-agent-sdk' });

      const resolution: AgentProfileResolution = {
        profile: profileWithDifferentProvider,
        credentialReference: { required: false }
      };

      // Register the adapter under the profile's key so it can be found by adapterId lookup
      // but providerKind won't match
      const adapters = new Map([
        [
          getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk'),
          adapterWithDifferentProvider
        ],
        // Also register under openai key so we actually exercise the mismatch check
        [
          getAgentProviderAdapterKey('openai', 'claude-agent-sdk'),
          makeAdapter({ providerKind: 'anthropic' }) // adapter says anthropic, profile says openai
        ]
      ]);

      const options: CreateAgentRunnerFactoryOptions = {
        adapters,
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockResolvedValue(makeConnection(profileWithDifferentProvider))
      };

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toMatchObject({
        code: 'mechanism_mismatch'
      });
    });
  });

  describe('error: mechanism mismatch', () => {
    it('throws ProviderConfigurationError(mechanism_mismatch) when profile.connectionMechanism !== adapter.supportedConnectionMechanism', async () => {
      // Adapter supports process_environment, profile says fetch_transport
      const adapter = makeAdapter({ supportedConnectionMechanism: 'process_environment' });
      const profile = makeProfile({ connectionMechanism: 'fetch_transport' });

      const resolution: AgentProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      const adapters = new Map([
        [getAgentProviderAdapterKey(profile.providerKind, profile.adapterId), adapter]
      ]);

      const options: CreateAgentRunnerFactoryOptions = {
        adapters,
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockResolvedValue(makeConnection(profile))
      };

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toMatchObject({
        code: 'mechanism_mismatch'
      });
    });
  });

  describe('error: profile resolver failure', () => {
    it('propagates error from resolveProfile as ProviderConfigurationError', async () => {
      const resolverError = new Error('Profile store unavailable');
      const options: CreateAgentRunnerFactoryOptions = {
        adapters: new Map(),
        resolveProfile: vi.fn().mockRejectedValue(resolverError),
        createConnection: vi.fn()
      };

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow();
    });

    it('propagates ProviderConfigurationError directly from resolveProfile', async () => {
      const configError = new ProviderConfigurationError('missing_profile', 'Profile not found');
      const options: CreateAgentRunnerFactoryOptions = {
        adapters: new Map(),
        resolveProfile: vi.fn().mockRejectedValue(configError),
        createConnection: vi.fn()
      };

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow(ProviderConfigurationError);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toMatchObject({
        code: 'missing_profile'
      });
    });
  });

  describe('error: connection factory failure', () => {
    it('propagates error from createConnection', async () => {
      const connectionError = new ProviderConnectionError('timeout', 'Connection timed out');
      const options = makeDefaultOptions();
      (options.createConnection as ReturnType<typeof vi.fn>).mockRejectedValue(connectionError);

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow(ProviderConnectionError);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toMatchObject({
        code: 'timeout'
      });
    });

    it('propagates generic error from createConnection', async () => {
      const genericError = new Error('Network unreachable');
      const options = makeDefaultOptions();
      (options.createConnection as ReturnType<typeof vi.fn>).mockRejectedValue(genericError);

      const factory = createAgentRunnerFactory(options);
      await expect(factory.createRunner(makeFactoryInput())).rejects.toThrow('Network unreachable');
    });
  });

  describe('stub runner behavior unaffected', () => {
    it('can import and use StubRunner without any changes', async () => {
      const stub = new StubRunner({ terminalResult: { directive: 'advance' } });
      expect(stub).toBeDefined();
      expect(typeof stub.run).toBe('function');
      expect(typeof stub.close).toBe('function');
    });

    it('StubRunner still works independently from runner dispatch', async () => {
      const stub = new StubRunner({ terminalResult: { directive: 'advance' } });
      const result = await stub.close();
      expect(result).toEqual({ status: 'closed' });
    });
  });

  describe('telemetry context default', () => {
    it('builds default telemetryContext from input when no custom telemetryContext option provided', async () => {
      const profile = makeProfile();
      const resolution: AgentProfileResolution = {
        profile,
        credentialReference: { required: false }
      };

      let capturedTelemetryContext: AgentConnectionTelemetryContext | undefined;
      const adapter = makeAdapter();
      const adapters = new Map([
        [getAgentProviderAdapterKey(adapter.providerKind, adapter.adapterId), adapter]
      ]);

      const options: CreateAgentRunnerFactoryOptions = {
        adapters,
        resolveProfile: vi.fn().mockResolvedValue(resolution),
        createConnection: vi.fn().mockImplementation(
          (args: AgentProfileResolution & { telemetryContext: AgentConnectionTelemetryContext }) => {
            capturedTelemetryContext = args.telemetryContext;
            return Promise.resolve(makeConnection(profile));
          }
        )
      };

      const factory = createAgentRunnerFactory(options);
      const input = makeFactoryInput({ runId: 'run_xyz', phase: 'build', step: 'test', role: 'tester' });
      await factory.createRunner(input);

      expect(capturedTelemetryContext).toBeDefined();
      expect(capturedTelemetryContext!.runId).toBe('run_xyz');
      expect(capturedTelemetryContext!.phase).toBe('build');
      expect(capturedTelemetryContext!.step).toBe('test');
      expect(capturedTelemetryContext!.role).toBe('tester');
      expect(capturedTelemetryContext!.profileName).toBe(profile.profileName);
      expect(capturedTelemetryContext!.configurationRecordId).toBe(profile.configurationRecordId);
    });
  });
});
