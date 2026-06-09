import { describe, expect, it } from 'vitest';

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
  type PruneWorkspacePathRequest,
  type TeardownWorkspaceRequest,
  type WorkspaceErrorCauseSummary,
  type WorkspacePruneResult,
  type WorkspacePruneStatus,
  type WorkspaceTeardownResult,
  type ProvisionWorkspaceRequest,
  type ProvisionWorkspaceResult,
  type Runner,
  type RunnerRunInput
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
