import { z } from 'zod';
import { IssueTrackerError } from '@autocatalyst/core';
import type { IssueTrackerPort, ReadTrackedIssueInput } from '@autocatalyst/core';
import type { SecretResolver } from '@autocatalyst/core';
import type { TrackedIssue } from '@autocatalyst/api-contract';
import { trackedIssueSchema } from '@autocatalyst/api-contract';
import { executeGh, GhExecError } from './gh-exec.js';
import type { GhExecInput, GhExecResult } from './gh-exec.js';
import type { IssueTrackerErrorCode } from '@autocatalyst/core';

type ExecuteGhFn = (input: GhExecInput) => Promise<GhExecResult>;

export interface GitHubIssueTrackerOptions {
  readonly secretResolver: SecretResolver;
  readonly executeGhFn?: ExecuteGhFn;
  readonly executablePath?: string;
  readonly timeoutMs?: number;
  readonly ghOptions?: Record<string, unknown>;
}

// GitHub raw API response schema
const githubLabelSchema = z.object({ name: z.string() });
const githubIssueResponseSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  body: z.string().nullable().optional(),
  labels: z.array(githubLabelSchema),
  state: z.string(),
  url: z.string().url()
});

function normalizeState(state: string): 'open' | 'closed' | 'unknown' {
  const lower = state.toLowerCase();
  if (lower === 'open') return 'open';
  if (lower === 'closed') return 'closed';
  return 'unknown';
}

function mapGhExecErrorCode(code: string): IssueTrackerErrorCode {
  switch (code) {
    case 'gh_auth_failed': return 'tracker_auth_failed';
    case 'gh_resource_not_found': return 'issue_not_found';
    case 'gh_not_found': return 'tracker_provider_unavailable';
    case 'gh_timeout': return 'tracker_provider_unavailable';
    default: return 'tracker_provider_unavailable';
  }
}

export class GitHubIssueTracker implements IssueTrackerPort {
  readonly #secretResolver: SecretResolver;
  readonly #executeGhFn: ExecuteGhFn;
  readonly #executablePath?: string;
  readonly #timeoutMs?: number;

  constructor(options: GitHubIssueTrackerOptions) {
    this.#secretResolver = options.secretResolver;
    this.#executeGhFn = options.executeGhFn ?? executeGh;
    this.#executablePath = options.executablePath;
    this.#timeoutMs = options.timeoutMs;
  }

  async read(input: ReadTrackedIssueInput): Promise<TrackedIssue> {
    const { target, issueNumber } = input;

    if (!target.repository?.owner || !target.repository?.name) {
      throw new IssueTrackerError('tracker_target_invalid', 'GitHub tracker requires repository owner and name.', {
        safeDetails: { provider: 'github' }
      });
    }

    if (!target.credentialRef) {
      throw new IssueTrackerError('tracker_credential_missing', 'GitHub tracker requires a credential reference.', {
        safeDetails: { provider: 'github' }
      });
    }

    const { owner, name } = target.repository;
    const repo = `${owner}/${name}`;

    // Resolve token immediately before execution
    let token: string;
    try {
      token = await this.#secretResolver.resolveSecret(target.credentialRef.id);
    } catch {
      throw new IssueTrackerError('tracker_credential_missing', 'Failed to resolve GitHub tracker credential.', {
        safeDetails: { provider: 'github', credentialId: target.credentialRef.id }
      });
    }

    // Execute gh
    let stdout: string;
    try {
      const result = await this.#executeGhFn({
        args: ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'number,title,body,labels,state,url'],
        token,
        executablePath: this.#executablePath,
        timeoutMs: this.#timeoutMs
      });
      stdout = result.stdout;
    } catch (error: unknown) {
      if (error instanceof GhExecError) {
        throw new IssueTrackerError(mapGhExecErrorCode(error.code), `GitHub issue read failed: ${error.code}.`, {
          safeDetails: { provider: 'github', repository: repo, issueNumber }
        });
      }
      throw new IssueTrackerError('tracker_provider_unavailable', 'GitHub issue read failed unexpectedly.', {
        safeDetails: { provider: 'github', repository: repo, issueNumber }
      });
    }

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new IssueTrackerError('tracker_response_invalid', 'GitHub returned invalid JSON.', {
        safeDetails: { provider: 'github', repository: repo, issueNumber }
      });
    }

    // Validate schema
    const ghResult = githubIssueResponseSchema.safeParse(parsed);
    if (!ghResult.success) {
      throw new IssueTrackerError('tracker_response_invalid', 'GitHub response did not match expected schema.', {
        safeDetails: { provider: 'github', repository: repo, issueNumber }
      });
    }

    const gh = ghResult.data;

    // Normalize to TrackedIssue
    return trackedIssueSchema.parse({
      number: gh.number,
      title: gh.title,
      body: gh.body ?? '',
      labels: gh.labels.map(l => l.name),
      state: normalizeState(gh.state),
      url: gh.url
    });
  }
}
