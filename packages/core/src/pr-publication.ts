import { z } from 'zod';
import { type JsonValue, type Run, type RunStep } from '@autocatalyst/api-contract';
import { repositorySlug, type CodeHostTarget, type ResolveCodeHostCredential } from './code-host.js';
import type { ConversationRepository, ProjectRepository, RunWorkspaceMetadataRepository, TopicRepository } from './domain-repositories.js';
import type { SpecFreezeResult } from './spec-freeze.js';

export const initialPullRequestBase = 'main';
export const publicationRefreshLimit = 2;
export const fullGitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export interface PublicationWorkspace {
  readonly workspaceRepoRoot: string;
  readonly workspaceRootOverride?: string;
  readonly branch: string;
  readonly remote: string;
  readonly repository: string;
  readonly base: string;
  readonly token: string;
}

export type PublicationIntegration =
  | { readonly kind: 'integrated'; readonly sourceSha: string; readonly targetSha: string; readonly headSha: string }
  | { readonly kind: 'conflict'; readonly sourceSha: string; readonly targetSha: string; readonly paths: readonly string[]; readonly cleanup: 'restored' | 'inspection_required' }
  | { readonly kind: 'target_unverified'; readonly sourceSha?: string }
  | { readonly kind: 'workspace_unavailable' };

export interface PublicationGitPort {
  integrate(input: PublicationWorkspace): Promise<PublicationIntegration>;
  readTarget(input: PublicationWorkspace): Promise<string | null>;
  readSource(input: PublicationWorkspace): Promise<string | null>;
  readCandidate(input: PublicationWorkspace): Promise<string | null>;
  verifyFreeze(input: PublicationWorkspace, reviewedSha: string, freeze: SpecFreezeResult): Promise<boolean>;
  sameTree(input: PublicationWorkspace, first: string, second: string): Promise<boolean>;
  pushCandidate(input: PublicationWorkspace, headSha: string, expectedOldHead?: string, authorize?: () => Promise<boolean>): Promise<'pushed' | 'already_present' | 'unverified'>;
}

export interface PublicationBindingDependencies {
  readonly topics: TopicRepository;
  readonly conversations: ConversationRepository;
  readonly projects: ProjectRepository;
  readonly runWorkspaceMetadata: RunWorkspaceMetadataRepository;
  readonly resolveCredential: ResolveCodeHostCredential;
  readonly publicationRemoteOverride?: string;
}

export async function resolvePublicationBinding(run: Run, deps: PublicationBindingDependencies) {
  const topic = await deps.topics.findById(run.topicId);
  if (topic?.tenant !== run.tenant) throw new Error('publication_binding_invalid');
  const conversation = await deps.conversations.findById(topic.conversationId);
  if (conversation?.tenant !== run.tenant) throw new Error('publication_binding_invalid');
  const project = await deps.projects.findById(conversation.projectId);
  if (project?.tenant !== run.tenant ||
      project.codeHostSetting?.provider !== project.hostRepository.provider ||
      project.codeHostSetting.credentialRef === undefined) throw new Error('publication_binding_invalid');
  const meta = await deps.runWorkspaceMetadata.findByRunId(run.id);
  if (meta === null) throw new Error('publication_workspace_missing');
  const target: CodeHostTarget = {
    provider: project.hostRepository.provider, owner: project.hostRepository.owner, name: project.hostRepository.name
  };
  const credential = await deps.resolveCredential(project.codeHostSetting.credentialRef);
  const workspace: PublicationWorkspace = {
    workspaceRepoRoot: meta.workspaceRepoRoot,
    ...(project.workspaceRootOverride !== null ? { workspaceRootOverride: project.workspaceRootOverride } : {}),
    branch: meta.workspaceHandle,
    base: initialPullRequestBase,
    remote: deps.publicationRemoteOverride ?? project.hostRepository.url ?? project.repoUrl,
    repository: repositorySlug(target),
    token: credential.token
  };
  return { target, workspace, credential };
}

