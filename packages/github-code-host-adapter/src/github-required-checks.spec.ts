import { describe, expect, it, vi } from 'vitest';
import { createGitHubCodeHostAdapter } from './github-code-host.js';
import { readGitHubRequiredChecks } from './github-required-checks.js';

const oid = 'a'.repeat(40);
const then = '2026-11-25T00:01:00Z';
const now = '2026-11-25T00:02:00Z';
const check = (id: string, app: string, status: string, date: string | null, required = true) => ({
  __typename: 'CheckRun', id, name: 'Tests', status, conclusion: status === 'COMPLETED' ? 'FAILURE' : null,
  startedAt: date, checkSuite: { id: `suite_${app}`, app: { id: app } }, isRequired: required
});
const legacy = (id: string, state: string, date: string) => ({
  __typename: 'StatusContext', id, context: 'Tests', state, createdAt: date, isRequired: true
});
const page = (nodes: unknown[], totalCount: number, hasNextPage = false) => JSON.stringify({
  data: { repository: { object: { oid, statusCheckRollup: { contexts: {
    totalCount, nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'cursor_1' : null }
  } } } } }
});

describe('exact-head required check observations', () => {
  it('paginates both result kinds and distinguishes shared names, optional results, and reruns', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([
      check('old_failure', 'app_a', 'COMPLETED', then), check('optional', 'app_b', 'COMPLETED', then, false),
      legacy('legacy_old', 'FAILURE', then)
    ], 6, true)).mockResolvedValueOnce(page([
      check('pending_rerun', 'app_a', 'QUEUED', null), check('required_other_app', 'app_c', 'COMPLETED', now),
      legacy('legacy_new', 'ERROR', now)
    ], 6));
    expect(await readGitHubRequiredChecks({ owner: 'test', name: 'repo', oid, number: 7, read })).toEqual({ requiredPending: true, failures: [
      { kind: 'legacy_status', id: 'legacy_new', name: 'Tests', conclusion: 'error' },
      { kind: 'check_run', id: 'required_other_app', name: 'Tests', conclusion: 'failure' }
    ] });
    expect(read.mock.calls[1]?.[0]).toContain('after=cursor_1');
    expect(read.mock.calls[0]?.[0]).toContain(`oid=${oid}`);
  });

  it('rejects partial or changing pages', async () => {
    const read = vi.fn().mockResolvedValueOnce(page([legacy('one', 'ERROR', then)], 2, true))
      .mockResolvedValueOnce(page([legacy('one', 'ERROR', then)], 2));
    await expect(readGitHubRequiredChecks({ owner: 'test', name: 'repo', oid, number: 7, read }))
      .rejects.toThrow('ci_page_changed');
  });

  it('supersedes a workflow rerun without hiding a distinct run from the same app', async () => {
    const workflowCheck = (id: string, workflowRunId: string, status: string, date: string | null) => {
      const node = check(id, 'github_actions', status, date);
      return { ...node, checkSuite: { ...node.checkSuite, id: `suite_${id}`, workflowRun: { id: workflowRunId } } };
    };
    const read = vi.fn().mockResolvedValue(page([
      workflowCheck('old_failure', 'run_one', 'COMPLETED', then),
      workflowCheck('pending_rerun', 'run_one', 'QUEUED', null),
      workflowCheck('current_failure', 'run_two', 'COMPLETED', now)
    ], 3));
    await expect(readGitHubRequiredChecks({ owner: 'test', name: 'repo', oid, number: 7, read })).resolves.toEqual({
      requiredPending: true,
      failures: [{ kind: 'check_run', id: 'current_failure', name: 'Tests', conclusion: 'failure' }]
    });
  });

  it('keeps terminal evidence when the check rollup is unreadable', async () => {
    const facts = { url: 'https://github.com/test/repo/pull/7', number: 7, state: 'OPEN', headRefName: 'feature/run',
      headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'test' }, headRefOid: oid, baseRefName: 'main' };
    const executeGh = vi.fn().mockResolvedValueOnce({ stdout: JSON.stringify(facts), truncated: false })
      .mockRejectedValueOnce(new Error('checks not permitted'))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ ...facts, state: 'MERGED' }), truncated: false });
    const adapter = createGitHubCodeHostAdapter({ executeGh, git: { pushBranch: vi.fn() } });
    const observation = await adapter.observeCi?.({
      target: { provider: 'github', owner: 'test', name: 'repo' }, number: 7, credential: { token: 'test' },
      deadlineMs: Date.now() + 1000
    });
    expect(observation).toMatchObject({ facts: { state: 'merged' }, failures: null });
    expect(executeGh.mock.calls.every(([input]) => input.timeoutMs > 0 && input.timeoutMs <= 1000)).toBe(true);
  });
});
