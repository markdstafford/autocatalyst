import { readGitHubRequiredChecks } from './github-required-checks.js';
import { GhExecError, executeGh as defaultExecuteGh } from '@autocatalyst/github-issue-tracker-adapter';
import type { GhExecInput, GhExecResult } from '@autocatalyst/github-issue-tracker-adapter';
import type {
  CodeHostPort,
  CodeHostPullRequestFacts,
  CodeHostErrorCode,
  CodeHostTarget,
  CreateCodeHostPullRequestInput,
  FindCodeHostPullRequestByBranchInput,
  MergeCodeHostPullRequestInput,
  ReadCodeHostPullRequestInput,
  UpdateCodeHostPullRequestInput
} from '@autocatalyst/core';
import { CodeHostError, repositorySlug } from '@autocatalyst/core';

export type ExecuteGhFunction = (input: GhExecInput) => Promise<GhExecResult>;

export interface SafeGitPushBranchInput {
  readonly workspaceRepoRoot: string;
  readonly branch: string;
  readonly remote?: string;
  readonly timeoutMs?: number;
}

export interface SafeGitExecutor {
  pushBranch(input: SafeGitPushBranchInput): Promise<void>;
}

export interface GitHubCodeHostAdapterOptions {
  /**
   * The `gh` execution helper. Optional: defaults to the shared `executeGh` so the composition
   * root never needs to import the helper itself (keeping `gh` usage inside the adapter boundary).
   * Tests may inject a fake to avoid a real subprocess.
   */
  readonly executeGh?: ExecuteGhFunction;
  readonly git: SafeGitExecutor;
  readonly ghExecutablePath?: string;
  readonly timeoutMs?: number;
}

const PR_JSON_FIELDS = 'number,url,state,headRefName,mergedAt,headRefOid,headRepository,headRepositoryOwner,baseRefName';

interface GitHubPullRequestResponse {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly headRefName: string;
  readonly mergedAt?: string | null;
  readonly headRefOid?: unknown;
  readonly headRepository?: { name?: unknown } | null;
  readonly headRepositoryOwner?: { login?: unknown } | null;
  readonly baseRefName?: unknown;
}

export function createGitHubCodeHostAdapter(options: GitHubCodeHostAdapterOptions): CodeHostPort {
  return new GitHubCodeHostAdapter(options);
}

class GitHubCodeHostAdapter implements CodeHostPort {
  constructor(private readonly options: GitHubCodeHostAdapterOptions) {}

  async create(input: CreateCodeHostPullRequestInput): Promise<CodeHostPullRequestFacts> {
    const repo = repositorySlug(input.target);

    // Push the branch to origin first so GitHub can create a PR against it.
    if (!input.branchAlreadyPushed) await this.options.git.pushBranch({
      workspaceRepoRoot: input.workspaceRepoRoot,
      branch: input.branch,
      remote: 'origin'
    });

    const createArgs = [
      'pr', 'create',
      '--repo', repo,
      '--base', input.baseBranch,
      '--head', input.branch,
      '--title', input.content.title,
      '--body', input.content.body
    ];

    const createStdout = await this.runGh(createArgs, input.credential.token, {
      provider: 'github',
      repository: repo,
      branch: input.branch
    });

    const prUrl = createStdout.trim();
    const numberMatch = /\/pull\/(\d+)/.exec(prUrl);
    if (numberMatch === null || numberMatch[1] === undefined) {
      throw new CodeHostError(
        'unsafe_provider_error',
        'GitHub pr create did not return a valid pull-request URL.',
        { provider: 'github', repository: repo, branch: input.branch }
      );
    }
    const prNumber = parseInt(numberMatch[1], 10);

    const viewDetails = { provider: 'github', repository: repo, number: prNumber };
    const viewArgs = [
      'pr', 'view', String(prNumber),
      '--repo', repo,
      '--json', PR_JSON_FIELDS
    ];
    const viewStdout = await this.runGh(viewArgs, input.credential.token, viewDetails);
    const parsed = this.parseJson(viewStdout, viewDetails);
    return this.toFacts(parsed, viewDetails);
  }

  async read(input: ReadCodeHostPullRequestInput): Promise<CodeHostPullRequestFacts> {
    return this.readWithDeadline(input, input.deadlineMs);
  }

