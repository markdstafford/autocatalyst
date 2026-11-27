import { randomUUID } from 'node:crypto';

import type { ClientRunEvent, JsonValue, NonModelPrincipal, PullRequest, Run } from '@autocatalyst/api-contract';

import type {
  ConversationRepository,
  ProjectRepository,
  PullRequestRepository,
  RunRepository,
  RunStepRepository,
  RunWorkspaceMetadataRepository,
  TopicRepository
} from './domain-repositories.js';
import type { CodeHostCredential, CodeHostPort, CodeHostPullRequestFacts, CodeHostTarget, ResolveCodeHostCredential } from './code-host.js';
import { CodeHostError, isCodeHostError } from './code-host.js';
import type { CodeHostRegistry } from './code-host-registry.js';
import type { RunEventPublisher } from './run-events.js';
import { buildPullRequestContent, LEGACY_TEXT_PLACEHOLDER_PATTERN } from './pr-content.js';
import {
  mergeChangedFiles,
  requireCumulativeImplementationSummary,
  summarizeChangedPaths,
  type CumulativeImplementationSummary
} from './implementation-summary.js';
import type { ApplyOrchestratedDirectiveInput, OrchestratedRunResult } from './orchestrator.js';
import type { RunWorkspaceGitPort } from './run-workspace-git.js';
import {
  findPublicationReceipt, initialPullRequestBase, publicationAttestation, publicationEpoch, publicationRefreshLimit,
  resolvePublicationBinding, type PublicationGitPort, type PublicationPushReceipt, type PublicationWorkspace
} from './pr-publication.js';

// --- Error type ---

export type PullRequestOpenHandlerErrorCode =
  | 'missing_run'
  | 'invalid_step'
  | 'terminal_run'
  | 'missing_topic'
  | 'missing_conversation'
  | 'missing_project'
  | 'missing_code_host_setting'
  | 'missing_credential'
  | 'missing_workspace_metadata'
  | 'missing_pr_finalize_checkpoint'
  | 'missing_implementation_summary'
  | 'code_host_error'
  | 'persistence_failed'
  | 'pull_request_recovery_pr_not_open'
  | 'pull_request_recovery_missing_provider_match'
  | 'pull_request_recovery_unknown_create_outcome'
  | 'pull_request_recovery_ambiguous_branch_match';

export interface PullRequestOpenHandlerErrorOptions {
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

export class PullRequestOpenHandlerError extends Error {
  readonly code: PullRequestOpenHandlerErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: PullRequestOpenHandlerErrorCode, message: string, options: PullRequestOpenHandlerErrorOptions = {}) {
    super(message);
    this.name = 'PullRequestOpenHandlerError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

// --- Dependencies ---

export interface PullRequestOpenHandlerDependencies {
  readonly runs: RunRepository;
  readonly conversations: ConversationRepository;
  readonly topics: TopicRepository;
  readonly projects: ProjectRepository;
  readonly pullRequests: PullRequestRepository;
  readonly runSteps: RunStepRepository;
  readonly runWorkspaceMetadata: RunWorkspaceMetadataRepository;
  readonly codeHosts: CodeHostRegistry;
  readonly resolveCredential: ResolveCodeHostCredential;
  readonly events: RunEventPublisher;
  readonly withResultCommit?: (
    commit: (apply: PullRequestOpenHandlerDependencies['applyDirective']) => Promise<OrchestratedRunResult>
  ) => Promise<OrchestratedRunResult>;
  readonly applyDirective: (input: ApplyOrchestratedDirectiveInput) => Promise<OrchestratedRunResult>;
  readonly clock: () => string;
  readonly runWorkspaceGit: Pick<RunWorkspaceGitPort, 'getChangedFiles'>;
  readonly publicationGit?: PublicationGitPort;
  readonly publicationRemoteOverride?: string;
}

// --- Checkpoint shape ---

export interface PullRequestOpenCheckpoint {
  readonly receipt?: PublicationPushReceipt;
  readonly kind: 'pull_request_open';
  readonly provider: string;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly idempotent: boolean;
  readonly completedAt: string;
}

// --- Helpers ---

interface ParsedFinalizeCheckpoint {
  readonly reconciledSummary: string | null;
  readonly titleSubject: string | null;
}

function parseFinalizeCheckpoint(value: unknown): ParsedFinalizeCheckpoint | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { kind?: unknown; reconciledSummary?: unknown; titleSubject?: unknown };
  if (v.kind !== 'pull_request_finalize') return null;
  return {
    reconciledSummary: typeof v.reconciledSummary === 'string' ? v.reconciledSummary : null,
    titleSubject: typeof v.titleSubject === 'string' ? v.titleSubject : null
  };
}

function extractCumulativeSummary(value: unknown): CumulativeImplementationSummary | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { kind?: unknown; cumulativeSummary?: unknown };
  if (v.kind === 'cumulative_implementation_summary') {
    try {
      return requireCumulativeImplementationSummary(value);
    } catch {
      return null;
    }
  }
  // The implementation.build checkpoint may nest the summary under a key.
  if (typeof v.cumulativeSummary === 'object' && v.cumulativeSummary !== null) {
    return extractCumulativeSummary(v.cumulativeSummary);
  }
  return null;
}

