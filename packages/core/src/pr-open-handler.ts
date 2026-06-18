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
import type { CodeHostCredential, CodeHostPort, CodeHostPullRequestFacts, CodeHostTarget } from './code-host.js';
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
  readonly resolveCredential: (ref: unknown) => Promise<CodeHostCredential>;
  readonly events: RunEventPublisher;
  readonly applyDirective: (input: ApplyOrchestratedDirectiveInput) => Promise<OrchestratedRunResult>;
  readonly clock: () => string;
  readonly runWorkspaceGit: Pick<RunWorkspaceGitPort, 'getChangedFiles'>;
}

// --- Checkpoint shape ---

export interface PullRequestOpenCheckpoint {
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
    baseBranch: 'main'
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
}): CumulativeImplementationSummary {
  const changedFiles = mergeChangedFiles(input.cumulativeSummary.changedFiles, input.diffPaths);
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
  if (topic === null) {
    throw new PullRequestOpenHandlerError('missing_topic', `Topic '${run.topicId}' does not exist.`);
  }
  const conversation = await deps.conversations.findById(topic.conversationId);
  if (conversation === null) {
    throw new PullRequestOpenHandlerError('missing_conversation', `Conversation '${topic.conversationId}' does not exist.`);
  }
  const project = await deps.projects.findById(conversation.projectId);
  if (project === null) {
    throw new PullRequestOpenHandlerError('missing_project', `Project '${conversation.projectId}' does not exist.`);
  }

  const binding = resolveCodeHostBinding(project);
  if (binding === null) {
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

  // 3. Idempotency: if a local PR is already recorded, refresh state from the provider.
  const existingPullRequest = await deps.pullRequests.findByRun(runId);
  if (existingPullRequest !== null && existingPullRequest.state === 'open') {
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
      // Update local state then fail — pr.open cannot proceed against a non-open PR.
      try {
        await deps.pullRequests.updateState({
          runId,
          tenant,
          state: effectiveState,
          updatedAt: deps.clock(),
          expectedState: 'open'
        });
      } catch {
        // Swallow — failing to persist the state change does not change the error we surface.
      }
      throw new PullRequestOpenHandlerError(
        'pull_request_recovery_pr_not_open',
        `Existing pull request for run '${runId}' is no longer open (state='${effectiveState}').`,
        { details: { state: effectiveState, number: existingPullRequest.number, provider: existingPullRequest.provider } }
      );
    }

    const facts = providerFacts ?? {
      provider: existingPullRequest.provider,
      number: existingPullRequest.number,
      url: existingPullRequest.url,
      state: existingPullRequest.state,
      branch: existingPullRequest.branch
    };
    await emitPullRequestOpenedEvent(deps, runId, tenant, {
      url: facts.url,
      provider: facts.provider,
      number: facts.number,
      branch: facts.branch
    });
    return await advanceWithCheckpoint(deps, run, tenant, {
      kind: 'pull_request_open',
      provider: facts.provider,
      number: facts.number,
      url: facts.url,
      branch: facts.branch,
      idempotent: true,
      completedAt: deps.clock()
    });
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
    .reverse()
    .find((s) => s.step === 'pr.finalize' && s.checkpointResult !== null);
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
  const baseRef = workspaceMeta.provisionedBaseRef?.trim() || binding.baseBranch;
  let diffPaths: readonly string[] = [];
  try {
    const diffEntries = await deps.runWorkspaceGit.getChangedFiles({
      workspaceRepoRoot: workspaceMeta.workspaceRepoRoot,
      baseRef
    });
    diffPaths = diffEntries.map((entry) => entry.path);
  } catch (cause) {
    if (cumulativeSummary.cumulativeSummary.trim().length === 0 && cumulativeSummary.changedFiles.length === 0) {
      throw new PullRequestOpenHandlerError(
        'missing_implementation_summary',
        `Unable to recover changed files for run '${runId}'.`,
        { cause: cause instanceof Error ? new Error(cause.message) : undefined }
      );
    }
  }
  const renderableSummary = buildRenderableCumulativeSummary({ cumulativeSummary, diffPaths });

  // 7. Build PR content.
  const content = buildPullRequestContent({
    workKind: run.workKind,
    issueUrl: run.trackedIssue?.url ?? null,
    cumulativeSummary: renderableSummary,
    reconciledSummary: finalize.reconciledSummary,
    titleSubject: finalize.titleSubject
  });

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
    const persisted = await persistPullRequest(deps, runId, run, providerExisting);
    await emitPullRequestOpenedEvent(deps, runId, tenant, {
      url: persisted.url,
      provider: persisted.provider,
      number: persisted.number,
      branch: persisted.branch
    });
    return advanceWithCheckpoint(deps, run, tenant, {
      kind: 'pull_request_open',
      provider: persisted.provider,
      number: persisted.number,
      url: persisted.url,
      branch: persisted.branch,
      idempotent: false,
      completedAt: deps.clock()
    });
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
      const persisted = await persistPullRequest(deps, runId, run, recovered);
      await emitPullRequestOpenedEvent(deps, runId, tenant, {
        url: persisted.url,
        provider: persisted.provider,
        number: persisted.number,
        branch: persisted.branch
      });
      return advanceWithCheckpoint(deps, run, tenant, {
        kind: 'pull_request_open',
        provider: persisted.provider,
        number: persisted.number,
        url: persisted.url,
        branch: persisted.branch,
        idempotent: false,
        completedAt: deps.clock()
      });
    }
    throw new PullRequestOpenHandlerError(
      'pull_request_recovery_unknown_create_outcome',
      'Code-host PR creation failed with an unknown error and no matching open PR was found by branch.',
      { cause: cause instanceof Error ? new Error(cause.name) : undefined }
    );
  }

  // 10. Persist the PR record. On persistence failure, retry findByBranch.
  let persisted: PullRequest;
  try {
    persisted = await deps.pullRequests.create({
      runId,
      owner: run.owner as NonModelPrincipal,
      tenant: run.tenant,
      provider: facts.provider,
      number: facts.number,
      url: facts.url,
      state: facts.state,
      branch: facts.branch
    });
  } catch (persistError) {
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
      try {
        persisted = await deps.pullRequests.create({
          runId,
          owner: run.owner as NonModelPrincipal,
          tenant: run.tenant,
          provider: recovered.provider,
          number: recovered.number,
          url: recovered.url,
          state: recovered.state,
          branch: recovered.branch
        });
      } catch (retryCause) {
        throw new PullRequestOpenHandlerError('persistence_failed', 'Failed to persist pull-request record.', {
          cause: retryCause
        });
      }
    } else {
      throw new PullRequestOpenHandlerError(
        'pull_request_recovery_missing_provider_match',
        'Persistence of the created pull request failed and no matching open PR was found by branch.',
        { cause: persistError }
      );
    }
  }

  // 11. Emit the runner_notification event with safe facts only.
  await emitPullRequestOpenedEvent(deps, runId, tenant, {
    url: persisted.url,
    provider: persisted.provider,
    number: persisted.number,
    branch: persisted.branch
  });

  // 12. Advance to pr.human_review with a checkpoint carrying safe PR facts.
  return advanceWithCheckpoint(deps, run, tenant, {
    kind: 'pull_request_open',
    provider: persisted.provider,
    number: persisted.number,
    url: persisted.url,
    branch: persisted.branch,
    idempotent: false,
    completedAt: deps.clock()
  });
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