  async observeCi(input: ReadCodeHostPullRequestInput & { readonly deadlineMs: number }) {
    const repo = repositorySlug(input.target);
    if (input.target.provider !== 'github' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu.test(repo) ||
        !Number.isSafeInteger(input.number) || input.number <= 0) {
      throw new CodeHostError('unsafe_provider_error', 'Invalid pull request binding.');
    }
    const validateIdentity = (facts: CodeHostPullRequestFacts) => {
      if (facts.number !== input.number || facts.url.toLowerCase() !== `https://github.com/${repo}/pull/${input.number}`.toLowerCase()) {
        throw new CodeHostError('unsafe_provider_error', 'GitHub pull request identity changed.');
      }
    };
    const first = await this.readWithDeadline(input, input.deadlineMs);
    validateIdentity(first);
    if (first.state !== 'open' || first.headSha === undefined || first.baseBranch === undefined ||
        first.headRepository?.toLowerCase() !== repo.toLowerCase()) return { facts: first, failures: null };
    const checks = await readGitHubRequiredChecks({
      owner: input.target.owner, name: input.target.name, oid: first.headSha, number: input.number,
      read: args => this.runGh(args, input.credential.token, { provider: 'github', repository: repo, number: input.number }, input.deadlineMs)
    }).catch(() => null);
    // Obtain terminal evidence even when checks were unreadable. A failed second read
    // cannot certify any CI snapshot, but a verified terminal read never requires CI.
    const last = await this.readWithDeadline(input, input.deadlineMs).catch(() => null);
    if (last === null) return { facts: first, failures: null };
    validateIdentity(last);
    const unchanged = last.state === 'open' && first.headSha === last.headSha && first.branch === last.branch &&
      first.headRepository === last.headRepository && first.baseBranch === last.baseBranch;
    return unchanged && Date.now() < input.deadlineMs && checks !== null ? { facts: last, ...checks }
      : { facts: last, failures: null };
  }

  private async readWithDeadline(input: ReadCodeHostPullRequestInput, deadlineMs?: number): Promise<CodeHostPullRequestFacts> {
    const repo = repositorySlug(input.target);
    const args = [
      'pr', 'view', String(input.number),
      '--repo', repo,
      '--json', PR_JSON_FIELDS
    ];

    const stdout = await this.runGh(args, input.credential.token, {
      provider: 'github',
      repository: repo,
      number: input.number
    }, deadlineMs);

    const parsed = this.parseJson(stdout, { provider: 'github', repository: repo, number: input.number });
    return this.toFacts(parsed, { provider: 'github', repository: repo, number: input.number });
  }

  async findByBranch(input: FindCodeHostPullRequestByBranchInput): Promise<CodeHostPullRequestFacts | null> {
    const repo = repositorySlug(input.target);
    const args = [
      'pr', 'list',
      '--repo', repo,
      '--head', input.headBranch,
      ...(input.baseBranch !== undefined ? ['--base', input.baseBranch] : []),
      '--state', 'all',
      '--json', PR_JSON_FIELDS
    ];

    const stdout = await this.runGh(args, input.credential.token, {
      provider: 'github',
      repository: repo,
      branch: input.headBranch
    });

    let parsedList: unknown;
    try {
      parsedList = JSON.parse(stdout);
    } catch {
      throw new CodeHostError('unsafe_provider_error', 'GitHub returned invalid JSON for pull-request list.', {
        provider: 'github',
        repository: repo,
        branch: input.headBranch
      });
    }

    if (!Array.isArray(parsedList)) {
      throw new CodeHostError('unsafe_provider_error', 'GitHub returned an unexpected pull-request list shape.', {
        provider: 'github',
        repository: repo,
        branch: input.headBranch
      });
    }

    const exactMatches = parsedList.filter(
      (item): item is GitHubPullRequestResponse =>
        typeof item === 'object' && item !== null
        && (item as { headRefName?: unknown }).headRefName === input.headBranch
    );

    if (exactMatches.length === 0) {
      return null;
    }

    // Prefer open PRs: a stale closed/merged PR on the same branch (e.g. squash-and-delete
    // followed by branch reuse) must not block recovery when a single open PR exists.
    const openMatches = exactMatches.filter(item => item.state === 'OPEN');

    if (openMatches.length === 1) {
      return this.toFacts(openMatches[0]!, { provider: 'github', repository: repo, branch: input.headBranch });
    }

    if (openMatches.length > 1) {
      throw new CodeHostError(
        'ambiguous_branch_match',
        'Multiple open GitHub pull requests share the same head branch.',
        { provider: 'github', repository: repo, branch: input.headBranch }
      );
    }

    // No open matches — return the single non-open match if unambiguous, else fail.
    if (exactMatches.length === 1) {
      return this.toFacts(exactMatches[0]!, { provider: 'github', repository: repo, branch: input.headBranch });
    }

    throw new CodeHostError(
      'ambiguous_branch_match',
      'Multiple GitHub pull requests share the same head branch.',
      { provider: 'github', repository: repo, branch: input.headBranch }
    );
  }

  async update(input: UpdateCodeHostPullRequestInput): Promise<void> {
    const repo = repositorySlug(input.target);
    const args = [
      'pr', 'edit', String(input.number),
      '--repo', repo,
      '--title', input.content.title,
      '--body', input.content.body
    ];

    await this.runGh(args, input.credential.token, {
      provider: 'github',
      repository: repo,
      number: input.number
    });
  }

