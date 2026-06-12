import type { ArtifactKind, NonModelPrincipal, Run } from '@autocatalyst/api-contract';
import type { ArtifactRepository } from './domain-repositories.js';
import type { WorkspaceFileSystemPort, WorkspaceGitPort } from './spec-authoring-service.js';
import { parseSpecFrontmatter, renderCommittedSpecMarkdown } from './spec-frontmatter.js';

export type SpecApprovalErrorCode =
  | 'spec_artifact_missing'
  | 'spec_approval_file_update_failed'
  | 'spec_approval_validation_failed'
  | 'spec_approval_commit_failed'
  | 'spec_approval_artifact_update_failed';

export class SpecApprovalError extends Error {
  readonly code: SpecApprovalErrorCode;

  constructor(code: SpecApprovalErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'SpecApprovalError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface FinalizeSpecApprovalInput {
  readonly run: Run;
  readonly approver: NonModelPrincipal;
  readonly workspaceRepoRoot: string;
  readonly workspaceHandle: string;
}

export interface SpecApprovalFinalizerDependencies {
  readonly artifacts: ArtifactRepository;
  readonly filesystem: WorkspaceFileSystemPort;
  readonly git: WorkspaceGitPort;
  readonly clock: () => string;
}

function expectedKindForRun(run: Run): 'feature_spec' | 'enhancement_spec' | null {
  if (run.workKind === 'feature') return 'feature_spec';
  if (run.workKind === 'enhancement') return 'enhancement_spec';
  return null;
}

export async function finalizeSpecApproval(
  input: FinalizeSpecApprovalInput,
  deps: SpecApprovalFinalizerDependencies
): Promise<void> {
  const { run, workspaceRepoRoot } = input;
  const { artifacts, filesystem, git, clock } = deps;

  // Step 1: Find the spec artifact for this run
  const expectedKind = expectedKindForRun(run);
  if (expectedKind === null) {
    throw new SpecApprovalError(
      'spec_artifact_missing',
      `Run '${run.id}' workKind '${run.workKind}' does not correspond to a spec workflow.`
    );
  }
  const kind: ArtifactKind = expectedKind;

  const artifact = await artifacts.findByRunAndKind({ runId: run.id, kind });
  if (artifact === null) {
    throw new SpecApprovalError(
      'spec_artifact_missing',
      `Spec artifact not found for run '${run.id}'.`
    );
  }

  const relativePath = artifact.location;

  // Step 2: Read the current spec file
  const existingContents = await filesystem.readFile({ workspaceRepoRoot, relativePath });

  // Step 3: Parse frontmatter and preserve body
  const existingFrontmatter = parseSpecFrontmatter(existingContents);

  // Extract body: everything after the first frontmatter block
  const frontmatterMatch = /^---\n[\s\S]*?\n---(?:\n|$)/u.exec(existingContents);
  const body = frontmatterMatch !== null
    ? existingContents.slice(frontmatterMatch[0].length)
    : existingContents;

  // Step 4: Build updated frontmatter with approved status
  const today = clock().slice(0, 10);
  const updatedFrontmatter = {
    ...existingFrontmatter,
    status: 'approved' as const,
    last_updated: today
  };

  // Step 5: Render updated markdown
  const updatedContents = renderCommittedSpecMarkdown({ frontmatter: updatedFrontmatter, body });

  // Step 6: Write and validate
  try {
    await filesystem.writeFile({ workspaceRepoRoot, relativePath, contents: updatedContents });
  } catch (cause) {
    throw new SpecApprovalError('spec_approval_file_update_failed', 'Failed to write approved spec file.', { cause });
  }

  try {
    const written = await filesystem.readFile({ workspaceRepoRoot, relativePath });
    parseSpecFrontmatter(written);
  } catch (cause) {
    throw new SpecApprovalError('spec_approval_validation_failed', 'Spec file validation failed after approval write.', { cause });
  }

  // Step 7: Commit only this file — use slug derived from artifact path, not raw run UUID.
  const slug = relativePath.replace(/^context-human\/specs\/(?:feature|enhancement)-/u, '').replace(/\.md$/u, '');
  try {
    await git.commitFiles({
      workspaceRepoRoot,
      relativePaths: [relativePath],
      message: `docs: approve spec ${slug}`
    });
  } catch (cause) {
    throw new SpecApprovalError('spec_approval_commit_failed', 'Failed to commit approved spec file.', { cause });
  }

  // Step 8: Update artifact cached status
  try {
    await artifacts.updateCachedStatus({
      artifactId: artifact.id,
      cachedStatus: 'approved',
      updatedAt: clock()
    });
  } catch (cause) {
    throw new SpecApprovalError('spec_approval_artifact_update_failed', 'Failed to update spec artifact status.', { cause });
  }
}
