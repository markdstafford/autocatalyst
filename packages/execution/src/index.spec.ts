import { describe, expect, it } from 'vitest';

import type {
  AgentProviderAdapter,
  AgentProviderSession
} from './index.js';
import {
  WorkspaceProvisioningError,
  WorkspacePruneError,
  WorkspaceTeardownError,
  RunnerProtocolError,
  executionPackageName,
  provisionWorkspace,
  pruneWorkspacePath,
  redactWorkspaceDiagnostic,
  summarizeWorkspaceCause,
  teardownWorkspace,
  ProviderAlterationError,
  applyRequestAlteration,
  buildClaudeProcessLaunchEnvironment,
  claudeProviderOwnedEnvironmentVariables,
  defaultMaxRetries,
  defaultRequestTimeoutMs,
  isTransientProviderFailure,
  maximumMaxRetries,
  maximumRequestTimeoutMs,
  redactProcessLaunchConfigForLog,
  redactProviderRequestForLog,
  redactProviderResponseForLog,
  validateHttpHeaderName,
  type PruneWorkspacePathRequest,
  type TeardownWorkspaceRequest,
  type WorkspaceErrorCauseSummary,
  type WorkspacePruneResult,
  type WorkspacePruneStatus,
  type WorkspaceTeardownResult,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult,
  type Runner,
  type RunnerRunInput,
  type AlteredProviderRequest,
  type ClaudeProcessLaunchInput,
  type ClaudeProcessLaunchResult,
  type ProviderCapabilityDegradation,
  type ProviderRequest,
  type RequestAlterationOptions,
  type RetryPolicy,
  type RedactProviderRequestInput,
  type RedactProviderResponseInput,
  type RedactProcessLaunchConfigInput
} from './index.js';

describe('execution scaffold', () => {
  it('exposes the streaming Runner boundary', async () => {
    const runner: Runner = {
      async *run(_input: RunnerRunInput) {
        yield {
          id: 'evt_1',
          type: 'runner_terminal_result' as const,
          runId: 'run_1',
          step: 'implement',
          importance: 'normal' as const,
          createdAt: '2026-06-09T00:00:00.000Z',
          result: { directive: 'advance' as const }
        };
      },
      async close() { return { status: 'closed' as const }; }
    };
    expect(runner.run).toBeTypeOf('function');
    expect(runner.close).toBeTypeOf('function');
    expect(new RunnerProtocolError('missing_terminal_result', 'Missing terminal result.').code).toBe('missing_terminal_result');
    expect(executionPackageName).toBe('@autocatalyst/execution');
  });

  it('exposes the public workspace provisioning API without exposing internals', () => {
    const request = {} as ProvisionWorkspaceRequest;
    const result = { shape: 'none', runId: 'run_123' } satisfies ProvisionWorkspaceResult;

    expect(request).toBeDefined();
    expect(result).toEqual({ shape: 'none', runId: 'run_123' });
    expect(provisionWorkspace).toEqual(expect.any(Function));
    expect(new WorkspaceProvisioningError('unsupported_run_kind', 'unsupported run kind')).toMatchObject({
      code: 'unsupported_run_kind',
      message: 'unsupported run kind'
    });
  });
});

