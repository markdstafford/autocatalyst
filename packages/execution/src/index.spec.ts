import { describe, expect, it } from 'vitest';

import {
  WorkspaceProvisioningError,
  WorkspacePruneError,
  WorkspaceTeardownError,
  executionPackageName,
  provisionWorkspace,
  pruneWorkspacePath,
  redactWorkspaceDiagnostic,
  summarizeWorkspaceCause,
  teardownWorkspace,
  type PruneWorkspacePathRequest,
  type TeardownWorkspaceRequest,
  type WorkspaceErrorCauseSummary,
  type WorkspacePruneResult,
  type WorkspacePruneStatus,
  type WorkspaceTeardownResult,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult,
  type Runner
} from './index.js';

describe('execution scaffold', () => {
  it('exposes the public Runner boundary', async () => {
    const runner: Runner = {
      async run(input) {
        return { runId: input.runId, status: 'accepted' };
      }
    };

    await expect(runner.run({ runId: 'run_123' })).resolves.toEqual({
      runId: 'run_123',
      status: 'accepted'
    });
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