interface ProjectCodeHostBinding {
  readonly target: CodeHostTarget;
  readonly credentialRef: unknown;
  readonly baseBranch: string;
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
    credentialRef: project.codeHostSetting.credentialRef,
    // Sensible default until projects carry a configured default branch.
    baseBranch: initialPullRequestBase
  };
}

async function emitPullRequestOpenedEvent(
  deps: PullRequestOpenHandlerDependencies,
  runId: string,
  tenant: string,
  facts: { readonly url: string; readonly provider: string; readonly number: number; readonly branch: string }
): Promise<void> {
  // Construct a runner_notification event carrying only safe PR facts.
  // Failures are swallowed so event emission never blocks the handler.
  try {
    const event: ClientRunEvent = {
      id: `evt_${randomUUID()}`,
      runId,
      step: 'pr.open',
      importance: 'normal',
      createdAt: deps.clock(),
      type: 'runner_notification',
      notification: {
        severity: 'info',
        message: `Pull request #${facts.number} opened: ${facts.url}`
      }
    };
    await deps.events.append({ scope: { runId, tenant }, event });
  } catch {
    // Swallow — event emission must not break the handler.
  }
}

// --- Helpers ---

function buildRenderableCumulativeSummary(input: {
  readonly cumulativeSummary: CumulativeImplementationSummary;
  readonly diffPaths: readonly string[];
  readonly pinnedDiff: boolean;
}): CumulativeImplementationSummary {
  const changedFiles = mergeChangedFiles(input.pinnedDiff ? [] : input.cumulativeSummary.changedFiles, input.diffPaths);
  const fallbackSummary = summarizeChangedPaths(changedFiles);
  const existingSummary = input.cumulativeSummary.cumulativeSummary.trim();
  const isPlaceholder = LEGACY_TEXT_PLACEHOLDER_PATTERN.test(existingSummary);
  return {
    ...input.cumulativeSummary,
    cumulativeSummary: (existingSummary && !isPlaceholder) ? existingSummary : fallbackSummary,
    changedFiles
  };
}

// --- Handler ---

