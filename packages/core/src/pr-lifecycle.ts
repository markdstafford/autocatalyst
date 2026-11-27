import { exactRepairBinding, type RepairDecision, type RepairRepository } from './pr-ci-repair.js';
import { fullGitSha } from './pr-publication.js';
import { pullRequestStateSchema, type PullRequest, type PullRequestCheckFailureReason, type Run } from '@autocatalyst/api-contract';
import { z } from 'zod';

import type {
  ConversationRepository,
  ProjectRepository,
  PullRequestRepository,
  RunRepository,
  TopicRepository
} from './domain-repositories.js';
import { PullRequestStateConflictError } from './domain-repositories.js';
import {
  CodeHostCredentialMissingError,
  isCodeHostError,
  type CodeHostCredential,
  type RequiredCheckEvidence,
  repositorySlug,
  type CodeHostPort,
  type CodeHostPullRequestFacts,
  type CodeHostTarget,
  type ResolveCodeHostCredential
} from './code-host.js';
import type { CodeHostRegistry } from './code-host-registry.js';
import { OrchestratorError, type ApplyOrchestratedDirectiveInput, type OrchestratedRunResult } from './orchestrator.js';

// --- Public types ---

export interface DetectPullRequestMergesInput {
  readonly tenant: string;
  readonly maxCount: number;
  readonly timeoutMs: number;
  readonly admitCiRepair?: boolean;
}

export interface PullRequestStatusReconciliationResult {
  readonly checked: number;
  readonly merged: number;
  readonly closed: number;
  readonly failed: number;
  readonly timedOut: boolean;
}

type ApplyDirective = (input: ApplyOrchestratedDirectiveInput) => Promise<OrchestratedRunResult>;
type WithRunMutation = <T>(input: PullRequestRunKey, work: (applyDirective: ApplyDirective) => Promise<T>) => Promise<T>;

interface PullRequestRunKey {
  readonly tenant: string;
  readonly runId: string;
}

