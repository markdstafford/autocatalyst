import type { JsonValue, PullRequest } from '@autocatalyst/api-contract';

import type {
  ConversationRepository,
  ProjectRepository,
  PullRequestRepository,
  RunRepository,
  TopicRepository
} from './domain-repositories.js';
import type { CodeHostCredential, CodeHostPort, CodeHostTarget } from './code-host.js';
import { isCodeHostError } from './code-host.js';
import type { CodeHostRegistry } from './code-host-registry.js';
import type { ApplyOrchestratedDirectiveInput, OrchestratedRunResult } from './orchestrator.js';

// --- Public types ---

export interface DetectPullRequestMergesInput {
  readonly tenant: string;
  readonly maxCount: number;
  readonly timeoutMs: number;
}

export interface PullRequestStatusReconciliationResult {
  readonly checked: number;
  readonly merged: number;
  readonly closed: number;
  readonly failed: number;
  readonly timedOut: boolean;
}

export interface PullRequestLifecycleDependencies {
  readonly runs: RunRepository;
  readonly conversations: ConversationRepository;
  readonly topics: TopicRepository;
  readonly projects: ProjectRepository;
  readonly pullRequests: PullRequestRepository;
  readonly codeHosts: CodeHostRegistry;
  readonly resolveCredential: (ref: unknown) => Promise<CodeHostCredential>;
  readonly applyDirective: (input: ApplyOrchestratedDirectiveInput) => Promise<OrchestratedRunResult>;
  readonly clock?: () => string;
  readonly now?: () => number;
}

// --- Helpers ---

interface ProjectCodeHostBinding {
  readonly target: CodeHostTarget;
  readonly credentialRef: unknown;
}

function resolveCodeHostBinding(project: {
  readonly codeHostSetting: { readonly provider: string; readonly credentialRef?: unknown } | null;
  readonly hostRepository: { readonly provider: string; readonly owner: string; readonly name: string };
}): ProjectCodeHostBinding | null {
  if (project.codeHostSetting === null) return null;
  if (project.codeHostSetting.credentialRef === undefined) return null;
  return {
    target: {
      provider: project.hostRepository.provider,
      owner: project.hostRepository.owner,
      name: project.hostRepository.name
    },
    credentialRef: project.codeHostSetting.credentialRef
  };
}

// --- Per-PR outcome ---

type PerOutcome =
  | { readonly kind: 'open' }
  | { readonly kind: 'merged' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed' };

async function reconcileSinglePullRequest(
  pr: PullRequest,
  deps: PullRequestLifecycleDependencies,
  clock: () => string
): Promise<PerOutcome> {
  // Run was already loaded and validated by the caller; re-load to get the
  // topicId (the caller does not need it). A missing/terminal run here would
  // be a race we treat as failure.
  const run = await deps.runs.findById(pr.runId);
  if (run === null || run.tenant !== pr.tenant || run.terminal) {
    return { kind: 'failed' };
  }

  // 2. Walk topic -> conversation -> project.
  const topic = await deps.topics.findById(run.topicId);
  if (topic === null) return { kind: 'failed' };
  const conversation = await deps.conversations.findById(topic.conversationId);
  if (conversation === null) return { kind: 'failed' };
  const project = await deps.projects.findById(conversation.projectId);
  if (project === null) return { kind: 'failed' };

  const binding = resolveCodeHostBinding(project);
  if (binding === null) return { kind: 'failed' };

  // 3. Resolve credential.
  let credential: CodeHostCredential;
  try {
    credential = await deps.resolveCredential(binding.credentialRef);
  } catch {
    return { kind: 'failed' };
  }

  // 4. Resolve code-host port.
  let codeHostPort: CodeHostPort;
  try {
    codeHostPort = deps.codeHosts.get(binding.target.provider);
  } catch {
    return { kind: 'failed' };
  }

  // 5. Read provider state.
  let facts;
  try {
    facts = await codeHostPort.read({
      target: binding.target,
      number: pr.number,
      credential
    });
  } catch (cause) {
    if (isCodeHostError(cause)) return { kind: 'failed' };
    return { kind: 'failed' };
  }

  if (facts.state === 'open') {
    return { kind: 'open' };
  }

  if (facts.state === 'merged') {
    try {
      await deps.pullRequests.updateState({
        runId: pr.runId,
        tenant: pr.tenant,
        state: 'merged',
        updatedAt: clock(),
        expectedState: 'open'
      });
    } catch {
      return { kind: 'failed' };
    }
    try {
      const checkpoint = {
        kind: 'pull_request_merged' as const,
        provider: facts.provider,
        number: facts.number,
        url: facts.url,
        mergedAt: clock()
      };
      await deps.applyDirective({
        runId: pr.runId,
        tenant: pr.tenant,
        directive: 'advance',
        origin: 'system',
        checkpointResult: checkpoint as unknown as JsonValue
      });
    } catch {
      return { kind: 'failed' };
    }
    return { kind: 'merged' };
  }

  if (facts.state === 'closed') {
    try {
      await deps.pullRequests.updateState({
        runId: pr.runId,
        tenant: pr.tenant,
        state: 'closed',
        updatedAt: clock(),
        expectedState: 'open'
      });
    } catch {
      return { kind: 'failed' };
    }
    try {
      await deps.applyDirective({
        runId: pr.runId,
        tenant: pr.tenant,
        directive: 'fail',
        origin: 'system',
        reason: 'pull_request_closed_without_merge'
      });
    } catch {
      return { kind: 'failed' };
    }
    return { kind: 'closed' };
  }

  // Unknown provider state: treat as failure rather than silently progressing.
  return { kind: 'failed' };
}

// --- Public entry point ---

export async function detectPullRequestMerges(
  input: DetectPullRequestMergesInput,
  deps: PullRequestLifecycleDependencies
): Promise<PullRequestStatusReconciliationResult> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const now = deps.now ?? (() => Date.now());

  const startMs = now();
  const deadlineMs = startMs + input.timeoutMs;

  let checked = 0;
  let merged = 0;
  let closed = 0;
  let failed = 0;
  let timedOut = false;

  let openPrs: readonly PullRequest[];
  try {
    openPrs = await deps.pullRequests.listOpen({ tenant: input.tenant, limit: input.maxCount });
  } catch {
    // If we cannot even list open PRs we report timedOut=false and zero counts.
    return { checked: 0, merged: 0, closed: 0, failed: 0, timedOut: false };
  }

  for (const pr of openPrs) {
    if (now() >= deadlineMs) {
      timedOut = true;
      break;
    }

    // Per-PR error containment: never let one bad PR crash the batch.
    let outcome: PerOutcome;
    try {
      // Quick pre-check: skip terminal/missing runs entirely (don't count).
      const run = await deps.runs.findById(pr.runId);
      if (run === null || run.tenant !== pr.tenant || run.terminal) {
        continue;
      }
      outcome = await reconcileSinglePullRequest(pr, deps, clock);
    } catch {
      failed += 1;
      continue;
    }

    switch (outcome.kind) {
      case 'open':
        checked += 1;
        break;
      case 'merged':
        merged += 1;
        break;
      case 'closed':
        closed += 1;
        break;
      case 'failed':
        failed += 1;
        break;
    }
  }

  return { checked, merged, closed, failed, timedOut };
}