describe('workspace lifecycle API', () => {
  it('exports shared workspace diagnostics through the public entrypoint', () => {
    const summary: WorkspaceErrorCauseSummary = summarizeWorkspaceCause(
      new Error('https://user:secret@example.com failed')
    );
    expect(redactWorkspaceDiagnostic(summary.message)).toBe('https://[redacted]@example.com failed');
    expect(new WorkspaceProvisioningError('invalid_run_id', 'bad run id')).toMatchObject({
      name: 'WorkspaceProvisioningError',
      code: 'invalid_run_id'
    });
  });

  it('exports workspace prune public API', () => {
    const status: WorkspacePruneStatus = 'skipped';
    const request: PruneWorkspacePathRequest = {
      runId: 'run_123',
      mode: 'directory',
      workspaceRoot: '/tmp/workspaces',
      targetPath: '/tmp/workspaces/acme/widgets/run_123'
    };
    const result: WorkspacePruneResult = {
      runId: request.runId,
      mode: request.mode,
      status,
      root: request.workspaceRoot,
      targetPath: request.targetPath,
      durationMs: 0
    };
    expect(pruneWorkspacePath).toBeTypeOf('function');
    expect(new WorkspacePruneError('unsupported_prune_mode', 'bad mode')).toMatchObject({
      name: 'WorkspacePruneError',
      code: 'unsupported_prune_mode'
    });
    expect(result.status).toBe('skipped');
  });

  it('exports workspace teardown public API', () => {
    const request: TeardownWorkspaceRequest = {
      runId: 'run_123',
      runKind: 'feature',
      terminalStep: 'done',
      workspaceRoot: '/tmp/workspaces',
      runRoot: '/tmp/workspaces/acme/widgets/run_123',
      repoRoot: '/tmp/workspaces/acme/widgets/run_123/repo',
      scratchRoot: '/tmp/workspaces/acme/widgets/run_123/scratch',
      hostRepositoryPath: '/tmp/repos/acme/widgets',
      branchName: 'feature/example-Abc123'
    };
    const result: WorkspaceTeardownResult = {
      runId: request.runId,
      runKind: request.runKind,
      terminalStep: request.terminalStep,
      outcome: 'skipped',
      prunes: []
    };
    expect(teardownWorkspace).toBeTypeOf('function');
    expect(new WorkspaceTeardownError('invalid_terminal_step', 'bad step')).toMatchObject({
      name: 'WorkspaceTeardownError',
      code: 'invalid_terminal_step'
    });
    expect(result.outcome).toBe('skipped');
  });
});

