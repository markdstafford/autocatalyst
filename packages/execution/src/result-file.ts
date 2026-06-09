import { access, readFile, realpath } from 'node:fs/promises';
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

export async function readScratchStepResultFile(input: ReadScratchStepResultFileInput): Promise<StepResultFileReadOutcome> {
  const scratchRoot = 'scratchRoot' in input.environment.workspace ? input.environment.workspace.scratchRoot : undefined;
  if (scratchRoot === undefined) {
    return fileFailure('result_file_missing', 'No scratch root is available for result-file reading.');
  }

  const candidate = path.resolve(scratchRoot, input.resultFile);
  const rootRealPath = await realpath(scratchRoot).catch(() => scratchRoot);
  const candidateParent = path.dirname(candidate);
  const parentRealPath = await realpath(candidateParent).catch(() => candidateParent);
  const resolvedCandidate = path.join(parentRealPath, path.basename(candidate));

  if (!isContainedByRoot(resolvedCandidate, rootRealPath)) {
    return fileFailure('result_path_outside_scratch_root', 'Result file path escapes the scratch root.');
  }

  try {
    await access(resolvedCandidate, constants.R_OK);
  } catch (error) {
    const code = hasNodeCode(error, 'ENOENT') ? 'result_file_missing' : 'result_file_unreadable';
    return fileFailure(code, code === 'result_file_missing' ? 'Result file is missing.' : 'Result file is unreadable.');
  }

  let text: string;
  try {
    text = await readFile(resolvedCandidate, 'utf8');
  } catch {
    return fileFailure('result_file_unreadable', 'Result file is unreadable.');
  }

  try {
    return {
      status: 'read',
      value: JSON.parse(text),
      relativePath: path.relative(rootRealPath, resolvedCandidate)
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
