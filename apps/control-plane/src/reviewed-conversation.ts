import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  claudeAgentAdapterId, claudeProviderKind, claudeSubscriptionAdapterId, readClaudeLaunchBuild
} from '@autocatalyst/claude-agent-adapter';
import { codexAgentAdapterId, codexBusinessAdapterId, codexProviderKind } from '@autocatalyst/codex-agent-adapter';
import { implementerDispositionsResultSchema } from '@autocatalyst/api-contract';
import type { ReviewedAttemptPort, RunRoleWorkInput } from '@autocatalyst/core';
import { abortable, type MaterializedExecutionEnvironment, type NativeConversationTurn, type NativeResumeRefusalReason, type ResolvedAgentRunnerProfile } from '@autocatalyst/execution';
import type {
  ConversationBinding, ConversationClaim, DrizzleAgentConversationRepository, ReviewedDispatchAttempt
} from '@autocatalyst/persistence';

import { reviewedLiveRunKey, type LiveAdmissionReason, type ReviewedLiveConversations } from './reviewed-live-conversations.js';

const exec = promisify(execFile);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, entry: unknown) => {
  if (!entry || Array.isArray(entry) || typeof entry !== 'object') return entry;
  return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1));
})).digest('hex');

export interface RetentionBuild {
  readonly provider: 'codex' | 'claude';
  readonly adapterBuild: string;
  readonly nativeBuild: string;
  readonly confinementBuild: string;
  readonly authMode: string;
}

/** Release-owned. Add exact entries only after the native and custody qualification. */
const releaseRetentionBuilds: readonly RetentionBuild[] = Object.freeze([]);
/** Independent of retention; an unverified launcher uses the shipped fresh path. */
const releaseNonPersistentClaudeBuilds: ReadonlySet<string> = new Set([
  'subscription:0.3.177:2.1.328:darwin:arm64'
]);

export type PrepareFreshConversation = (
  environment: MaterializedExecutionEnvironment, profile?: ResolvedAgentRunnerProfile
) => Promise<Extract<NativeConversationTurn, { mode: 'fresh_only' }>>;

export function createFreshConversationResolver(
  verifiedBuilds: ReadonlySet<string> = releaseNonPersistentClaudeBuilds,
  readBuild = readClaudeLaunchBuild
): PrepareFreshConversation {
  return async (environment, profile) => {
    const authentication = profile?.providerKind === claudeProviderKind
      ? profile.adapterId === claudeSubscriptionAdapterId ? 'subscription'
        : profile.adapterId === claudeAgentAdapterId ? 'api_key' : undefined
      : undefined;
    const build = authentication && verifiedBuilds.size > 0
      ? await readBuild(authentication, environment.environment.variables)
      : undefined;
    return { mode: 'fresh_only', verifiedNonPersistence: build !== undefined && verifiedBuilds.has(build) };
  };
}

export function admitsReviewedLiveConversation(
  profile: ResolvedAgentRunnerProfile, fresh: Awaited<ReturnType<PrepareFreshConversation>>
): boolean {
  return (profile.providerKind === codexProviderKind &&
    (profile.adapterId === codexBusinessAdapterId || profile.adapterId === codexAgentAdapterId)) ||
    (profile.providerKind === claudeProviderKind &&
      profile.adapterId === claudeSubscriptionAdapterId && fresh.verifiedNonPersistence);
}

export function allowsRetention(build: RetentionBuild, entries = releaseRetentionBuilds): boolean {
  return entries.some(entry => hash(entry) === hash(build));
}

export function reviewedScopeDigest(input: {
  readonly workflow: unknown;
  readonly workItemId: string;
  readonly step: ReviewedDispatchAttempt['step'];
  readonly role: ReviewedDispatchAttempt['role'];
  readonly deliverable: readonly string[];
}): string | undefined {
  if (!input.workflow || !input.workItemId.trim() || !input.deliverable.length || input.deliverable.some(v => !v.trim())) return undefined;
  const roleContracts = {
    'spec.author': { implementer: 'reviewed-spec-author.v1', reviewer: 'reviewed-spec-reviewer.v1' },
    'implementation.build': { implementer: 'reviewed-build-implementer.v1', reviewer: 'reviewed-build-reviewer.v1' }
  } as const;
  return hash({ ...input, contract: roleContracts[input.step][input.role] });
}

function strictlyInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

type WorkspaceProofInput = Pick<MaterializedExecutionEnvironment, 'workspace'> & {
  readonly context: { readonly run: { readonly id: string } };
};

/** This is workspace-instance proof, not proof of native transcript confinement. */
export async function reviewedWorkspaceProof(
  environment: WorkspaceProofInput, workspacesRoot: string, hostRepository?: string
): Promise<string | null> {
  const ws = environment.workspace;
  if (ws.shape !== 'two_roots') return null;
  try {
    const runRoot = dirname(ws.repoRoot);
    if (basename(ws.repoRoot) !== 'repo' || ws.scratchRoot !== join(runRoot, 'scratch') ||
        basename(runRoot) !== environment.context.run.id) return null;
    const [base, parent, repo, scratch] = await Promise.all(
      [workspacesRoot, runRoot, ws.repoRoot, ws.scratchRoot].map(path => realpath(path))
    );
    if (!base || !parent || !repo || !scratch || !strictlyInside(base, parent) ||
        repo !== join(parent, 'repo') || scratch !== join(parent, 'scratch')) return null;
    const identity = async (path: string) => {
      const s = await lstat(path, { bigint: true });
      if (!s.isDirectory() || (process.getuid && s.uid !== BigInt(process.getuid()))) throw new Error('workspace ownership mismatch');
      if (s.birthtimeNs <= 0n) throw new Error('workspace instance unavailable');
      return [s.dev, s.ino, s.birthtimeNs].map(String);
    };
    const before = await Promise.all([runRoot, ws.repoRoot, ws.scratchRoot].map(identity));
    const git = async (...args: string[]) => (await exec('git', args, {
      cwd: repo, env: { PATH: process.env['PATH'], GIT_TERMINAL_PROMPT: '0' }, timeout: 5000
    })).stdout.trim();
    const [top, branch, admin, common] = await Promise.all([
      git('rev-parse', '--show-toplevel'), git('symbolic-ref', '-q', 'HEAD'),
      git('rev-parse', '--absolute-git-dir'), git('rev-parse', '--path-format=absolute', '--git-common-dir')
    ]);
    if (hostRepository) {
      const expectedGitDir = await realpath(join(hostRepository, '.git'));
      if (await realpath(common) !== expectedGitDir) return null;
    }
    if (top !== repo || branch !== `refs/heads/${ws.branchName}` || !strictlyInside(join(common, 'worktrees'), admin) ||
        await realpath(admin) !== admin) return null;
    if (await realpath((await readFile(join(admin, 'gitdir'), 'utf8')).trim()) !== join(repo, '.git')) return null;
    const after = await Promise.all([runRoot, ws.repoRoot, ws.scratchRoot].map(identity));
    return hash(before) === hash(after) ? hash({ repo, scratch, admin, branch, instances: before }) : null;
  } catch {
    return null;
  }
}

export interface VerifiedLaunch {
  readonly build: RetentionBuild;
  readonly authenticatedBinding: string;
  readonly credentialRevision: string;
  readonly storageNamespace: string;
  /** The host must assign and supervise a private scope before returning a retained launch. */
  open(resume?: ConversationClaim['resume']): Promise<{
    readonly storageScope: string;
    readonly native: Omit<Extract<NativeConversationTurn, { mode: 'retained' }>, 'mode' | 'resumeId' | 'completed'>;
    /** Production must establish writer exit and release the home before publication. */
    finish?(): Promise<boolean>;
  } | undefined>;
  reconcile?(): Promise<void>;
}