describe('agent provider adapter public contracts', () => {
  it('exports ResolvedAgentRunnerProfile and ResolvedAgentCredentialReference types', async () => {
    const {
      ProviderConfigurationError,
      ProviderConnectionError,
      ProviderProtocolError,
      UnsupportedProviderCapabilityError
    } = await import('./index.js');

    const profile: import('./index.js').ResolvedAgentRunnerProfile = {
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      profileName: 'default',
      model: { provider: 'anthropic', model: 'claude-sonnet-4' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'process_environment'
    };
    expect(profile.providerKind).toBe('anthropic');
    expect(profile.adapterId).toBe('claude-agent-sdk');
    expect(profile.connectionMechanism).toBe('process_environment');

    const cred: import('./index.js').ResolvedAgentCredentialReference = {
      required: true,
      secretHandle: 'sec_test',
      authTarget: 'process_environment'
    };
    expect(cred.required).toBe(true);
    expect(cred.secretHandle).toBe('sec_test');

    const configErr = new ProviderConfigurationError('missing_profile', 'profile not found');
    expect(configErr).toBeInstanceOf(ProviderConfigurationError);
    expect(configErr.code).toBe('missing_profile');
    expect(configErr.name).toBe('ProviderConfigurationError');

    const connErr = new ProviderConnectionError('timeout', 'timed out', { durationMs: 60000 });
    expect(connErr).toBeInstanceOf(ProviderConnectionError);
    expect(connErr.code).toBe('timeout');
    expect(connErr.name).toBe('ProviderConnectionError');
    expect(connErr.safeDetails).toEqual({ durationMs: 60000 });

    const protoErr = new ProviderProtocolError('invalid_provider_event', 'bad event');
    expect(protoErr).toBeInstanceOf(ProviderProtocolError);
    expect(protoErr.code).toBe('invalid_provider_event');
    expect(protoErr.name).toBe('ProviderProtocolError');

    const capErr = new UnsupportedProviderCapabilityError('tool_policy_unsupported', 'not supported');
    expect(capErr).toBeInstanceOf(UnsupportedProviderCapabilityError);
    expect(capErr.code).toBe('tool_policy_unsupported');
    expect(capErr.name).toBe('UnsupportedProviderCapabilityError');
  });

  it('satisfies AgentProviderAdapter and AgentProviderSession structural contracts at compile time', () => {
    // Compile-time structural assertion for AgentProviderAdapter
    const _mockAdapter: AgentProviderAdapter = {
      providerKind: 'test',
      adapterId: 'test-adapter',
      supportedConnectionMechanism: 'process_environment',
      startSession(_input) {
        const session: AgentProviderSession = {
          events: (async function* () {})(),
          metadata: Promise.resolve({
            outcome: 'succeeded',
            launchMechanism: 'process_environment',
            degradedCapabilities: [],
            tokenUsage: { available: false }
          })
        };
        return session;
      }
    };
    expect(_mockAdapter.providerKind).toBe('test');
  });
});

describe('runner dispatch public API', () => {
  it('exports getAgentProviderAdapterKey and createAgentRunnerFactory', async () => {
    const { getAgentProviderAdapterKey, createAgentRunnerFactory } = await import('./index.js');

    expect(getAgentProviderAdapterKey).toBeTypeOf('function');
    expect(createAgentRunnerFactory).toBeTypeOf('function');

    // Key format is stable
    expect(getAgentProviderAdapterKey('anthropic', 'claude-agent-sdk')).toBe(
      JSON.stringify(['anthropic', 'claude-agent-sdk'])
    );
  });
});

describe('request alteration public API', () => {
  it('exports request alteration primitives from the public entrypoint', () => {
    // Verify function exports are callable
    expect(applyRequestAlteration).toBeTypeOf('function');
    expect(buildClaudeProcessLaunchEnvironment).toBeTypeOf('function');
    expect(isTransientProviderFailure).toBeTypeOf('function');
    expect(validateHttpHeaderName).toBeTypeOf('function');
    expect(redactProviderRequestForLog).toBeTypeOf('function');
    expect(redactProviderResponseForLog).toBeTypeOf('function');
    expect(redactProcessLaunchConfigForLog).toBeTypeOf('function');

    // Verify constants
    expect(defaultRequestTimeoutMs).toBe(60_000);
    expect(maximumRequestTimeoutMs).toBe(120_000);
    expect(defaultMaxRetries).toBe(1);
    expect(maximumMaxRetries).toBe(5);
    expect(claudeProviderOwnedEnvironmentVariables).toContain('ANTHROPIC_API_KEY');

    // Verify error class
    const err = new ProviderAlterationError('invalid_base_url', 'test error');
    expect(err).toBeInstanceOf(ProviderAlterationError);
    expect(err.code).toBe('invalid_base_url');
    expect(err.name).toBe('ProviderAlterationError');

    // Verify type imports satisfy type assertions (compile-time)
    const _req: ProviderRequest = { url: 'https://example.com', method: 'GET' };
    const _opts: RequestAlterationOptions = { request: _req, endpoint: {} };
    const _altered: AlteredProviderRequest = applyRequestAlteration(_opts);
    const _policy: RetryPolicy = _altered.retryPolicy;
    const _launchInput: ClaudeProcessLaunchInput = { endpoint: {}, credential: 'c', materializedEnvironment: { variables: {}, secretVariableNames: [] } };
    const _launchResult: ClaudeProcessLaunchResult = buildClaudeProcessLaunchEnvironment(_launchInput);
    const _degradation: ProviderCapabilityDegradation | undefined = _launchResult.degradedCapabilities[0];
    const _redactReq: RedactProviderRequestInput = { request: _req };
    const _redactRes: RedactProviderResponseInput = { statusCode: 200 };
    const _redactLaunch: RedactProcessLaunchConfigInput = { launchResult: _launchResult };
    expect(_altered.timeoutMs).toBe(defaultRequestTimeoutMs);
    expect(_policy.maxRetries).toBe(defaultMaxRetries);
    expect(_degradation).toBeUndefined();
    expect(_redactReq).toBeDefined();
    expect(_redactRes).toBeDefined();
    expect(_redactLaunch).toBeDefined();
  });
});