export async function handlePullRequestOpen(
  runId: string,
  tenant: string,
  deps: PullRequestOpenHandlerDependencies
): Promise<OrchestratedRunResult> {
  // 1. Load and validate the run.
  const run = await deps.runs.findById(runId);
  if (run === null) {
    throw new PullRequestOpenHandlerError('missing_run', `Run '${runId}' does not exist.`);
  }
  if (run.tenant !== tenant) {
    throw new PullRequestOpenHandlerError('missing_run', `Run '${runId}' does not belong to tenant.`);
  }
  if (run.terminal) {
    throw new PullRequestOpenHandlerError('terminal_run', `Run '${runId}' is terminal.`);
  }
  if (run.currentStep !== 'pr.open') {
    throw new PullRequestOpenHandlerError(
      'invalid_step',
      `Expected run at 'pr.open', got '${run.currentStep}'.`,
      { details: { currentStep: run.currentStep } }
    );
  }

  // 2. Resolve project chain (needed for both idempotency refresh path and create path).
  const topic = await deps.topics.findById(run.topicId);
  if (topic === null || topic.tenant !== tenant) {
    throw new PullRequestOpenHandlerError('missing_topic', `Topic '${run.topicId}' does not exist.`);
  }
  const conversation = await deps.conversations.findById(topic.conversationId);
  if (conversation === null || conversation.tenant !== tenant) {
    throw new PullRequestOpenHandlerError('missing_conversation', `Conversation '${topic.conversationId}' does not exist.`);
  }
  const project = await deps.projects.findById(conversation.projectId);
  if (project === null || project.tenant !== tenant) {
    throw new PullRequestOpenHandlerError('missing_project', `Project '${conversation.projectId}' does not exist.`);
  }

  const binding = resolveCodeHostBinding(project);
  if (binding === null || project.codeHostSetting?.provider !== project.hostRepository.provider) {
    throw new PullRequestOpenHandlerError(
      'missing_code_host_setting',
      'Project has no code-host setting or credential reference.',
      { details: { projectId: project.id } }
    );
  }

  let credential: CodeHostCredential;
  try {
    credential = await deps.resolveCredential(binding.credentialRef);
  } catch (cause) {
    throw new PullRequestOpenHandlerError('missing_credential', 'Failed to resolve code-host credential.', { cause });
  }

  let codeHostPort: CodeHostPort;
  try {
    codeHostPort = deps.codeHosts.get(binding.target.provider);
  } catch (cause) {
    if (isCodeHostError(cause)) {
      throw new PullRequestOpenHandlerError('code_host_error', `Unsupported code-host provider (${cause.code}).`, {
        cause,
        details: { code: cause.code }
      });
    }
    throw new PullRequestOpenHandlerError('code_host_error', 'Failed to resolve code-host provider.', {
      cause: cause instanceof Error ? new Error(cause.name) : undefined
    });
  }

  const commitResult = deps.withResultCommit ?? ((commit) => commit(deps.applyDirective));
  const commitOpened = (
    getFacts: () => Promise<Pick<PullRequest, 'provider' | 'number' | 'url' | 'branch'>>,
    idempotent: boolean
  ) => commitResult(async (applyDirective) => {
    const facts = await getFacts();
    await emitPullRequestOpenedEvent(deps, runId, tenant, facts);
    return advanceWithCheckpoint({ ...deps, applyDirective }, run, tenant, {
      kind: 'pull_request_open',
      provider: facts.provider,
      number: facts.number,
      url: facts.url,
      branch: facts.branch,
      idempotent,
      completedAt: deps.clock()
    });
  });

  // 3. Idempotency: if a local PR is already recorded, refresh state from the provider.
  const existingPullRequest = await deps.pullRequests.findByRun(runId);
  if (deps.publicationGit === undefined && existingPullRequest !== null && existingPullRequest.state === 'open') {
    let providerFacts: CodeHostPullRequestFacts | null = null;
    try {
      providerFacts = await codeHostPort.read({
        target: binding.target,
        number: existingPullRequest.number,
        credential
      });
    } catch {
      // If the refresh fails, fall through using the local snapshot — the run can
      // still advance to pr.human_review and reconciliation will catch up later.
      providerFacts = null;
    }

    const effectiveState = providerFacts?.state ?? existingPullRequest.state;
    if (effectiveState === 'merged' || effectiveState === 'closed') {
      return commitResult(async (applyDirective) => {
        try {
          await deps.pullRequests.updateState({
            runId, tenant, state: effectiveState, updatedAt: deps.clock(), expectedState: 'open'
          });
        } catch {
          // State refresh is best effort; the PR is not open either way.
        }
        const error = new PullRequestOpenHandlerError(
          'pull_request_recovery_pr_not_open',
          `Existing pull request for run '${runId}' is no longer open (state='${effectiveState}').`,
          { details: { state: effectiveState, number: existingPullRequest.number, provider: existingPullRequest.provider } }
        );
        if (deps.withResultCommit === undefined) throw error;
        return applyDirective({ runId, tenant, directive: 'fail', origin: 'system', reason: `pr_open_${error.code}` });
      });
    }

    const facts = providerFacts ?? {
      provider: existingPullRequest.provider,
      number: existingPullRequest.number,
      url: existingPullRequest.url,
      state: existingPullRequest.state,
      branch: existingPullRequest.branch
    };
    return commitOpened(async () => facts, true);
  }

  // 4. Load workspace metadata for repo root and branch.
  const workspaceMeta = await deps.runWorkspaceMetadata.findByRunId(runId);
  if (workspaceMeta === null) {
    throw new PullRequestOpenHandlerError(
      'missing_workspace_metadata',
      `Run '${runId}' has no workspace metadata.`
    );
  }
  const branch = workspaceMeta.workspaceHandle;

  // 5. Load pr.finalize checkpoint and implementation cumulative summary.
  const runSteps = await deps.runSteps.listByRun(runId);
  const finalizeStep = [...runSteps]
    .sort((a, b) => b.occurrence.index - a.occurrence.index)
    .find((s) => s.step === 'pr.finalize');
  const workspace = deps.publicationGit !== undefined
    ? (await resolvePublicationBinding(run, {
        ...deps, resolveCredential: async () => credential
      })).workspace
    : undefined;
  const guard = workspace !== undefined && deps.publicationGit !== undefined
    ? makePublicationGuard(run, runSteps, workspace, deps.publicationGit, deps, commitResult)
    : undefined;
  if (guard !== undefined) {
    const candidate = publicationAttestation(finalizeStep, guard.workspace);
    // A provider-side create can be recovered independently of target drift, but only with an exact receipt.
    const targetSha = await guard.git.readTarget(guard.workspace);
    let prior: CodeHostPullRequestFacts | null;
    try {
      prior = existingPullRequest === null
      ? await codeHostPort.findByBranch({ target: binding.target, headBranch: branch, baseBranch: binding.baseBranch, credential })
      : await codeHostPort.read({ target: binding.target, number: existingPullRequest.number, credential });
    } catch (cause) {
      if (targetSha === null) return guard.stop('pr_target_verification_failed', 'target_unavailable', candidate, null);
      throw cause;
    }
    if (prior !== null) {
      if (prior.state !== 'open') throw new PullRequestOpenHandlerError('pull_request_recovery_pr_not_open', 'The existing pull request is no longer open.');
      const receipt = prior.headSha !== undefined ? findPublicationReceipt(runSteps, runId, guard.workspace, prior.headSha) : null;
      if (receipt === null || !matchesPublication(prior, guard.workspace, receipt.headSha, binding.target.provider) ||
          (existingPullRequest !== null && prior.number !== existingPullRequest.number)) {
        throw new PullRequestOpenHandlerError('pull_request_recovery_missing_provider_match', 'Existing pull request does not match a verified publication receipt.');
      }
      return guard.advance(async () => existingPullRequest ?? persistPullRequest(deps, runId, run, prior), receipt, true);
    }
    if (targetSha === null) return guard.stop('pr_target_verification_failed', 'target_unavailable', candidate, null);
    if (candidate === null || candidate.targetSha !== targetSha || await guard.git.readCandidate(guard.workspace) !== candidate.publishSha) {
      return guard.refresh(candidate, targetSha);
    }
  }
  if (finalizeStep === undefined) {
    throw new PullRequestOpenHandlerError(
      'missing_pr_finalize_checkpoint',
      `No pr.finalize checkpoint found for run '${runId}'.`
    );
  }
  const finalize = parseFinalizeCheckpoint(finalizeStep.checkpointResult);
  if (finalize === null) {
    throw new PullRequestOpenHandlerError(
      'missing_pr_finalize_checkpoint',
      `pr.finalize checkpoint is malformed for run '${runId}'.`
    );
  }

  let cumulativeSummary: CumulativeImplementationSummary | null = null;
  for (const step of [...runSteps].reverse()) {
    if (step.step === 'implementation.build') {
      const candidate = extractCumulativeSummary(step.checkpointResult);
      if (candidate !== null) {
        cumulativeSummary = candidate;
        break;
      }
    }
  }
  if (cumulativeSummary === null) {
    throw new PullRequestOpenHandlerError(
      'missing_implementation_summary',
      `No cumulative implementation summary found for run '${runId}'.`
    );
  }

  // 6. Recover final branch diff paths and build renderable summary.
  const candidate = workspace === undefined ? null : publicationAttestation(finalizeStep, workspace);
  const baseRef = candidate?.targetSha ?? (workspaceMeta.provisionedBaseRef?.trim() || binding.baseBranch);
  let diffPaths: readonly string[] = [];
  try {
    const diffEntries = await deps.runWorkspaceGit.getChangedFiles({
      workspaceRepoRoot: workspaceMeta.workspaceRepoRoot,
      baseRef,
      ...(candidate !== null ? { headRef: candidate.publishSha } : {})
    });
    diffPaths = diffEntries.map((entry) => entry.path);
  } catch (cause) {
    if (candidate !== null || (cumulativeSummary.cumulativeSummary.trim().length === 0 && cumulativeSummary.changedFiles.length === 0)) {
      throw new PullRequestOpenHandlerError(
        'missing_implementation_summary',
        `Unable to recover changed files for run '${runId}'.`,
        { cause: cause instanceof Error ? new Error(cause.message) : undefined }
      );
    }
  }
  const renderableSummary = buildRenderableCumulativeSummary({ cumulativeSummary, diffPaths, pinnedDiff: candidate !== null });

  // 7. Build PR content.
  const content = buildPullRequestContent({
    workKind: run.workKind,
    issueUrl: run.trackedIssue?.url ?? null,
    cumulativeSummary: renderableSummary,
    reconciledSummary: finalize.reconciledSummary,
    titleSubject: finalize.titleSubject
  });

  if (guard !== undefined && candidate !== null) {
    const currentTarget = await guard.git.readTarget(guard.workspace);
    if (currentTarget === null) return guard.stop('pr_target_verification_failed', 'target_unavailable', candidate, null);
    if (currentTarget !== candidate.targetSha || await guard.git.readCandidate(guard.workspace) !== candidate.publishSha) {
      return guard.refresh(candidate, currentTarget);
    }
    const pushed = await guard.git.pushCandidate(guard.workspace, candidate.publishSha);
    let receipt = findPublicationReceipt(runSteps, runId, guard.workspace, candidate.publishSha);
    if (pushed === 'pushed') {
      receipt = {
        kind: 'publication_push_receipt', runId, repository: guard.workspace.repository,
        branch, headSha: candidate.publishSha
      };
      // A cancellation may have closed this occurrence during the push.
      const checkpoint = { kind: 'publication_pushed', receipt };
      const writeReceipt = () => deps.runSteps.updateCheckpoint({
        runId, tenant, runStepId: guard.stepId, checkpointResult: checkpoint
      });
      if (deps.withResultCommit === undefined) {
        await writeReceipt();
      } else {
        await deps.withResultCommit(async () => {
          const runStep = await writeReceipt();
          return { run, runStep };
        });
      }
    }
    if (pushed === 'unverified' || receipt === null) {
      return guard.stop('pr_publication_push_unverified', 'push_unverified', candidate, currentTarget, receipt);
    }
    const targetAfterPush = await guard.git.readTarget(guard.workspace);
    if (targetAfterPush === null) return guard.stop('pr_target_verification_failed', 'target_unavailable', candidate, null, receipt);
    if (targetAfterPush !== candidate.targetSha || await guard.git.readCandidate(guard.workspace) !== candidate.publishSha) {
      return guard.refresh(candidate, targetAfterPush, receipt);
    }
    if (await guard.git.readSource(guard.workspace) !== candidate.publishSha) {
      return guard.stop('pr_publication_push_unverified', 'push_unverified', candidate, targetAfterPush, receipt);
    }

    let facts: CodeHostPullRequestFacts | null;
    try {
      facts = await codeHostPort.create({
        target: binding.target, workspaceRepoRoot: workspaceMeta.workspaceRepoRoot, branch,
        baseBranch: binding.baseBranch, content, credential, branchAlreadyPushed: true
      });
    } catch (error) {
      facts = await codeHostPort.findByBranch({ target: binding.target, headBranch: branch, baseBranch: binding.baseBranch, credential }).catch(() => null);
      if (facts === null) throw error;
    }
    if (!matchesPublication(facts, guard.workspace, receipt.headSha, binding.target.provider)) {
      throw new PullRequestOpenHandlerError('pull_request_recovery_missing_provider_match', 'Provider pull request does not match the published candidate.');
    }
    const opened = facts;
    return guard.advance(() => persistPullRequest(deps, runId, run, opened), receipt, false);
  }

  // 8. findByBranch recovery decision table (before create).
  let providerExisting: CodeHostPullRequestFacts | null = null;
  try {
    providerExisting = await codeHostPort.findByBranch({
      target: binding.target,
      headBranch: branch,
      baseBranch: binding.baseBranch,
      credential
    });
  } catch (cause) {
    if (isCodeHostError(cause) && cause.code === 'ambiguous_branch_match') {
      throw new PullRequestOpenHandlerError(
        'pull_request_recovery_ambiguous_branch_match',
        'Multiple open pull requests match the branch; cannot recover deterministically.',
        { cause, details: { code: cause.code, ...cause.safeDetails } }
      );
    }
    if (isCodeHostError(cause)) {
      throw new PullRequestOpenHandlerError('code_host_error', `Code-host findByBranch failed (${cause.code}).`, {
        cause,
        details: { code: cause.code, ...cause.safeDetails }
      });
    }
    throw new PullRequestOpenHandlerError('code_host_error', 'Code-host findByBranch failed.', {
      cause: cause instanceof Error ? new Error(cause.name) : undefined
    });
  }

  if (providerExisting !== null) {
    if (providerExisting.state === 'merged' || providerExisting.state === 'closed') {
      throw new PullRequestOpenHandlerError(
        'pull_request_recovery_pr_not_open',
        `Branch '${branch}' already has a non-open pull request (state='${providerExisting.state}').`,
        { details: { state: providerExisting.state, number: providerExisting.number, provider: providerExisting.provider } }
      );
    }
    // Open PR found on provider but not yet persisted locally: reuse it.
    return commitOpened(() => persistPullRequest(deps, runId, run, providerExisting), false);
  }

  // 9. Create the PR via the code-host port.
  let facts: CodeHostPullRequestFacts;
  try {
    facts = await codeHostPort.create({
      target: binding.target,
      workspaceRepoRoot: workspaceMeta.workspaceRepoRoot,
      branch,
      baseBranch: binding.baseBranch,
      content,
      credential
    });
  } catch (cause) {
    if (isCodeHostError(cause)) {
      // CodeHostError from create is a clear failure — surface directly without recovery.
      throw new PullRequestOpenHandlerError('code_host_error', `Code-host PR creation failed (${cause.code}).`, {
        cause,
        details: { code: cause.code, ...cause.safeDetails }
      });
    }
    // Unknown error from create: try findByBranch to recover.
    let recovered: CodeHostPullRequestFacts | null = null;
    try {
      recovered = await codeHostPort.findByBranch({
        target: binding.target,
        headBranch: branch,
        baseBranch: binding.baseBranch,
        credential
      });
    } catch {
      recovered = null;
    }
    if (recovered !== null && recovered.state === 'open') {
      const existing = recovered;
      return commitOpened(() => persistPullRequest(deps, runId, run, existing), false);
    }
    throw new PullRequestOpenHandlerError(
      'pull_request_recovery_unknown_create_outcome',
      'Code-host PR creation failed with an unknown error and no matching open PR was found by branch.',
      { cause: cause instanceof Error ? new Error(cause.name) : undefined }
    );
  }

  // Persist and advance together. A local persistence error can trigger a remote
  // lookup, but that lookup must happen after releasing the result-commit lock.
  try {
    return await commitOpened(() => persistPullRequest(deps, runId, run, facts), false);
  } catch (persistError) {
    if (!(persistError instanceof PullRequestOpenHandlerError) || persistError.code !== 'persistence_failed') throw persistError;
    let recovered: CodeHostPullRequestFacts | null = null;
    try {
      recovered = await codeHostPort.findByBranch({
        target: binding.target,
        headBranch: branch,
        baseBranch: binding.baseBranch,
        credential
      });
    } catch {
      recovered = null;
    }
    if (recovered !== null && recovered.state === 'open') {
      const existing = recovered;
      return commitOpened(() => persistPullRequest(deps, runId, run, existing), false);
    }
    throw new PullRequestOpenHandlerError(
      'pull_request_recovery_missing_provider_match',
      'Persistence of the created pull request failed and no matching open PR was found by branch.',
      { cause: persistError.cause }
    );
  }
}

