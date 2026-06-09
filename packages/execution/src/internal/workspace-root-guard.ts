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
  throw new RunnerProtocolError('runner_failed', 'Path is outside materialized workspace roots.');
}
