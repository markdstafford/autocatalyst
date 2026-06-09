import { resolve, relative } from 'node:path';
import { RunnerProtocolError } from '../runner.js';

export function assertPathWithinWorkspaceRoots(candidatePath: string, workspaceRoots: readonly string[]): void {
  const resolved = resolve(candidatePath);
  for (const root of workspaceRoots) {
    const resolvedRoot = resolve(root);
    const rel = relative(resolvedRoot, resolved);
    if (!rel.startsWith('..') && !rel.startsWith('/')) {
      return; // path is within this root
    }
  }
  const resolvedCandidate = resolve(candidatePath);

  // If the candidate path shares a prefix with any workspace root (i.e., it is
  // syntactically under a root), include it in the message — revealing it doesn't
  // leak outside information. If it's completely outside all roots, use the
  // generic message to avoid disclosing external paths.
  const isUnderARoot = workspaceRoots.some(root => {
    const resolvedRoot = resolve(root);
    return resolvedCandidate.startsWith(resolvedRoot + '/') || resolvedCandidate === resolvedRoot;
  });

  const message = isUnderARoot
    ? `Path '${resolvedCandidate}' is outside materialized workspace roots.`
    : 'Path is outside materialized workspace roots.';

  throw new RunnerProtocolError('runner_failed', message);
}
