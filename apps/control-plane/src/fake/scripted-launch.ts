import { lstat, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

import type { ClaudeNativeEvent, ClaudeSessionLaunch } from '@autocatalyst/claude-agent-adapter';
import type { FakeStatePaths } from './paths.js';
import { scriptedTaskProgress } from './scripted-results.js';

/** Claim a local, one-shot control file without interfering with unmatched launches. */
export async function claimLaunchDelay(paths: FakeStatePaths, issue: number, step: string): Promise<number | undefined> {
  if (!Number.isSafeInteger(issue) || issue <= 0 || step.trim() === '') return undefined;
  const path = join(paths.delaysDir, `issue-${issue}.json`);
  let parsed: { step?: unknown; ms?: unknown } | null;
  try {
    // Treat symlinks and special files as malformed local controls.
    if (!(await lstat(paths.delaysDir)).isDirectory() || !(await lstat(path)).isFile()) return undefined;
    parsed = JSON.parse(await readFile(path, 'utf8')) as typeof parsed;
  } catch {
    return undefined;
  }
  if (parsed?.step !== step || typeof parsed.ms !== 'number' || !Number.isSafeInteger(parsed.ms) || parsed.ms <= 0) {
    return undefined;
  }
  try {
    await rename(path, `${path}.fired`);
    return parsed.ms;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function launchScript({ events, failed, ms, signal, stillRunning }: {
  events: readonly ClaudeNativeEvent[];
  failed: boolean;
  ms: number;
  signal: AbortSignal;
  stillRunning(): Promise<boolean>;
}): ClaudeSessionLaunch {
  return async function* () {
    signal.throwIfAborted();
    const start = performance.now();
    const conclusion = failed ? undefined : events.at(-1);
    for (const event of failed ? events : events.slice(0, -1)) yield event;
    if (ms > 0) {
      // Check the durable state on each tick: run cancellation does not presently
      // interrupt the active runner, while session.close can abort a pending timer.
      const total = Math.ceil(ms / 1_000);
      for (let elapsed = 1_000; elapsed <= ms; elapsed += 1_000) {
        await waitThrough(elapsed);
        yield scriptedTaskProgress('Scripted delay', elapsed / 1_000, total);
      }
      await waitThrough(ms);
    }
    signal.throwIfAborted();
    if (failed) throw new Error('fake-mode scripted failure injected');
    if (conclusion !== undefined) yield conclusion;

    async function waitThrough(target: number): Promise<void> {
      let remaining = target - (performance.now() - start);
      while (remaining > 0) {
        await setTimeout(Math.ceil(remaining), undefined, { signal });
        remaining = target - (performance.now() - start);
      }
      signal.throwIfAborted();
      if (!await stillRunning()) throw new DOMException('Scripted launch canceled', 'AbortError');
      signal.throwIfAborted();
    }
  };
}
