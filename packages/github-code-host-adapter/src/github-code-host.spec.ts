import { describe, expect, it, vi } from 'vitest';
import { CodeHostError } from '@autocatalyst/core';
import type {
  CodeHostTarget,
  CreateCodeHostPullRequestInput,
  FindCodeHostPullRequestByBranchInput,
  MergeCodeHostPullRequestInput,
  ReadCodeHostPullRequestInput,
  UpdateCodeHostPullRequestInput
} from '@autocatalyst/core';
import { GhExecError } from '@autocatalyst/github-issue-tracker-adapter';
import type { GhExecInput, GhExecResult } from '@autocatalyst/github-issue-tracker-adapter';
import { createGitHubCodeHostAdapter } from './github-code-host.js';
import type { ExecuteGhFunction, SafeGitExecutor } from './github-code-host.js';

const SECRET_TOKEN = 'ghp_DO_NOT_LEAK_123';

function makeTarget(): CodeHostTarget {
  return { provider: 'github', owner: 'myorg', name: 'myrepo' };
}

function makeCredential() {
  return { token: SECRET_TOKEN };
}

interface ExecCall {
  readonly args: readonly string[];
  readonly token: string;
}

interface QueuedFakeOptions {
  readonly responses: readonly GhExecResult[];
}

function makeFakeExecuteGh(opts: QueuedFakeOptions): { fn: ExecuteGhFunction; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const queue = [...opts.responses];
  const fn: ExecuteGhFunction = async (input: GhExecInput) => {
    calls.push({ args: input.args, token: input.token });
    const next = queue.shift();
    if (next === undefined) {
      return { stdout: '{}', truncated: false };
    }
    return next;
  };
  return { fn, calls };
}

function makeGit(): SafeGitExecutor & { pushBranch: ReturnType<typeof vi.fn> } {
  return { pushBranch: vi.fn(async () => undefined) };
}

const prOpenJson = JSON.stringify({
  number: 73,
  url: 'https://github.com/myorg/myrepo/pull/73',
  state: 'OPEN',
  headRefName: 'run/abc',
  mergedAt: null
});
const prMergedJson = JSON.stringify({
  number: 73,
  url: 'https://github.com/myorg/myrepo/pull/73',
  state: 'MERGED',
  headRefName: 'run/abc',
  mergedAt: '2026-01-01T00:00:00Z'
});
const prClosedJson = JSON.stringify({
  number: 73,
  url: 'https://github.com/myorg/myrepo/pull/73',
  state: 'CLOSED',
  headRefName: 'run/abc',
  mergedAt: null
});
const prClosedWithMergedAtJson = JSON.stringify({
  number: 73,
  url: 'https://github.com/myorg/myrepo/pull/73',
  state: 'CLOSED',
  headRefName: 'run/abc',
  mergedAt: '2026-01-01T00:00:00Z'
});

const PR_URL = 'https://github.com/myorg/myrepo/pull/73';