  async merge(input: MergeCodeHostPullRequestInput): Promise<CodeHostPullRequestFacts> {
    const repo = repositorySlug(input.target);

    const strategy = input.strategy ?? { method: 'squash', deleteBranch: true };
    if (strategy.method !== 'squash' || strategy.deleteBranch !== true) {
      throw new CodeHostError(
        'unsupported_merge_strategy',
        'GitHub code-host adapter only supports the squash + delete-branch merge strategy.',
        { provider: 'github', repository: repo, number: input.number }
      );
    }

    const mergeArgs = [
      'pr', 'merge', String(input.number),
      '--repo', repo,
      '--squash',
      '--delete-branch'
    ];

    await this.runGh(mergeArgs, input.credential.token, {
      provider: 'github',
      repository: repo,
      number: input.number
    });

    // Read the PR back so we can return authoritative facts including merged state.
    const viewArgs = [
      'pr', 'view', String(input.number),
      '--repo', repo,
      '--json', PR_JSON_FIELDS
    ];
    const stdout = await this.runGh(viewArgs, input.credential.token, {
      provider: 'github',
      repository: repo,
      number: input.number
    });
    const parsed = this.parseJson(stdout, { provider: 'github', repository: repo, number: input.number });
    return this.toFacts(parsed, { provider: 'github', repository: repo, number: input.number });
  }

  private async runGh(
    args: readonly string[],
    token: string,
    safeDetails: Record<string, unknown>,
    deadlineMs?: number
  ): Promise<string> {
    const remaining = deadlineMs === undefined ? undefined : deadlineMs - Date.now();
    if (remaining !== undefined && remaining <= 0) throw new CodeHostError('provider_unavailable', 'Provider deadline elapsed.');
    const timeoutMs = remaining === undefined ? this.options.timeoutMs : Math.min(remaining, this.options.timeoutMs ?? remaining);
    try {
      const exec = this.options.executeGh ?? defaultExecuteGh;
      const result = await exec({
        args,
        token,
        ...(this.options.ghExecutablePath !== undefined ? { executablePath: this.options.ghExecutablePath } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      });
      if (result.truncated) throw new CodeHostError('unsafe_provider_error', 'GitHub response exceeded its output bound.');
      return result.stdout;
    } catch (error: unknown) {
      if (error instanceof CodeHostError) throw error;
      if (error instanceof GhExecError) {
        throw new CodeHostError(
          mapGhExecErrorCode(error.code),
          `GitHub gh command failed: ${error.code}.`,
          safeDetails
        );
      }
      throw new CodeHostError('provider_unavailable', 'GitHub gh command failed unexpectedly.', safeDetails);
    }
  }

  private parseJson(stdout: string, safeDetails: Record<string, unknown>): GitHubPullRequestResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new CodeHostError('unsafe_provider_error', 'GitHub returned invalid JSON.', safeDetails);
    }
    if (
      typeof parsed !== 'object' || parsed === null
      || typeof (parsed as { number?: unknown }).number !== 'number'
      || typeof (parsed as { url?: unknown }).url !== 'string'
      || typeof (parsed as { state?: unknown }).state !== 'string'
      || typeof (parsed as { headRefName?: unknown }).headRefName !== 'string'
    ) {
      throw new CodeHostError('unsafe_provider_error', 'GitHub response did not match expected pull-request shape.', safeDetails);
    }
    return parsed as GitHubPullRequestResponse;
  }

  private toFacts(
    response: GitHubPullRequestResponse,
    safeDetails: Record<string, unknown>
  ): CodeHostPullRequestFacts {
    const state = mapGitHubState({ state: response.state, mergedAt: response.mergedAt ?? null }, safeDetails);
    return {
      provider: 'github',
      number: response.number,
      url: response.url,
      state,
      branch: response.headRefName,
      ...(typeof response.headRefOid === 'string' && /^[a-f0-9]{40}$/u.test(response.headRefOid) ? { headSha: response.headRefOid } : {}),
      ...(typeof response.headRepository?.name === 'string' && typeof response.headRepositoryOwner?.login === 'string'
        ? { headRepository: `${response.headRepositoryOwner.login}/${response.headRepository.name}` } : {}),
      ...(typeof response.baseRefName === 'string' ? { baseBranch: response.baseRefName } : {})
    };
  }
}

function mapGhExecErrorCode(code: string): CodeHostErrorCode {
  switch (code) {
    case 'gh_auth_failed': return 'authentication_failed';
    case 'gh_resource_not_found': return 'resource_not_found';
    case 'gh_timeout': return 'provider_unavailable';
    case 'gh_provider_unavailable': return 'provider_unavailable';
    case 'gh_not_found': return 'provider_unavailable';
    case 'gh_error': return 'provider_unavailable';
    default: return 'provider_unavailable';
  }
}

function mapGitHubState(
  input: { state: string; mergedAt?: string | null },
  safeDetails: Record<string, unknown> = { provider: 'github' }
): 'open' | 'merged' | 'closed' {
  if (input.state === 'OPEN') return 'open';
  if (input.state === 'MERGED') return 'merged';
  if (input.state === 'CLOSED' && input.mergedAt !== null && input.mergedAt !== undefined && input.mergedAt !== '') {
    return 'merged';
  }
  if (input.state === 'CLOSED') return 'closed';
  throw new CodeHostError('unsafe_provider_error', 'GitHub returned an unsupported pull-request state.', safeDetails);
}

// Exported for testing
export { mapGitHubState, mapGhExecErrorCode };
export type { CodeHostTarget };