export interface PullRequestLifecycleDependencies {
  readonly runs: RunRepository;
  readonly conversations: ConversationRepository;
  readonly topics: TopicRepository;
  readonly projects: ProjectRepository;
  readonly pullRequests: PullRequestRepository;
  readonly codeHosts: CodeHostRegistry;
  readonly resolveCredential: ResolveCodeHostCredential;
  readonly applyDirective: ApplyDirective;
  readonly withRunMutation?: WithRunMutation;
  readonly clock?: () => string;
  readonly now?: () => number;
  readonly repair?: {
    readonly repository: RepairRepository;
    readonly limit: number;
    readonly onDecision: (run: Run, decision: RepairDecision, transition?: OrchestratedRunResult) => Promise<void>;
    readonly onTerminal: (decision: RepairDecision, state: 'merged' | 'closed') => Promise<boolean>;
    readonly wake: (run: Run) => void;
    readonly diagnostic?: (event: string, data: Record<string, unknown>) => void;
  };
  readonly batchCursor?: Map<string, { createdAt: string; id: string }>;
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
  if (project.codeHostSetting?.provider !== project.hostRepository.provider) return null;
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

// --- Shared read and commit ---

export type PullRequestReadOutcome =
  | { readonly kind: 'observed'; readonly facts: CodeHostPullRequestFacts;
      readonly repository: string; readonly failures: readonly RequiredCheckEvidence[] | null; readonly requiredPending: boolean }
  | { readonly kind: 'read_failed'; readonly reason: PullRequestCheckFailureReason }
  | { readonly kind: 'internal_failure' };

const codeHostReadFactsSchema = z.object({
  provider: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url(),
  state: pullRequestStateSchema,
  branch: z.string().min(1),
  headSha: fullGitSha.optional(),
  headRepository: z.string().max(250).optional(),
  baseBranch: z.string().max(250).optional()
});

export async function readPullRequest(
  run: Run,
  pr: PullRequest,
  deps: PullRequestLifecycleDependencies,
  requireIdentityMatch = false,
  deadlineMs?: number,
  readCi = false
): Promise<PullRequestReadOutcome> {
  let binding;
  try {
    const topic = await deps.topics.findById(run.topicId);
    if (topic === null || topic.tenant !== run.tenant) return { kind: 'internal_failure' };
    const conversation = await deps.conversations.findById(topic.conversationId);
    if (conversation === null || conversation.tenant !== run.tenant) return { kind: 'internal_failure' };
    const project = await deps.projects.findById(conversation.projectId);
    if (project === null || project.tenant !== run.tenant) return { kind: 'internal_failure' };
    binding = resolveCodeHostBinding(project);
  } catch {
    return { kind: 'internal_failure' };
  }
  if (binding === null) return { kind: 'read_failed', reason: 'credential_missing' };

  let credential: CodeHostCredential;
  try {
    credential = await deps.resolveCredential(binding.credentialRef);
  } catch (error) {
    return error instanceof CodeHostCredentialMissingError
      ? { kind: 'read_failed', reason: 'credential_missing' }
      : { kind: 'internal_failure' };
  }

  let port: CodeHostPort;
  try {
    port = deps.codeHosts.get(binding.target.provider);
    if (typeof port?.read !== 'function') return { kind: 'internal_failure' };
  } catch (error) {
    return isCodeHostError(error) && error.code === 'unsupported_provider'
      ? { kind: 'read_failed', reason: 'provider_unavailable' }
      : { kind: 'internal_failure' };
  }

  try {
    const input = { target: binding.target, number: pr.number, credential, ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
    const observation = readCi && deadlineMs !== undefined && port.observeCi !== undefined
      ? await port.observeCi({ ...input, deadlineMs }).catch(async () => ({ facts: await port.read(input), failures: null }))
      : { facts: await port.read(input), failures: null };
    const raw = observation.facts;
    const facts = codeHostReadFactsSchema.safeParse(raw);
    if (!facts.success || (requireIdentityMatch && (facts.data.number !== pr.number || facts.data.provider !== binding.target.provider))) {
      return { kind: 'read_failed', reason: 'provider_unavailable' };
    }
    return {
      kind: 'observed', facts: facts.data, repository: repositorySlug(binding.target), failures: observation.failures,
      requiredPending: 'requiredPending' in observation && observation.requiredPending === true
    };
  } catch (error) {
    if (isCodeHostError(error)) {
      if (error.code === 'authentication_failed') return { kind: 'read_failed', reason: 'authentication_failed' };
      if (error.code === 'resource_not_found') return { kind: 'read_failed', reason: 'not_found' };
    }
    return { kind: 'read_failed', reason: 'provider_unavailable' };
  }
}

type TerminalPullRequestState = Exclude<PullRequest['state'], 'open'>;
const closedWithoutMerge = 'pull_request_closed_without_merge';
const systemClock = () => new Date().toISOString();

function writeTerminalPullRequest(
  pr: PullRequest, state: TerminalPullRequestState, deps: PullRequestLifecycleDependencies
): Promise<PullRequest> {
  return deps.pullRequests.updateState({
    runId: pr.runId,
    tenant: pr.tenant,
    state,
    updatedAt: (deps.clock ?? systemClock)(),
    expectedState: 'open'
  });
}

function terminalDirective(
  pr: PullRequestRunKey,
  state: TerminalPullRequestState,
  checkpoint: Pick<PullRequest, 'provider' | 'number' | 'url'>,
  mergedAt: () => string
): ApplyOrchestratedDirectiveInput {
  const { runId, tenant } = pr;
  return state === 'closed'
    ? { runId, tenant, directive: 'fail', origin: 'system', reason: closedWithoutMerge }
    : {
        runId, tenant, directive: 'advance', origin: 'system',
        checkpointResult: {
          kind: 'pull_request_merged', provider: checkpoint.provider, number: checkpoint.number,
          url: checkpoint.url, mergedAt: mergedAt()
        }
      };
}

type PerOutcome = Exclude<PullRequestReadOutcome, { kind: 'observed' }> | { kind: PullRequest['state'] };

async function reconcileSinglePullRequest(
  pr: PullRequest,
  deps: PullRequestLifecycleDependencies,
  deadlineMs: number,
  admitCiRepair: boolean
): Promise<PerOutcome> {
  const run = await deps.runs.findById(pr.runId);
  if (run === null || run.tenant !== pr.tenant || run.terminal) return { kind: 'internal_failure' };
  const repair = deps.repair;
  const gate = repair !== undefined && admitCiRepair && run.currentStep === 'pr.human_review'
    ? await deps.runs.findLatestOpenRunStep?.({ runId: run.id, step: 'pr.human_review' }) : undefined;
  const observation = await readPullRequest(run, pr, deps, repair !== undefined, deadlineMs, gate != null);
  if (observation.kind !== 'observed') return observation;
  const { facts, failures, repository } = observation;
  const { state } = facts;
  if (state === 'open') {
    if (repair !== undefined && admitCiRepair) {
      if (gate != null && failures === null) repair.diagnostic?.('repair_ci_unknown', { runId: run.id, pullRequestId: pr.id });
      if (gate != null && failures !== null && failures.length > 0 && exactRepairBinding(facts, pr, repository) &&
          facts.headRepository?.toLowerCase() === repository.toLowerCase() && facts.headSha !== undefined &&
          facts.baseBranch !== undefined && facts.branch === pr.branch && (deps.now ?? Date.now)() < deadlineMs) {
        const admit = async () => {
          const result = await repair.repository.admit({
            run, pr, gateId: gate.id, headSha: facts.headSha!, baseRef: facts.baseBranch!, repository, failures,
            limit: repair.limit, now: (deps.clock ?? systemClock)(), deadlineMs
          });
          if (result !== null) await repair.onDecision(run, result.decision, result.transition);
          else repair.diagnostic?.('repair_admission_skipped', { runId: run.id, pullRequestId: pr.id, head: facts.headSha });
        };
        if (deps.withRunMutation) await deps.withRunMutation(pr, admit);
        else await admit();
      } else if (run.currentStep === 'implementation.build') {
        repair.wake(run);
      }
    }
    return { kind: 'open' };
  }

  const commit = async (applyDirective: ApplyDirective): Promise<PerOutcome> => {
    if (repair !== undefined) {
      const attempts = await repair.repository.listByRun(run.id, run.tenant);
      const active = attempts.find(row => row.currentStepId !== null);
      if (active !== undefined) {
        if (!exactRepairBinding(facts, pr, repository) || !await repair.onTerminal(active, state)) return { kind: 'internal_failure' };
        return { kind: state };
      }
      const current = await deps.runs.findById(run.id);
      if (current?.terminal || current?.currentStep !== 'pr.human_review' || !exactRepairBinding(facts, pr, repository)) {
        return { kind: 'internal_failure' };
      }
    }
    await writeTerminalPullRequest(pr, state, deps);
    await applyDirective(terminalDirective(pr, state, facts, deps.clock ?? systemClock));
    return { kind: state };
  };
  return deps.withRunMutation === undefined
    ? commit(deps.applyDirective)
    : deps.withRunMutation(pr, commit);
}

// --- Targeted refresh ---

export interface RefreshPullRequestDependencies extends PullRequestLifecycleDependencies {
  readonly withRunMutation: WithRunMutation;
}

interface StoredPair {
  readonly run: Run;
  readonly pullRequest: PullRequest;
}

type MissingPair = { readonly kind: 'not_found'; readonly resource: 'run' | 'pull_request' };
type RefreshFailure = Exclude<PullRequestReadOutcome, { kind: 'observed' }> | MissingPair
  | { readonly kind: 'conflict'; readonly message: string };
export type RefreshPullRequestOutcome = ({ readonly kind: 'refreshed' } & StoredPair) | RefreshFailure;
type GatedObservation = { readonly kind: 'read'; readonly pair: StoredPair; readonly gateId: string };

const notAtGate = { kind: 'conflict', message: 'Run is not waiting at the pull request gate.' } as const;
const outcomeMismatch = { kind: 'conflict', message: 'The stored pull request outcome does not match the run state.' } as const;

async function loadPair(input: PullRequestRunKey, deps: RefreshPullRequestDependencies): Promise<StoredPair | MissingPair> {
  const run = await deps.runs.findById(input.runId);
  if (run === null || run.tenant !== input.tenant) return { kind: 'not_found', resource: 'run' };
  const pullRequest = await deps.pullRequests.findByRun(input.runId);
  if (pullRequest === null || pullRequest.tenant !== input.tenant) return { kind: 'not_found', resource: 'pull_request' };
  return { run, pullRequest };
}

function isAtPullRequestGate(run: Run): boolean {
  return !run.terminal && run.currentStep === 'pr.human_review';
}

async function loadGateId(run: Run, deps: RefreshPullRequestDependencies): Promise<string> {
  const gate = await deps.runs.findLatestOpenRunStep?.({ runId: run.id, step: 'pr.human_review' });
  if (gate == null) throw new Error('Missing open pull request gate occurrence.');
  return gate.id;
}

function matchesTerminalOutcome({ run, pullRequest }: StoredPair): boolean {
  return run.terminal && (
    (pullRequest.state === 'merged' && run.currentStep === 'done') ||
    (pullRequest.state === 'closed' && run.currentStep === 'failed' && run.failureReason === closedWithoutMerge)
  );
}

/** Finish a terminal pair once, or replay it. Caller holds the run mutation lock. */
async function completeTerminalPair(
  pair: StoredPair,
  applyDirective: ApplyDirective,
  deps: RefreshPullRequestDependencies
): Promise<RefreshPullRequestOutcome> {
  if (matchesTerminalOutcome(pair)) return { kind: 'refreshed', ...pair };
  if (!isAtPullRequestGate(pair.run)) return outcomeMismatch;

  const pr = pair.pullRequest;
  if (pr.state === 'open') return { kind: 'internal_failure' };
  try {
    await applyDirective(terminalDirective(pr, pr.state, pr, () => pr.updatedAt));
  } catch (error) {
    if (!(error instanceof OrchestratorError) || (error.code !== 'terminal_run' && error.code !== 'invalid_transition')) {
      return { kind: 'internal_failure' };
    }
    // These two faults can mean another writer completed or moved the run. Never retry here.
  }

  const persisted = await loadPair(pr, deps);
  if ('kind' in persisted) return persisted;
  if (matchesTerminalOutcome(persisted)) return { kind: 'refreshed', ...persisted };
  return isAtPullRequestGate(persisted.run) ? { kind: 'internal_failure' } : outcomeMismatch;
}

export async function refreshPullRequest(
  input: PullRequestRunKey,
  deps: RefreshPullRequestDependencies
): Promise<RefreshPullRequestOutcome> {
  try {
    const start = await deps.withRunMutation<GatedObservation | RefreshPullRequestOutcome>(input, async (applyDirective) => {
      const pair = await loadPair(input, deps);
      if ('kind' in pair) return pair;
      if (pair.pullRequest.state !== 'open') return completeTerminalPair(pair, applyDirective, deps);
      if (!isAtPullRequestGate(pair.run)) return notAtGate;
      return { kind: 'read', pair, gateId: await loadGateId(pair.run, deps) };
    });
    if (start.kind !== 'read') return start;

    const observation = await readPullRequest(start.pair.run, start.pair.pullRequest, deps, true);
    if (observation.kind !== 'observed') return observation;

    return await deps.withRunMutation<RefreshPullRequestOutcome>(input, async (applyDirective) => {
      const pair = await loadPair(input, deps);
      if ('kind' in pair) return pair;
      if (pair.pullRequest.state !== 'open') return completeTerminalPair(pair, applyDirective, deps);
      if (!isAtPullRequestGate(pair.run)) return notAtGate;
      if (pair.pullRequest.id !== start.pair.pullRequest.id || await loadGateId(pair.run, deps) !== start.gateId) {
        return { kind: 'conflict', message: 'The pull request or its review gate changed during the check.' };
      }
      if (observation.facts.state === 'open') return { kind: 'refreshed', ...pair };

      let written: PullRequest;
      try {
        written = await writeTerminalPullRequest(pair.pullRequest, observation.facts.state, deps);
      } catch (error) {
        if (!(error instanceof PullRequestStateConflictError)) throw error;
        const current = await loadPair(input, deps);
        if ('kind' in current) return current;
        if (current.pullRequest.state === 'open') return { kind: 'internal_failure' };
        return completeTerminalPair(current, applyDirective, deps);
      }
      return completeTerminalPair({ run: pair.run, pullRequest: written }, applyDirective, deps);
    });
  } catch {
    return { kind: 'internal_failure' };
  }
}

// --- Public entry point ---

export async function detectPullRequestMerges(
  input: DetectPullRequestMergesInput,
  deps: PullRequestLifecycleDependencies
): Promise<PullRequestStatusReconciliationResult> {
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
    const after = deps.batchCursor?.get(input.tenant);
    openPrs = await deps.pullRequests.listOpen({ tenant: input.tenant, limit: input.maxCount, ...(after !== undefined ? { after } : {}) });
    if (after !== undefined && openPrs.length < input.maxCount) {
      const first = await deps.pullRequests.listOpen({ tenant: input.tenant, limit: input.maxCount - openPrs.length });
      const seen = new Set(openPrs.map(pr => pr.id));
      openPrs = [...openPrs, ...first.filter(pr => !seen.has(pr.id))];
    }
  } catch {
    // If we cannot even list open PRs we report timedOut=false and zero counts.
    return { checked: 0, merged: 0, closed: 0, failed: 0, timedOut: false };
  }

  for (const pr of openPrs) {
    if (now() >= deadlineMs) {
      timedOut = true;
      break;
    }

    deps.batchCursor?.set(input.tenant, { createdAt: pr.createdAt, id: pr.id });

    // Per-PR error containment: never let one bad PR crash the batch.
    let outcome: PerOutcome;
    try {
      // Quick pre-check: skip terminal/missing runs entirely (don't count).
      const run = await deps.runs.findById(pr.runId);
      if (run === null || run.tenant !== pr.tenant || run.terminal) {
        continue;
      }
      outcome = await reconcileSinglePullRequest(pr, deps, deadlineMs, input.admitCiRepair === true);
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
      case 'read_failed':
      case 'internal_failure':
        failed += 1;
        break;
    }
  }

  return { checked, merged, closed, failed, timedOut };
}
