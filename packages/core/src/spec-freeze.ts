import type { ArtifactKind, Run } from '@autocatalyst/api-contract';
import type { ArtifactRepository } from './domain-repositories.js';
import type { RunWorkspaceGitPort } from './run-workspace-git.js';
import type { WorkspaceFileSystemPort } from './spec-authoring-service.js';
import { parseSpecFrontmatter, renderCommittedSpecMarkdown } from './spec-frontmatter.js';

/**
 * Spec freeze runs after a clean pr.finalize review and before pr.open. It updates the spec
 * artifact frontmatter to a shipped status (`complete`) and the artifact's cached status to
 * `published`, then commits the change deterministically (host-side, no agent session).
 */

export type SpecFreezeErrorCode = 'spec_freeze_failed';

export class SpecFreezeError extends Error {
  readonly code: SpecFreezeErrorCode = 'spec_freeze_failed';
  override readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'SpecFreezeError';
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface SpecFreezeInput {
  readonly run: Run;
  readonly workspaceRepoRoot: string;
}

export interface SpecFreezeDependencies {
  readonly artifacts: ArtifactRepository;
  readonly filesystem: WorkspaceFileSystemPort;
  readonly git: RunWorkspaceGitPort;
  readonly clock: () => string;
}

export interface SpecFreezeResult {
  readonly artifactPath: string;
  readonly shippedAt: string;
  readonly commitSha: string | null;
}

function expectedKindForRun(run: Run): 'feature_spec' | 'enhancement_spec' | null {
  if (run.workKind === 'feature') return 'feature_spec';
  if (run.workKind === 'enhancement') return 'enhancement_spec';
  return null;
}

export async function freezeRunSpecForPullRequest(
  input: SpecFreezeInput,
  deps: SpecFreezeDependencies
): Promise<SpecFreezeResult> {
  const { run, workspaceRepoRoot } = input;
  const { artifacts, filesystem, git, clock } = deps;

  const expectedKind = expectedKindForRun(run);
  if (expectedKind === null) {
    throw new SpecFreezeError(`Run '${run.id}' workKind '${run.workKind}' does not correspond to a spec workflow.`);
  }
  const kind: ArtifactKind = expectedKind;

  // Step 1: locate the spec artifact for this run.
  let artifact;
  try {
    artifact = await artifacts.findByRunAndKind({ runId: run.id, kind });
  } catch (cause) {
    throw new SpecFreezeError('Failed to look up spec artifact for run.', { cause });
  }
  if (artifact === null) {
    throw new SpecFreezeError(`Spec artifact not found for run '${run.id}'.`);
  }
  const relativePath = artifact.location;

  // Step 2: read the current spec file.
  let existingContents: string;
  try {
    existingContents = await filesystem.readFile({ workspaceRepoRoot, relativePath });
  } catch (cause) {
    throw new SpecFreezeError('Failed to read spec file for freeze.', { cause });
  }

  // Step 3: parse frontmatter and preserve body.
  let existingFrontmatter;
  try {
    existingFrontmatter = parseSpecFrontmatter(existingContents);
  } catch (cause) {
    throw new SpecFreezeError('Failed to parse spec frontmatter for freeze.', { cause });
  }
  const frontmatterMatch = /^---\n[\s\S]*?\n---(?:\n|$)/u.exec(existingContents);
  const body = frontmatterMatch !== null
    ? existingContents.slice(frontmatterMatch[0].length)
    : existingContents;

  // Step 4: render updated frontmatter with shipped status.
  const shippedAt = clock();
  const today = shippedAt.slice(0, 10);
  const updatedFrontmatter = {
    ...existingFrontmatter,
    status: 'complete' as const,
    last_updated: today
  };

  let updatedContents: string;
  try {
    updatedContents = renderCommittedSpecMarkdown({ frontmatter: updatedFrontmatter, body });
  } catch (cause) {
    throw new SpecFreezeError('Failed to render frozen spec markdown.', { cause });
  }

  // Step 5: write the updated spec file.
  try {
    await filesystem.writeFile({ workspaceRepoRoot, relativePath, contents: updatedContents });
  } catch (cause) {
    throw new SpecFreezeError('Failed to write frozen spec file.', { cause });
  }

  // Step 6: commit only this file via the run-workspace git port.
  const slug = relativePath
    .replace(/^context-human\/specs\/(?:feature|enhancement)-/u, '')
    .replace(/\.md$/u, '');
  let commitSha: string | null = null;
  try {
    const commitResult = await git.commitFiles({
      runId: run.id,
      workspaceRepoRoot,
      message: `docs: freeze shipped spec ${slug}`
    });
    commitSha = commitResult.commitSha;
  } catch (cause) {
    throw new SpecFreezeError('Failed to commit frozen spec file.', { cause });
  }

  // Step 7: update artifact cached status to `published`.
  try {
    await artifacts.updateCachedStatus({
      artifactId: artifact.id,
      cachedStatus: 'published',
      updatedAt: shippedAt
    });
  } catch (cause) {
    throw new SpecFreezeError('Failed to update spec artifact cached status after freeze.', { cause });
  }

  return {
    artifactPath: relativePath,
    shippedAt,
    commitSha
  };
}
