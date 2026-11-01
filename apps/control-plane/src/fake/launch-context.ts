import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assertValidIdentifier, failureFile, type FakeStatePaths } from './paths.js';

/** Context recorded for each scripted model launch, keyed by run id + launch sequence. */
export interface FakeLaunchContext {
  readonly runId: string;
  readonly stepId: string;
  readonly issueNumber?: number;
  readonly workKind: string;
  readonly scenarioHint?: string;
  readonly launchSequence: number;
  readonly resultSchemaId: string;
  readonly role?: string;
}

async function readCount(path: string): Promise<number> {
  try {
    const raw = (await readFile(path, 'utf-8')).trim();
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Increment and return the global scripted-launch counter. */
export async function bumpLaunchCounter(paths: FakeStatePaths): Promise<number> {
  const next = (await readCount(paths.launchCounterFile)) + 1;
  await writeFile(paths.launchCounterFile, `${next}\n`, 'utf-8');
  return next;
}

/** Read the current global scripted-launch counter without mutating it. */
export async function readLaunchCounter(paths: FakeStatePaths): Promise<number> {
  return readCount(paths.launchCounterFile);
}

/** Increment and return the per-run spec.author pass number (1-based). */
export async function bumpSpecAuthorPass(paths: FakeStatePaths, runId: string): Promise<number> {
  const file = join(paths.countersDir, `spec-author-${sanitizeRunId(runId)}.count`);
  const next = (await readCount(file)) + 1;
  await writeFile(file, `${next}\n`, 'utf-8');
  return next;
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_-]/gu, '_');
}

/** Persist a launch context record keyed by run id + launch sequence. */
export async function recordLaunchContext(paths: FakeStatePaths, context: FakeLaunchContext): Promise<void> {
  const file = join(paths.launchContextDir, `${sanitizeRunId(context.runId)}-${context.launchSequence}.json`);
  await writeFile(file, `${JSON.stringify(context, null, 2)}\n`, 'utf-8');
}

/** Read a recorded launch context (used by tests). Returns null when absent. */
export async function readLaunchContext(
  paths: FakeStatePaths,
  runId: string,
  launchSequence: number
): Promise<FakeLaunchContext | null> {
  const file = join(paths.launchContextDir, `${sanitizeRunId(runId)}-${launchSequence}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as FakeLaunchContext;
  } catch {
    return null;
  }
}

/**
 * If a failure file exists for the given issue and its recorded step matches the
 * current step, rename it with a `.fired` suffix and return true so the caller
 * can fail this launch. Only the first matching launch fires.
 */
export async function consumeFailureIfMatches(
  paths: FakeStatePaths,
  issueNumber: number,
  step: string
): Promise<boolean> {
  assertValidIdentifier(issueNumber, 'issue number');
  const file = failureFile(paths, issueNumber);
  let parsed: { step?: unknown };
  try {
    parsed = JSON.parse(await readFile(file, 'utf-8')) as { step?: unknown };
  } catch {
    return false;
  }
  if (typeof parsed.step !== 'string' || parsed.step !== step) {
    return false;
  }
  await rename(file, `${file}.fired`);
  return true;
}
