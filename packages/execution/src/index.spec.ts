import { describe, expect, it } from 'vitest';

import {
  WorkspaceProvisioningError,
  executionPackageName,
  provisionWorkspace,
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