type ReuseEvidence = {
  readonly decision: 'fresh' | 'resume_selected' | 'resume_submitted' | 'fresh_submitted' | 'refused';
  readonly reason: LiveAdmissionReason | NativeResumeRefusalReason | 'fallback' | 'ineligible' | 'pr_unverified' | 'retained';
  readonly conversationId: string;
  readonly fallbackFrom?: string;
};

const isCanonicalSpecPath = (path: string | undefined): path is string =>
  Boolean(path && /^context-human\/specs\/(?!\.\.?\/)[^/]+\.md$/u.test(path));

export function createReviewedAttemptPort(input: {
  readonly repository: DrizzleAgentConversationRepository;
  readonly roleInput: RunRoleWorkInput;
  readonly workspacesRoot?: string;
  readonly repositoryIdentity?: string;
  readonly hostRepository?: string;
  readonly freshHandoff: string;
  /** Internal qualification seam; server composition does not accept overrides. */
  readonly admit?: (environment: MaterializedExecutionEnvironment, generation: string, profile: ResolvedAgentRunnerProfile) => Promise<VerifiedLaunch | undefined>;
  readonly reconcileWorkspace?: (environment: MaterializedExecutionEnvironment, generation: string) => Promise<void>;
  readonly prepareFreshConversation?: PrepareFreshConversation;
  readonly live?: ReviewedLiveConversations;
  readonly recordReuse?: (attempt: ReviewedDispatchAttempt, evidence: ReuseEvidence) => void;
  readonly admitsLive?: (profile: ResolvedAgentRunnerProfile, fresh: Awaited<ReturnType<PrepareFreshConversation>>) => boolean;
  readonly benchmarkArm?: 'A' | 'B';
  readonly qualifiedBuild?: (build: RetentionBuild) => boolean;
}): ReviewedAttemptPort | undefined {
  const roleInput = input.roleInput;
  const occurrence = roleInput.reviewedOccurrence;
  const step = roleInput.run.currentStep;
  if (!occurrence || (step !== 'spec.author' && step !== 'implementation.build') ||
      (step === 'spec.author' && !roleInput.specReview)) return undefined;
  const prepareFreshConversation = input.prepareFreshConversation ?? createFreshConversationResolver();
  let prepared: ReviewedDispatchAttempt | undefined;
  let evidence: ReuseEvidence | undefined;
  let deferredLaunch: Parameters<NonNullable<ReviewedAttemptPort['launched']>>[1] | undefined;
  let submitted = false;
  const record = (attempt: ReviewedDispatchAttempt, value: ReuseEvidence) => {
    try { input.recordReuse?.(attempt, value); } catch { /* Diagnostics cannot affect execution. */ }
  };
  let active: { attempt: ReviewedDispatchAttempt; claim: ConversationClaim; handle?: string; storageScope?: string;
    opened?: Awaited<ReturnType<VerifiedLaunch['open']>>; launch: VerifiedLaunch } | undefined;

  let live: { attemptId: string; finish(accepted: boolean, path?: string): void; verifyWorkspace(): Promise<boolean> } | undefined;

  async function assertOwner() {
    if (occurrence?.stillOwns && !await occurrence.stillOwns()) throw new Error('reviewed_dispatch_not_owned');
  }

  function hasRequiredDispositions(checkpoint: unknown): boolean {
    const required = roleInput.reviewContext?.requiredDispositions?.map(item => item.feedbackId) ?? [];
    const result = required.length ? implementerDispositionsResultSchema.safeParse(checkpoint) : undefined;
    const dispositions = result?.success ? result.data.dispositions ?? [] : [];
    return required.every(id => dispositions.filter(item => item.feedbackId === id).length === 1);
  }

  return {
    freshHandoff: input.freshHandoff,
    async prepare({ attemptId, environment, fallback, fallbackFrom, profile }) {
      await assertOwner();
      const fresh = await prepareFreshConversation(environment, profile);
      const nativeProvider = profile?.providerKind === 'codex' || profile?.providerKind === 'anthropic';
      if (input.benchmarkArm === 'B') {
        if (!fresh.verifiedNonPersistence && profile?.providerKind !== 'codex') {
          throw new Error('benchmark_native_non_persistence_unverified');
        }
        return fresh;
      }
      const attempt: ReviewedDispatchAttempt = {
        id: attemptId, tenant: roleInput.tenant, runId: roleInput.runId, step, role: roleInput.role,
        occurrenceId: occurrence.id, round: roleInput.round
      };
      const liveScope = hash([attempt.tenant, attempt.runId, step, attempt.role]);
      const liveRun = reviewedLiveRunKey(attempt.tenant, attempt.runId);
      const specAuthor = step === 'spec.author' && attempt.role === 'implementer';
      let openLive: (() => ReturnType<ReviewedLiveConversations['open']>) | undefined;
      let verifyWorkspace: (() => Promise<boolean>) | undefined;
      let reason: ReuseEvidence['reason'] = fallback ? 'fallback' : 'ineligible';
      let conversationId: string = randomUUID();
      const ws = environment.workspace;
      let binding: ConversationBinding | undefined;
      let launch: VerifiedLaunch | undefined;
      let workspaceProof: string | null = null;
      let workspaceGeneration: string | null = null;
      const choose = (decision: ReuseEvidence['decision']) => {
        evidence = { decision, reason, conversationId, ...(fallbackFrom ? { fallbackFrom } : {}) };
        record(attempt, evidence);
      };
      if (ws.shape === 'two_roots' && input.workspacesRoot) {
        const proof = await reviewedWorkspaceProof(environment, input.workspacesRoot, input.hostRepository);
        workspaceProof = proof;
        await assertOwner();
        let generation: string | null = null;
        try {
          generation = input.repository.enroll({
            tenant: attempt.tenant, runId: attempt.runId, root: ws.repoRoot, branch: ws.branchName, proof
          });
        } catch { /* Workspace ownership is independent of continuity storage. */ }
        workspaceGeneration = generation;

        input.live?.retireRun(liveRun, 'workspace_changed', generation ?? undefined);
        if ((!proof || !generation) && !fallback) reason = 'workspace_unverified';

        const pr = roleInput.ciRepair?.prBinding;
        const specPath = roleInput.specReview?.canonicalPath;
        const deliverable = step === 'spec.author'
          ? isCanonicalSpecPath(specPath) ? [specPath] : []
          : input.repositoryIdentity ? [input.repositoryIdentity, ws.branchName] : [];
        const scopeInput = { workflow: occurrence.workflow, workItemId: roleInput.run.topicId, step: attempt.step, role: roleInput.role };
        const scopeDigest = reviewedScopeDigest({ ...scopeInput, deliverable });
        // For live spec custody the path is a separate, host-bound field. An unbound author
        // can open a provisional lease, but only core can settle it with an accepted path.
        const liveDigest = step === 'spec.author'
          ? (isCanonicalSpecPath(specPath) || (specPath === undefined && specAuthor)) &&
            reviewedScopeDigest({ ...scopeInput, deliverable: ['spec_authoring'] })
          : scopeDigest;
        const repairBound = !roleInput.ciRepair || (occurrence.stillOwns && pr && input.repositoryIdentity &&
          pr.repository === input.repositoryIdentity && pr.branch === ws.branchName && pr.id && Number.isInteger(pr.number) && pr.number > 0);
        if (!fallback && !repairBound && generation) reason = 'pr_unverified';
        const prIdentity = pr && repairBound ? JSON.stringify([pr.repository, pr.id, pr.number, pr.branch]) : undefined;
        if (profile && generation && proof && liveDigest && repairBound && (!specAuthor || roleInput.deferSpecAuthorConversation) &&
            !fallback && input.live && input.admitsLive?.(profile, fresh)) {
          const compatibility = hash({
            generation, scopeDigest: liveDigest, profile, proof,
            toolPolicy: environment.toolPolicy, capabilities: environment.capabilities, skills: environment.skills,
            protectedHistoryRoots: fresh.protectedHistoryRoots
          });
          const { workspacesRoot, hostRepository, repository } = input;
          const proofTarget = { context: { run: { id: attempt.runId } }, workspace: ws };
          const proveCurrent = async () => Boolean(workspacesRoot &&
            await reviewedWorkspaceProof(proofTarget, workspacesRoot, hostRepository) === proof &&
            repository.readyWorkspaceScopes({
              tenant: attempt.tenant, runId: attempt.runId, root: ws.repoRoot, branch: ws.branchName
            })?.generation === generation);
          verifyWorkspace = proveCurrent;
          openLive = () => input.live!.open({
            key: liveScope, run: liveRun, generation, compatibility, ...(specPath ? { specPath } : {}),
            ...(prIdentity ? { prIdentity } : {}), verifyWorkspace: proveCurrent,
            async verifyLaunch() {
              await assertOwner();
              const valid = await proveCurrent();
              await assertOwner();
              return valid;
            }
          });
        }
        if (profile && generation && scopeDigest && repairBound) {
          const candidate = await input.admit?.(environment, generation, profile).catch(() => undefined);
          const provider = profile.providerKind === 'anthropic' ? 'claude' : profile.providerKind;
          if (candidate && candidate.build.provider === provider && candidate.authenticatedBinding.trim() &&
              candidate.credentialRevision.trim() && candidate.storageNamespace.trim() &&
              (input.qualifiedBuild ?? allowsRetention)(candidate.build)) {
            launch = candidate;
            binding = { generation, scopeDigest,
              compatibilityDigest: hash({
                build: candidate.build, account: candidate.authenticatedBinding, credentialRevision: candidate.credentialRevision,
                storageNamespace: candidate.storageNamespace, proof, adapterId: profile.adapterId, model: profile.model,
                inference: profile.inferenceSettings, endpoint: profile.endpoint, toolPolicy: environment.toolPolicy,
                capabilities: environment.capabilities, skills: environment.skills
              }),
              prIdentity: prIdentity ?? null };
          }
        }
      } else if (input.live) {
        input.live.retireRun(liveRun, 'workspace_changed');
        if (!fallback) reason = 'workspace_unverified';
      }
      await assertOwner();
      let claim: ConversationClaim | undefined;
      try {
        claim = input.repository.begin(attempt, binding, fallback ? 'fallback' : undefined);
        prepared = attempt;
        submitted = false;
        deferredLaunch = undefined;
      }
      catch (error) {
        if (error instanceof Error && error.message === 'reviewed_dispatch_not_owned') throw error;
        input.live?.discard(liveScope);
        choose('fresh');
        return nativeProvider ? fresh : undefined;
      }
      if (!openLive || (claim && launch)) input.live?.discard(liveScope);
      if (!claim || !launch) {
        if (workspaceGeneration) {
          await assertOwner();
          await input.reconcileWorkspace?.(environment, workspaceGeneration).catch(() => undefined);
        }
        await assertOwner();
        const opened = openLive?.();
        reason = opened?.reason ?? reason;
        if (opened?.turn && verifyWorkspace) {
          conversationId = opened.id;
          live = { attemptId, finish: opened.finish, verifyWorkspace };
          const resumed = Boolean(opened.turn.resource);
          choose(resumed ? 'resume_selected' : 'fresh');
          return {
            ...opened.turn, ...(fresh.protectedHistoryRoots ? { protectedHistoryRoots: fresh.protectedHistoryRoots } : {}),
            submitting() {
              opened.turn.submitting?.();
              if (submitted || prepared?.id !== attemptId) return;
              submitted = true;
              if (deferredLaunch) {
                try { input.repository.markLaunched(attempt, deferredLaunch); } catch { /* best effort */ }
              }
              choose(resumed ? 'resume_submitted' : 'fresh_submitted');
            }
          };
        }
        choose('fresh');
        return nativeProvider ? fresh : undefined;
      }
      reason = 'retained';
      choose(claim.resume ? 'resume_selected' : 'fresh');
      active = { attempt, claim, launch };
      const opened = await launch.open(claim.resume).catch(() => undefined);
      if (opened) active.opened = opened;
      await assertOwner();
      const hasRoot = claim.resume && launch.build.provider === 'claude'
        ? ws.shape === 'two_roots' && await opened?.native.lookupRootSession?.(claim.resume.handle, ws.scratchRoot).catch(() => false)
        : true;
      if (!opened || !hasRoot || !await opened.native.verifyLaunch().catch(() => false) ||
          (claim.resume && opened.storageScope !== claim.resume.storageScope)) {
        try {
          input.repository.finish(attempt, claim);
          input.repository.markFreshAfterPreflight(attempt);
        } catch { /* In-flight history is not selectable. */ }
        await opened?.finish?.().catch(() => false);
        await launch.reconcile?.().catch(() => undefined);
        active = undefined;
        return fresh;
      }
      await assertOwner();
      active.storageScope = opened.storageScope;
      return {
        ...opened.native, mode: 'retained', ...(claim.resume ? { resumeId: claim.resume.handle } : {}),
        async verifyLaunch() {
          await assertOwner();
          return Boolean(input.workspacesRoot && workspaceProof &&
            await reviewedWorkspaceProof(environment, input.workspacesRoot, input.hostRepository) === workspaceProof &&
            await opened.native.verifyLaunch());
        },
        completed(handle) { if (active?.attempt.id === attemptId) active.handle = handle; }
      };
    },
    launched(attemptId, launch) {
      if (prepared?.id === attemptId) {
        if (live?.attemptId === attemptId && !submitted) {
          deferredLaunch = launch;
          return;
        }
        try { input.repository.markLaunched(prepared, launch); }
        catch { /* Recording continuity metadata must not stop an otherwise valid invocation. */ }
      }
    },
    async finish({ attemptId, accepted, checkpoint, beforeLaunch, refusal, signal }) {
      if (prepared?.id === attemptId) {
        if (refusal && evidence) record(prepared, { ...evidence, decision: 'refused', reason: refusal });
        if (beforeLaunch) {
          try { input.repository.markFreshAfterPreflight(prepared); } catch { /* best effort */ }
        }
        prepared = undefined;
        evidence = undefined;
      }
      if (live?.attemptId === attemptId) {
        const pending = live;
        live = undefined;
        const specAuthor = step === 'spec.author' && roleInput.role === 'implementer';
        const settle = async (path?: string) => {
          try {
            const compatiblePath = !specAuthor || (isCanonicalSpecPath(path) &&
              (roleInput.specReview?.canonicalPath === undefined || roleInput.specReview.canonicalPath === path));
            pending.finish(accepted && compatiblePath && !signal?.aborted && hasRequiredDispositions(checkpoint) &&
              await pending.verifyWorkspace() && (!occurrence.stillOwns || await occurrence.stillOwns()) && !signal?.aborted, path);
          } catch { /* Disposal is safer than retaining unverified custody. */ }
          finally { pending.finish(false); }
        };
        if (specAuthor && accepted && roleInput.deferSpecAuthorConversation) roleInput.deferSpecAuthorConversation(settle);
        else await settle();
      }
      if (active?.attempt.id !== attemptId) return;
      const { attempt, claim, handle, storageScope, opened, launch } = active;
      active = undefined;
      const releaseWriter = opened?.finish ? Promise.resolve().then(() => opened.finish!()).catch(() => false) : undefined;
      const writerReleased = !releaseWriter || await abortable(signal, () => releaseWriter).catch(() => false);
      if (signal?.aborted) {
        input.repository.finish(attempt, claim);
        return;
      }
      const owned = !occurrence.stillOwns || await occurrence.stillOwns();
      const validDispositions = hasRequiredDispositions(checkpoint);
      input.repository.finish(attempt, claim, accepted && !signal?.aborted && owned && writerReleased && validDispositions && handle && storageScope
        ? { handle, storageScope } : undefined);
      if (owned && !signal?.aborted) await launch.reconcile?.().catch(() => undefined);
    }
  };
}
