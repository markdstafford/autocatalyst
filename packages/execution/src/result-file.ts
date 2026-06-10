import { access, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import type { ResultValidationIssue } from './result-tolerance.js';

export type StepResultFileErrorCode =
  | 'result_file_missing'
  | 'result_file_unreadable'
  | 'result_json_invalid'
  | 'result_path_outside_scratch_root';

export interface ReadScratchStepResultFileInput {
  readonly environment: MaterializedExecutionEnvironment;
  readonly resultFile: string;
}

export type StepResultFileReadOutcome = StepResultFileReadSuccess | StepResultFileReadFailure;

export interface StepResultFileReadSuccess {
  readonly status: 'read';
  readonly value: unknown;
  readonly relativePath: string;
}

export interface StepResultFileReadFailure {
  readonly status: 'failed';
  readonly code: StepResultFileErrorCode;
  readonly safeMessage: string;
  readonly issues: readonly ResultValidationIssue[];
}

/**
 * Resolves a relative path against a scratch root by walking existing path components via
 * realpath so symlinked directory ancestors cannot redirect reads or writes outside the root.
 * Returns `{ resolvedCandidate, rootRealPath }` when the path is contained, or `null` when it escapes.
 *
 * Unlike resolving only the immediate parent, this function walks upward from the full candidate
 * to find the deepest existing ancestor and calls realpath on it. This prevents the ENOENT-fallback
 * gap where `realpath(candidateParent)` would fail because a non-existent sub-directory sits beyond
 * a symlink that points outside the root (e.g. `link/new/result.json` where `link` → outside and
 * `new/` does not yet exist).
 *
 * Both the result-file reader and the StubRunner writer use this helper so their containment
 * rules stay in sync.
 */
export async function resolveScratchRootCandidatePath(
  scratchRoot: string,
  relativePath: string
): Promise<{ readonly resolvedCandidate: string; readonly rootRealPath: string } | null> {
  // Resolve rootRealPath first so the candidate is always in the same namespace,
  // even when scratchRoot itself is a symlink (e.g. /tmp → /private/tmp on macOS).
  const rootRealPath = await realpath(scratchRoot).catch(() => scratchRoot);
  const candidate = path.resolve(rootRealPath, relativePath);

  // Walk upward from the candidate to find the deepest existing path component, resolve its
  // real path (expanding any symlinks), and verify containment before reconstructing the full
  // candidate. This catches symlinked ancestors that would redirect a subsequent mkdir/write
  // outside scratchRoot even when the final path component does not yet exist.
  const { realAncestor, remainingSegments } = await resolveDeepestExistingAncestor(candidate);
  if (!isContainedByRoot(realAncestor, rootRealPath)) {
    return null;
  }

  const resolvedCandidate =
    remainingSegments.length > 0 ? path.join(realAncestor, ...remainingSegments) : realAncestor;
  if (!isContainedByRoot(resolvedCandidate, rootRealPath)) {
    return null;
  }

  return { resolvedCandidate, rootRealPath };
}

/**
 * Walks upward from `p` to find the deepest existing path component, resolves it via realpath,
 * and returns the resolved ancestor together with the remaining (not-yet-existing) segments in
 * top-down order. Rethrows unexpected filesystem errors (anything other than ENOENT).
 */
async function resolveDeepestExistingAncestor(
  p: string
): Promise<{ readonly realAncestor: string; readonly remainingSegments: readonly string[] }> {
  const pendingSegments: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return { realAncestor: real, remainingSegments: [...pendingSegments].reverse() };
    } catch {
      // Any realpath error means this component is not a resolvable directory: ENOENT for a
      // not-yet-created path, ENOTDIR for a non-directory ancestor, plus ELOOP, EACCES, and so
      // on. Treat them all the same — walk up to the deepest ancestor we can resolve and
      // re-check containment there. This keeps the walk total so no raw filesystem error
      // escapes to crash the validation path or leak a host path.
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding an existing path; return lexical root.
        return { realAncestor: current, remainingSegments: [...pendingSegments].reverse() };
      }
      pendingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Returns `true` when it is safe to write to `resolvedCandidate` (the path does not exist,
 * is not a symlink, or is a symlink whose realpath is still contained by `rootRealPath`).
 * Returns `false` when an existing symlink at the write target resolves outside the root.
 * Rethrows unexpected filesystem errors.
 */
export async function isFinalWriteTargetSafe(resolvedCandidate: string, rootRealPath: string): Promise<boolean> {
  try {
    const stat = await lstat(resolvedCandidate);
    if (stat.isSymbolicLink()) {
      const fileRealPath = await realpath(resolvedCandidate);
      return isContainedByRoot(fileRealPath, rootRealPath);
    }
    return true;
  } catch (error) {
    if (hasNodeCode(error, 'ENOENT')) return true;
    // Any other filesystem error (ENOTDIR for a non-directory ancestor, EACCES, ELOOP, ...)
    // means we cannot prove the target is safe. Fail closed rather than rethrow a raw,
    // path-bearing error to the caller.
    return false;
  }
}

export async function readScratchStepResultFile(input: ReadScratchStepResultFileInput): Promise<StepResultFileReadOutcome> {
  const scratchRoot = 'scratchRoot' in input.environment.workspace ? input.environment.workspace.scratchRoot : undefined;
  if (scratchRoot === undefined) {
    return fileFailure('result_file_missing', 'No scratch root is available for result-file reading.');
  }

  let resolution: { readonly resolvedCandidate: string; readonly rootRealPath: string } | null;
  try {
    resolution = await resolveScratchRootCandidatePath(scratchRoot, input.resultFile);
  } catch {
    // Defense in depth: path resolution is expected to be total, but never let an unexpected
    // filesystem error escape as a raw, path-bearing exception.
    return fileFailure('result_file_unreadable', 'Result file is unreadable.');
  }
  if (resolution === null) {
    return fileFailure('result_path_outside_scratch_root', 'Result file path escapes the scratch root.');
  }
  const { resolvedCandidate, rootRealPath } = resolution;

  // Resolve the final file path itself to catch symlinks pointing outside scratchRoot.
  let finalPath = resolvedCandidate;
  try {
    const fileRealPath = await realpath(resolvedCandidate);
    if (!isContainedByRoot(fileRealPath, rootRealPath)) {
      return fileFailure('result_path_outside_scratch_root', 'Result file path escapes the scratch root.');
    }
    finalPath = fileRealPath;
  } catch (error) {
    if (!hasNodeCode(error, 'ENOENT')) {
      return fileFailure('result_file_unreadable', 'Result file is unreadable.');
    }
    // ENOENT: file does not exist; access() will surface this below.
  }

  try {
    await access(finalPath, constants.R_OK);
  } catch (error) {
    const code = hasNodeCode(error, 'ENOENT') ? 'result_file_missing' : 'result_file_unreadable';
    return fileFailure(code, code === 'result_file_missing' ? 'Result file is missing.' : 'Result file is unreadable.');
  }

  let text: string;
  try {
    text = await readFile(finalPath, 'utf8');
  } catch {
    return fileFailure('result_file_unreadable', 'Result file is unreadable.');
  }

  try {
    return {
      status: 'read',
      value: JSON.parse(text),
      relativePath: path.relative(rootRealPath, finalPath)
    };
  } catch {
    return fileFailure('result_json_invalid', 'Result file does not contain valid JSON.');
  }
}

function isContainedByRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasNodeCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}

function fileFailure(code: StepResultFileErrorCode, safeMessage: string): StepResultFileReadFailure {
  return { status: 'failed', code, safeMessage, issues: [{ code, path: [], message: safeMessage }] };
}