const attestationSchema = z.object({
  repository: z.string().min(1).max(250),
  branch: z.string().min(1).max(250),
  base: z.string().min(1).max(250),
  targetSha: fullGitSha,
  reviewedSha: fullGitSha,
  publishSha: fullGitSha
}).strict();

const receiptSchema = z.object({
  kind: z.literal('publication_push_receipt'),
  runId: z.string().min(1),
  repository: z.string().min(1),
  branch: z.string().min(1),
  headSha: fullGitSha
}).strict();
export type PublicationPushReceipt = z.infer<typeof receiptSchema>;

function fields(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

export function publicationAttestation(step: RunStep | undefined, workspace: PublicationWorkspace) {
  const checkpoint = fields(step?.checkpointResult ?? null);
  if (checkpoint['kind'] !== 'pull_request_finalize' || checkpoint['directive'] !== 'advance') return null;
  const parsed = attestationSchema.safeParse(checkpoint['attestation']);
  if (!parsed.success) return null;
  const { repository, branch, base } = parsed.data;
  return repository === workspace.repository && branch === workspace.branch && base === workspace.base ? parsed.data : null;
}

export function findPublicationReceipt(steps: readonly RunStep[], runId: string, workspace: PublicationWorkspace, headSha: string): PublicationPushReceipt | null {
  for (const step of [...steps].sort((a, b) => b.occurrence.index - a.occurrence.index)) {
    if (step.step !== 'pr.open') continue;
    const parsed = receiptSchema.safeParse(fields(step.checkpointResult)['receipt']);
    if (parsed.success && parsed.data.runId === runId && parsed.data.repository === workspace.repository &&
        parsed.data.branch === workspace.branch && parsed.data.headSha === headSha) return parsed.data;
  }
  return null;
}

export function publicationEpoch(steps: readonly RunStep[]): { count: number; sourcePushed: boolean } {
  let count = 0;
  let sourcePushed = false;
  let reset = false;
  const ordered = [...steps].sort((a, b) => b.occurrence.index - a.occurrence.index);
  for (let i = 0; i < ordered.length; i++) {
    const step = ordered[i]!;
    const checkpoint = fields(step.checkpointResult);
    if (checkpoint['kind'] === 'publication_recovery_epoch') reset = true;
    if (step.step === 'failed' && ordered[i - 1]?.step === 'pr.finalize') {
      const stopped = ordered[i + 1];
      const code = fields(stopped?.checkpointResult ?? null)['code'];
      if (stopped?.step === 'pr.open' || (stopped !== undefined && typeof code === 'string' && publicationRecoveryStep(stopped, code))) {
        reset = true;
      }
    }
    if (checkpoint['sourcePushed'] === true || receiptSchema.safeParse(checkpoint['receipt']).success) sourcePushed = true;
    if (!reset && checkpoint['kind'] === 'publication_stop' && checkpoint['code'] === 'pr_publication_refreshed') count++;
  }
  return { count, sourcePushed };
}

export function publicationRecoveryStep(stoppedStep: RunStep, failureReason: string | undefined): boolean {
  const checkpoint = fields(stoppedStep.checkpointResult);
  if (checkpoint['kind'] !== 'publication_stop' || checkpoint['code'] !== failureReason) return false;
  return (stoppedStep.step === 'pr.finalize' && failureReason === 'pr_integration_conflict') ||
    (stoppedStep.step === 'pr.open' && failureReason === 'pr_publication_refresh_exhausted') ||
    ((stoppedStep.step === 'pr.finalize' || stoppedStep.step === 'pr.open') && failureReason === 'pr_target_verification_failed');
}

// Public activity is plain text. Omit likely credential or absolute-path excerpts rather than leaking them.
export function safePublicationText(value: string): string | null {
  const text = value.trim();
  if (!text || /\p{C}|(?:^|[\s`'"])(?:\/[^\s]|[a-z]:\\)|(?:gh[pousr]_|github_pat_|sk-|AKIA)[a-z\d_-]{8,}|(?:password|secret|token|authorization)\s*[:=]\s*\S+|\b[A-Za-z0-9_-]{36,}\b/iu.test(text)) return null;
  return text.slice(0, 240);
}
