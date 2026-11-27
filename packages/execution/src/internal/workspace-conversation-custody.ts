import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const privateConversationDirectory = '.agent-conversations';
const scopeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface WorkspaceConversationWriter {
  readonly version: 1;
  readonly tenant: string;
  readonly runId: string;
  readonly generation: string;
  /** Host-issued, restart-safe identities. A PID is not sufficient. */
  readonly writerIdentity: string;
  readonly descendantGroup: string;
}

function validWriter(value: unknown): value is WorkspaceConversationWriter {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row['version'] === 1 && ['tenant', 'runId', 'generation', 'writerIdentity', 'descendantGroup']
    .every(key => typeof row[key] === 'string' && row[key].trim() !== '' && row[key].length <= 256);
}

async function privateDirectory(dir: string): Promise<boolean> {
  const stat = await lstat(dir);
  return stat.isDirectory() && (stat.mode & 0o077) === 0 &&
    (!process.getuid || stat.uid === process.getuid()) && await realpath(dir) === dir;
}

export async function createPrivateConversationScope(runRoot: string, writer: WorkspaceConversationWriter) {
  if (!validWriter(writer) || path.basename(runRoot) !== writer.runId || await realpath(runRoot) !== runRoot) {
    throw new Error('Private conversation scope owner could not be verified.');
  }
  const root = path.join(runRoot, privateConversationDirectory);
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!await privateDirectory(root)) throw new Error('Private conversation directory could not be verified.');
  const id = randomUUID();
  const scope = path.join(root, id);
  await mkdir(scope, { mode: 0o700 });
  const marker = await open(path.join(scope, 'owner.json'), 'wx', 0o600);
  try {
    await marker.writeFile(JSON.stringify(writer));
    await marker.sync();
  } finally {
    await marker.close();
  }
  // Before sending a prompt, require a durable marker and durable directory entries.
  for (const dir of [scope, root, runRoot]) {
    const fd = await open(dir, 'r');
    try { await fd.sync(); } finally { await fd.close(); }
  }
  return { id, scope };
}

/** Returns false on malformed or uncertain custody. Never infer termination from absence of a PID. */
export async function drainPrivateConversationScopes(input: {
  runRoot: string;
  runId: string;
  writerExited?: (marker: WorkspaceConversationWriter) => Promise<boolean>;
  removeOwnedScope: (scope: string) => Promise<void>;
}): Promise<boolean> {
  const root = path.join(input.runRoot, privateConversationDirectory);
  try {
    try { await lstat(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    if (!await privateDirectory(root)) return false;
    for (const name of await readdir(root)) {
      if (!scopeIdPattern.test(name)) return false;
      const scope = path.join(root, name);
      if (!await privateDirectory(scope) || !input.writerExited) return false;
      const file = path.join(scope, 'owner.json');
      const markerStat = await lstat(file);
      if (!markerStat.isFile() || markerStat.nlink !== 1 || markerStat.size > 4096 ||
          (markerStat.mode & 0o077) !== 0 || (process.getuid && markerStat.uid !== process.getuid())) return false;
      const markerFile = await open(file, 'r');
      let marker: unknown;
      try {
        const same = await markerFile.stat();
        if (same.ino !== markerStat.ino || same.dev !== markerStat.dev || same.size !== markerStat.size) return false;
        marker = JSON.parse(await markerFile.readFile('utf8')) as unknown;
      } finally { await markerFile.close(); }
      if (!validWriter(marker) || marker.runId !== input.runId || !await input.writerExited(marker)) return false;
      await input.removeOwnedScope(scope);
    }
    return (await readdir(root)).length === 0;
  } catch {
    return false;
  }
}