function matchesPublication(facts: CodeHostPullRequestFacts, workspace: PublicationWorkspace, headSha: string, provider: string): boolean {
  if (facts.provider !== provider || facts.state !== 'open' || facts.branch !== workspace.branch || facts.baseBranch !== workspace.base ||
      facts.headSha !== headSha || facts.headRepository?.toLowerCase() !== workspace.repository.toLowerCase() ||
      !Number.isSafeInteger(facts.number) || facts.number < 1) return false;
  if (provider !== 'github') return false;
  return facts.url.toLowerCase() === `https://github.com/${workspace.repository}/pull/${facts.number}`.toLowerCase();
}

function makePublicationGuard(
  run: Run, steps: readonly import('@autocatalyst/api-contract').RunStep[], workspace: PublicationWorkspace,
  git: PublicationGitPort, deps: PullRequestOpenHandlerDependencies,
  commitResult: NonNullable<PullRequestOpenHandlerDependencies['withResultCommit']>
) {
  const current = steps.find(step => step.step === 'pr.open' && step.endedAt === null);
  if (current === undefined) throw new PullRequestOpenHandlerError('invalid_step', 'Missing current publication occurrence.');
  const epoch = publicationEpoch(steps);
  const stop = (
    code: string, safeReason: string, candidate: ReturnType<typeof publicationAttestation>,
    observedTargetSha: string | null, receipt: PublicationPushReceipt | null = null
  ) => deps.applyDirective({
    runId: run.id, tenant: run.tenant, expectedStepId: current.id, origin: 'system',
    ...(code === 'pr_publication_refreshed'
      ? { directive: 'revise', refreshPublication: true }
      : { directive: 'fail', reason: code }),
    checkpointResult: {
      kind: 'publication_stop', code, safeReason, timestamp: deps.clock(), base: workspace.base,
      repository: workspace.repository, branch: workspace.branch, reviewedSha: candidate?.reviewedSha ?? null,
      targetSha: candidate?.targetSha ?? null, observedTargetSha, publishSha: candidate?.publishSha ?? null,
      refreshCount: epoch.count + (code === 'pr_publication_refreshed' ? 1 : 0),
      sourcePushed: epoch.sourcePushed || receipt !== null,
      ...(receipt !== null ? { receipt } : {})
    }
  });
  return {
    stepId: current.id, workspace, git, stop,
    refresh: (candidate: ReturnType<typeof publicationAttestation>, observed: string, receipt?: PublicationPushReceipt) =>
      stop(epoch.count < publicationRefreshLimit ? 'pr_publication_refreshed' : 'pr_publication_refresh_exhausted',
        candidate === null ? 'attestation_missing' : candidate.targetSha !== observed ? 'target_changed' : 'candidate_changed',
        candidate, observed, receipt),
    advance(getPullRequest: () => Promise<PullRequest>, receipt: PublicationPushReceipt, idempotent: boolean) {
      return commitResult(async (applyDirective) => {
        const pr = await getPullRequest();
        await emitPullRequestOpenedEvent(deps, run.id, run.tenant, pr);
        return applyDirective({
          runId: run.id, tenant: run.tenant, expectedStepId: current.id, origin: 'system', directive: 'advance',
          publicationProvenance: { pullRequestId: pr.id, headSha: receipt.headSha },
          checkpointResult: {
            kind: 'pull_request_open', provider: pr.provider, number: pr.number, url: pr.url,
            branch: pr.branch, idempotent, completedAt: deps.clock(), receipt
          }
        });
      });
    }
  };
}

async function persistPullRequest(
  deps: PullRequestOpenHandlerDependencies,
  runId: string,
  run: Run,
  facts: CodeHostPullRequestFacts
): Promise<PullRequest> {
  try {
    return await deps.pullRequests.create({
      runId,
      owner: run.owner as NonModelPrincipal,
      tenant: run.tenant,
      provider: facts.provider,
      number: facts.number,
      url: facts.url,
      state: facts.state,
      branch: facts.branch
    });
  } catch (cause) {
    throw new PullRequestOpenHandlerError('persistence_failed', 'Failed to persist pull-request record.', { cause });
  }
}

async function advanceWithCheckpoint(
  deps: PullRequestOpenHandlerDependencies,
  _run: Run,
  tenant: string,
  checkpoint: PullRequestOpenCheckpoint
): Promise<OrchestratedRunResult> {
  return deps.applyDirective({
    runId: _run.id,
    tenant,
    directive: 'advance',
    origin: 'system',
    checkpointResult: checkpoint as unknown as JsonValue
  });
}

// Re-export the CodeHostError surface so callers can match on safe error codes.
export { CodeHostError };
