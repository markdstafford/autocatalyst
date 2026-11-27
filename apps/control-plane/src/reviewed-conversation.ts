import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { implementerDispositionsResultSchema } from '@autocatalyst/api-contract';
import type { ReviewedAttemptPort, RunRoleWorkInput } from '@autocatalyst/core';
import type { MaterializedExecutionEnvironment, NativeConversationTurn, ResolvedAgentRunnerProfile } from '@autocatalyst/execution';
import type {
  ConversationBinding, ConversationClaim, DrizzleAgentConversationRepository, ReviewedDispatchAttempt
} from '@autocatalyst/persistence';

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
const releaseNonPersistentClaudeBuilds: ReadonlySet<string> = new Set();

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

/** This is workspace-instance proof, not proof of native transcript confinement. */
export async function reviewedWorkspaceProof(
  environment: MaterializedExecutionEnvironment, workspacesRoot: string, hostRepository?: string
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

interface VerifiedLaunch {
  readonly build: RetentionBuild;
  readonly authenticatedBinding: string;
  readonly credentialRevision: string;
  readonly storageNamespace: string;
  /** The host must assign and supervise a private scope before returning a retained launch. */
  open(resume?: ConversationClaim['resume']): Promise<{
    readonly storageScope: string;
    readonly native: Omit<Extract<NativeConversationTurn, { mode: 'retained' }>, 'mode' | 'resumeId' | 'completed'>;
  } | undefined>;
}

export function createReviewedAttemptPort(input: {
  readonly repository: DrizzleAgentConversationRepository;
  readonly roleInput: RunRoleWorkInput;
  readonly workspacesRoot?: string;
  readonly repositoryIdentity?: string;
  readonly hostRepository?: string;
  readonly freshHandoff: string;
  /** Internal qualification seam; server composition does not accept overrides. */
  readonly admit?: (environment: MaterializedExecutionEnvironment, generation: string, profile: ResolvedAgentRunnerProfile) => Promise<VerifiedLaunch | undefined>;
  readonly nonPersistentBuild?: string;
  readonly benchmarkArm?: 'A' | 'B';
  readonly qualifiedBuild?: (build: RetentionBuild) => boolean;
}): ReviewedAttemptPort | undefined {
  const roleInput = input.roleInput;
  const occurrence = roleInput.reviewedOccurrence;
  const step = roleInput.run.currentStep;
  if (!occurrence || (step !== 'spec.author' && step !== 'implementation.build') ||
      (step === 'spec.author' && !roleInput.specReview)) return undefined;
  let prepared: ReviewedDispatchAttempt | undefined;
  let active: { attempt: ReviewedDispatchAttempt; claim: ConversationClaim; handle?: string; storageScope?: string } | undefined;

  async function assertOwner() {
    if (occurrence?.stillOwns && !await occurrence.stillOwns()) throw new Error('reviewed_dispatch_not_owned');
  }

  return {
    freshHandoff: input.freshHandoff,
    async prepare({ attemptId, environment, fallback, profile }) {
      await assertOwner();
      const fresh = {
        mode: 'fresh_only',
        verifiedNonPersistence: input.nonPersistentBuild !== undefined && releaseNonPersistentClaudeBuilds.has(input.nonPersistentBuild)
      } as const;
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
      const ws = environment.workspace;
      let binding: ConversationBinding | undefined;
      let launch: VerifiedLaunch | undefined;
      if (ws.shape === 'two_roots' && input.workspacesRoot) {
        const proof = await reviewedWorkspaceProof(environment, input.workspacesRoot, input.hostRepository);
        await assertOwner();
        let generation: string | null = null;
        try {
          generation = input.repository.enroll({
            tenant: attempt.tenant, runId: attempt.runId, root: ws.repoRoot, branch: ws.branchName, proof
          });
        } catch { /* Workspace ownership is independent of continuity storage. */ }

        const pr = roleInput.ciRepair?.prBinding;
        const specPath = roleInput.specReview?.canonicalPath;
        const deliverable = step === 'spec.author'
          ? specPath && /^context-human\/specs\/(?!\.\.?\/)[^/]+\.md$/u.test(specPath) ? [specPath] : []
          : input.repositoryIdentity ? [input.repositoryIdentity, ws.branchName] : [];
        const scopeDigest = reviewedScopeDigest({
          workflow: occurrence.workflow, workItemId: roleInput.run.topicId, step, role: roleInput.role, deliverable
        });
        const repairBound = !roleInput.ciRepair || (pr && input.repositoryIdentity &&
          pr.repository === input.repositoryIdentity && pr.branch === ws.branchName && pr.id && Number.isInteger(pr.number) && pr.number > 0);
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
              prIdentity: pr ? JSON.stringify([pr.repository, pr.id, pr.number, pr.branch]) : null };
          }
        }
      }
      await assertOwner();
      let claim: ConversationClaim | undefined;
      try {
        claim = input.repository.begin(attempt, binding, fallback ? 'fallback' : undefined);
        prepared = attempt;
      }
      catch (error) {
        if (error instanceof Error && error.message === 'reviewed_dispatch_not_owned') throw error;
        return nativeProvider ? fresh : undefined;
      }
      if (!claim || !launch) return nativeProvider ? fresh : undefined;
      active = { attempt, claim };
      const opened = await launch.open(claim.resume).catch(() => undefined);
      await assertOwner();
      const hasRoot = claim.resume && launch.build.provider === 'claude'
        ? ws.shape === 'two_roots' && await opened?.native.lookupRootSession?.(claim.resume.handle, ws.repoRoot).catch(() => false)
        : true;
      if (!opened || !hasRoot || !await opened.native.verifyLaunch().catch(() => false) ||
          (claim.resume && opened.storageScope !== claim.resume.storageScope)) {
        try {
          input.repository.finish(attempt, claim);
          input.repository.markFreshAfterPreflight(attempt);
        } catch { /* In-flight history is not selectable. */ }
        active = undefined;
        return fresh;
      }
      await assertOwner();
      active.storageScope = opened.storageScope;
      return {
        ...opened.native, mode: 'retained', ...(claim.resume ? { resumeId: claim.resume.handle } : {}),
        completed(handle) { if (active?.attempt.id === attemptId) active.handle = handle; }
      };
    },
    launched(attemptId, launch) {
      if (prepared?.id === attemptId) {
        try { input.repository.markLaunched(prepared, launch); }
        catch { /* Recording continuity metadata must not stop an otherwise valid invocation. */ }
      }
    },
    async finish({ attemptId, accepted, checkpoint, beforeLaunch }) {
      if (prepared?.id === attemptId) {
        if (beforeLaunch) input.repository.markFreshAfterPreflight(prepared);
        prepared = undefined;
      }
      if (active?.attempt.id !== attemptId) return;
      const { attempt, claim, handle, storageScope } = active;
      active = undefined;
      const owned = !occurrence.stillOwns || await occurrence.stillOwns();
      const required = roleInput.reviewContext?.requiredDispositions?.map(item => item.feedbackId) ?? [];
      const result = required.length ? implementerDispositionsResultSchema.safeParse(checkpoint) : undefined;
      const dispositions = result?.success ? result.data.dispositions ?? [] : [];
      const validDispositions = required.every(id => dispositions.filter(item => item.feedbackId === id).length === 1);
      input.repository.finish(attempt, claim, accepted && owned && validDispositions && handle && storageScope ? { handle, storageScope } : undefined);
    }
  };
}