describe('GitHubCodeHostAdapter.create', () => {
  it('pushes the branch, calls gh pr create (no --json) then gh pr view, and maps OPEN → open', async () => {
    const { fn, calls } = makeFakeExecuteGh({
      responses: [
        { stdout: PR_URL, truncated: false },          // create returns URL
        { stdout: prOpenJson, truncated: false }        // view returns PR JSON
      ]
    });
    const git = makeGit();
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git });

    const input: CreateCodeHostPullRequestInput = {
      target: makeTarget(),
      workspaceRepoRoot: '/tmp/repo',
      branch: 'run/abc',
      baseBranch: 'main',
      content: { title: 'feat: thing', body: 'body text' },
      credential: makeCredential()
    };
    const result = await adapter.create(input);

    expect(git.pushBranch).toHaveBeenCalledWith({
      workspaceRepoRoot: '/tmp/repo',
      branch: 'run/abc',
      remote: 'origin'
    });
    expect(calls).toHaveLength(2);

    // First call: gh pr create — no --json flag
    const createArgs = calls[0]!.args;
    expect(createArgs[0]).toBe('pr');
    expect(createArgs[1]).toBe('create');
    expect(createArgs).toContain('--repo');
    expect(createArgs[createArgs.indexOf('--repo') + 1]).toBe('myorg/myrepo');
    expect(createArgs[createArgs.indexOf('--base') + 1]).toBe('main');
    expect(createArgs[createArgs.indexOf('--head') + 1]).toBe('run/abc');
    expect(createArgs[createArgs.indexOf('--title') + 1]).toBe('feat: thing');
    expect(createArgs[createArgs.indexOf('--body') + 1]).toBe('body text');
    expect(createArgs).not.toContain('--json');

    // Second call: gh pr view <number> --json
    const viewArgs = calls[1]!.args;
    expect(viewArgs[0]).toBe('pr');
    expect(viewArgs[1]).toBe('view');
    expect(viewArgs[2]).toBe('73');
    expect(viewArgs).toContain('--repo');
    expect(viewArgs[viewArgs.indexOf('--repo') + 1]).toBe('myorg/myrepo');
    expect(viewArgs).toContain('--json');

    expect(result).toEqual({
      provider: 'github',
      number: 73,
      url: PR_URL,
      state: 'open',
      branch: 'run/abc'
    });
  });

  it('throws unsafe_provider_error when gh pr create returns a non-PR URL', async () => {
    const { fn } = makeFakeExecuteGh({
      responses: [{ stdout: 'https://github.com/myorg/myrepo/issues/5', truncated: false }]
    });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    await expect(
      adapter.create({
        target: makeTarget(),
        workspaceRepoRoot: '/tmp/repo',
        branch: 'run/abc',
        baseBranch: 'main',
        content: { title: 't', body: 'b' },
        credential: makeCredential()
      })
    ).rejects.toMatchObject({ name: 'CodeHostError', code: 'unsafe_provider_error' });
  });
});

describe('GitHubCodeHostAdapter.read', () => {
  it('maps GitHub OPEN → open', async () => {
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout: prOpenJson, truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const input: ReadCodeHostPullRequestInput = {
      target: makeTarget(),
      number: 73,
      credential: makeCredential()
    };
    const result = await adapter.read(input);
    expect(result.state).toBe('open');
  });

  it('maps GitHub MERGED → merged', async () => {
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout: prMergedJson, truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const result = await adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() });
    expect(result.state).toBe('merged');
  });

  it('maps GitHub CLOSED with no mergedAt → closed', async () => {
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout: prClosedJson, truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const result = await adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() });
    expect(result.state).toBe('closed');
  });

  it('maps GitHub CLOSED with mergedAt → merged', async () => {
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout: prClosedWithMergedAtJson, truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const result = await adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() });
    expect(result.state).toBe('merged');
  });
});

describe('GitHubCodeHostAdapter.findByBranch', () => {
  const input: FindCodeHostPullRequestByBranchInput = {
    target: makeTarget(),
    headBranch: 'run/abc',
    credential: makeCredential()
  };

  it('returns null when the result list is empty', async () => {
    const { fn, calls } = makeFakeExecuteGh({ responses: [{ stdout: '[]', truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const result = await adapter.findByBranch(input);
    expect(result).toBeNull();
    expect(calls[0]!.args).toContain('--repo');
    expect(calls[0]!.args[calls[0]!.args.indexOf('--repo') + 1]).toBe('myorg/myrepo');
    expect(calls[0]!.args).toContain('--head');
    expect(calls[0]!.args[calls[0]!.args.indexOf('--head') + 1]).toBe('run/abc');
  });

  it('returns PR facts when exactly one result matches headRefName', async () => {
    const stdout = JSON.stringify([{
      number: 73,
      url: 'https://github.com/myorg/myrepo/pull/73',
      state: 'OPEN',
      headRefName: 'run/abc',
      mergedAt: null
    }]);
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout, truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const result = await adapter.findByBranch(input);
    expect(result).toEqual({
      provider: 'github',
      number: 73,
      url: 'https://github.com/myorg/myrepo/pull/73',
      state: 'open',
      branch: 'run/abc'
    });
  });

  it('throws ambiguous_branch_match when multiple exact matches return', async () => {
    const stdout = JSON.stringify([
      { number: 73, url: 'u1', state: 'OPEN', headRefName: 'run/abc', mergedAt: null },
      { number: 74, url: 'u2', state: 'OPEN', headRefName: 'run/abc', mergedAt: null }
    ]);
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout, truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    await expect(adapter.findByBranch(input)).rejects.toMatchObject({
      name: 'CodeHostError',
      code: 'ambiguous_branch_match'
    });
  });
});

describe('GitHubCodeHostAdapter.update', () => {
  it('calls gh pr edit NUMBER --repo with title and body', async () => {
    const { fn, calls } = makeFakeExecuteGh({ responses: [{ stdout: '', truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const input: UpdateCodeHostPullRequestInput = {
      target: makeTarget(),
      number: 73,
      content: { title: 'feat: updated', body: 'new body' },
      credential: makeCredential()
    };
    await adapter.update(input);
    const args = calls[0]!.args;
    expect(args[0]).toBe('pr');
    expect(args[1]).toBe('edit');
    expect(args[2]).toBe('73');
    expect(args).toContain('--repo');
    expect(args[args.indexOf('--repo') + 1]).toBe('myorg/myrepo');
    expect(args[args.indexOf('--title') + 1]).toBe('feat: updated');
    expect(args[args.indexOf('--body') + 1]).toBe('new body');
  });
});

describe('GitHubCodeHostAdapter.merge', () => {
  it('sends --squash --delete-branch by default and reads PR back', async () => {
    const { fn, calls } = makeFakeExecuteGh({
      responses: [
        { stdout: '', truncated: false },        // merge
        { stdout: prMergedJson, truncated: false } // view
      ]
    });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    const input: MergeCodeHostPullRequestInput = {
      target: makeTarget(),
      number: 73,
      credential: makeCredential()
    };
    const result = await adapter.merge(input);
    const mergeArgs = calls[0]!.args;
    expect(mergeArgs[0]).toBe('pr');
    expect(mergeArgs[1]).toBe('merge');
    expect(mergeArgs[2]).toBe('73');
    expect(mergeArgs).toContain('--repo');
    expect(mergeArgs[mergeArgs.indexOf('--repo') + 1]).toBe('myorg/myrepo');
    expect(mergeArgs).toContain('--squash');
    expect(mergeArgs).toContain('--delete-branch');
    expect(result.state).toBe('merged');
  });

  it('throws unsupported_merge_strategy when strategy diverges', async () => {
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout: '', truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    await expect(
      adapter.merge({
        target: makeTarget(),
        number: 73,
        credential: makeCredential(),
        strategy: { method: 'squash', deleteBranch: false }
      })
    ).rejects.toMatchObject({ name: 'CodeHostError', code: 'unsupported_merge_strategy' });
  });
});

describe('GitHubCodeHostAdapter error handling', () => {
  it('throws unsafe_provider_error when gh returns malformed JSON', async () => {
    const { fn } = makeFakeExecuteGh({ responses: [{ stdout: 'not json', truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    await expect(
      adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() })
    ).rejects.toMatchObject({ name: 'CodeHostError', code: 'unsafe_provider_error' });
  });

  it('maps GhExecError gh_auth_failed → authentication_failed', async () => {
    const fn: ExecuteGhFunction = async () => {
      throw new GhExecError('gh_auth_failed', 'auth failed');
    };
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    await expect(
      adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() })
    ).rejects.toMatchObject({ name: 'CodeHostError', code: 'authentication_failed' });
  });

  it('never includes the token in CodeHostError details or message when gh fails', async () => {
    const fn: ExecuteGhFunction = async () => {
      throw new GhExecError('gh_auth_failed', 'auth failed');
    };
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    try {
      await adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeHostError);
      const err = error as CodeHostError;
      expect(err.message).not.toContain(SECRET_TOKEN);
      expect(JSON.stringify(err.safeDetails)).not.toContain(SECRET_TOKEN);
    }
  });

  it('every gh pr command includes an explicit --repo owner/name', async () => {
    const { fn, calls } = makeFakeExecuteGh({
      responses: [
        { stdout: PR_URL, truncated: false },               // create: returns URL
        { stdout: prOpenJson, truncated: false },           // create: view after create
        { stdout: prOpenJson, truncated: false },           // read
        { stdout: '[]', truncated: false },                 // findByBranch
        { stdout: '', truncated: false },                   // update
        { stdout: '', truncated: false },                   // merge step 1
        { stdout: prMergedJson, truncated: false }          // merge view step
      ]
    });
    const git = makeGit();
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git });

    await adapter.create({
      target: makeTarget(),
      workspaceRepoRoot: '/tmp/repo',
      branch: 'run/abc',
      baseBranch: 'main',
      content: { title: 't', body: 'b' },
      credential: makeCredential()
    });
    await adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() });
    await adapter.findByBranch({ target: makeTarget(), headBranch: 'run/abc', credential: makeCredential() });
    await adapter.update({
      target: makeTarget(),
      number: 73,
      content: { title: 't', body: 'b' },
      credential: makeCredential()
    });
    await adapter.merge({ target: makeTarget(), number: 73, credential: makeCredential() });

    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call.args).toContain('--repo');
      expect(call.args[call.args.indexOf('--repo') + 1]).toBe('myorg/myrepo');
    }
  });

  it('passes the token only via GhExecInput.token, never as a CLI arg', async () => {
    const { fn, calls } = makeFakeExecuteGh({ responses: [{ stdout: prOpenJson, truncated: false }] });
    const adapter = createGitHubCodeHostAdapter({ executeGh: fn, git: makeGit() });
    await adapter.read({ target: makeTarget(), number: 73, credential: makeCredential() });
    expect(calls[0]!.token).toBe(SECRET_TOKEN);
    for (const arg of calls[0]!.args) {
      expect(arg).not.toContain(SECRET_TOKEN);
    }
  });
});

describe('GitHubCodeHostAdapter — secret redaction', () => {
  const LEAKED_TOKEN = 'ghp_DO_NOT_LEAK_123';

  function makeLeakingExecuteGh(): ExecuteGhFunction {
    return async () => {
      throw new GhExecError('gh_auth_failed', `auth failed: token=${LEAKED_TOKEN} was rejected`);
    };
  }

  it('does not expose the token in message when create fails via GhExecError', async () => {
    const adapter = createGitHubCodeHostAdapter({ executeGh: makeLeakingExecuteGh(), git: makeGit() });
    try {
      await adapter.create({
        target: makeTarget(),
        workspaceRepoRoot: '/tmp/repo',
        branch: 'run/abc',
        baseBranch: 'main',
        content: { title: 'feat: t', body: 'b' },
        credential: { token: LEAKED_TOKEN }
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeHostError);
      const err = error as CodeHostError;
      expect(err.message).not.toContain(LEAKED_TOKEN);
      expect(JSON.stringify(err.safeDetails)).not.toContain(LEAKED_TOKEN);
    }
  });

  it('does not expose the token in message when read fails via GhExecError', async () => {
    const adapter = createGitHubCodeHostAdapter({ executeGh: makeLeakingExecuteGh(), git: makeGit() });
    try {
      await adapter.read({ target: makeTarget(), number: 73, credential: { token: LEAKED_TOKEN } });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeHostError);
      const err = error as CodeHostError;
      expect(err.message).not.toContain(LEAKED_TOKEN);
      expect(JSON.stringify(err.safeDetails)).not.toContain(LEAKED_TOKEN);
    }
  });

  it('does not expose the token in message when findByBranch fails via GhExecError', async () => {
    const adapter = createGitHubCodeHostAdapter({ executeGh: makeLeakingExecuteGh(), git: makeGit() });
    try {
      await adapter.findByBranch({ target: makeTarget(), headBranch: 'run/abc', credential: { token: LEAKED_TOKEN } });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeHostError);
      const err = error as CodeHostError;
      expect(err.message).not.toContain(LEAKED_TOKEN);
      expect(JSON.stringify(err.safeDetails)).not.toContain(LEAKED_TOKEN);
    }
  });

  it('safeDetails contains only known-safe fields (no raw message, no token)', async () => {
    const adapter = createGitHubCodeHostAdapter({ executeGh: makeLeakingExecuteGh(), git: makeGit() });
    try {
      await adapter.read({ target: makeTarget(), number: 73, credential: { token: LEAKED_TOKEN } });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CodeHostError);
      const err = error as CodeHostError;
      const allowedKeys = new Set(['provider', 'repository', 'owner', 'name', 'branch', 'headBranch', 'baseBranch', 'number', 'state', 'url']);
      for (const key of Object.keys(err.safeDetails)) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    }
  });
});

describe('createGitHubCodeHostAdapter', () => {
  it('creates a code-host port with injected execution seams', () => {
    const adapter = createGitHubCodeHostAdapter({
      executeGh: async () => ({ stdout: '{}', truncated: false }),
      git: { pushBranch: async () => undefined }
    });
    expect(adapter).toHaveProperty('create');
    expect(adapter).toHaveProperty('read');
    expect(adapter).toHaveProperty('findByBranch');
    expect(adapter).toHaveProperty('update');
    expect(adapter).toHaveProperty('merge');
  });
});
