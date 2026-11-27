import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rmdir, symlink, unlink } from 'node:fs/promises';
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
  readonly provider?: 'codex' | 'claude';
  readonly storageHome?: string;
}

function validWriter(value: unknown): value is WorkspaceConversationWriter {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row['version'] === 1 && (row['provider'] === undefined || row['provider'] === 'codex' || row['provider'] === 'claude') &&
    (row['storageHome'] === undefined || (typeof row['storageHome'] === 'string' &&
      path.isAbsolute(row['storageHome']) && path.normalize(row['storageHome']) === row['storageHome'])) &&
    ['tenant', 'runId', 'generation', 'writerIdentity', 'descendantGroup']
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
  tenant?: string;
  keep?: (id: string, marker: WorkspaceConversationWriter) => boolean;
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
      if (!validWriter(marker) || marker.runId !== input.runId ||
          (input.tenant !== undefined && marker.tenant !== input.tenant) || !await input.writerExited(marker)) return false;
      if (input.keep?.(name, marker)) continue;
      await input.removeOwnedScope(scope);
      if (await exists(scope)) return false;
    }
    return input.keep !== undefined || (await readdir(root)).length === 0;
  } catch {
    return false;
  }
}

/** Known native history directories. Authentication stays in the dedicated provider home. */
const providerHistoryDirectories = {
  codex: ['sessions', 'archived_sessions'],
  claude: ['projects']
} as const;

type HistoryProvider = keyof typeof providerHistoryDirectories;
const nativeHistoryLeaseDirectory = '.autocatalyst-history-lease';
const nativeHistoryRetiringDirectory = '.autocatalyst-history-retiring';
const releasingNativeHomes = new Set<string>();

/** Ignore unrelated writers, but never mistake a malformed lease for an absent one. */
export async function nativeHistoryLeaseOwner(home: string): Promise<WorkspaceConversationWriter | null> {
  if (!await privateDirectory(home)) throw new Error('Native history home is not private.');
  const dirs = await Promise.all([nativeHistoryRetiringDirectory, nativeHistoryLeaseDirectory].map(async name => {
    const dir = path.join(home, name);
    return await exists(dir) ? dir : undefined;
  }));
  const present = dirs.filter((dir): dir is string => dir !== undefined);
  if (present.length === 0) return null;
  if (present.length !== 1) throw new Error('Native history lease is uncertain.');
  return (await readNativeHistoryLease(present[0]!)).writer;
}

export function privateConversationScopePath(runRoot: string, id: string): string | undefined {
  return scopeIdPattern.test(id) ? path.join(runRoot, privateConversationDirectory, id) : undefined;
}

async function exists(pathname: string): Promise<boolean> {
  try { await lstat(pathname); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

interface NativeHistoryLeaseMarker {
  readonly provider: HistoryProvider;
  readonly scope: string;
  readonly writer: WorkspaceConversationWriter;
}

async function readPrivateOwner(directory: string): Promise<unknown> {
  if (!await privateDirectory(directory)) throw new Error('Owned history directory cannot be verified.');
  const manifest = path.join(directory, 'owner.json');
  const stat = await lstat(manifest);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192 || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error('Native history lease owner cannot be verified.');
  const handle = await open(manifest, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) {
      throw new Error('Native history lease was replaced.');
    }
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}

async function readNativeHistoryLease(lease: string): Promise<NativeHistoryLeaseMarker> {
  const row = await readPrivateOwner(lease) as Partial<NativeHistoryLeaseMarker> | null;
  if (!row || (row.provider !== 'codex' && row.provider !== 'claude') ||
      typeof row.scope !== 'string' || !path.isAbsolute(row.scope) || path.normalize(row.scope) !== row.scope ||
      !validWriter(row.writer)) throw new Error('Native history lease owner is invalid.');
  if (row.writer.provider !== undefined && row.writer.provider !== row.provider) throw new Error('Native history lease provider mismatch.');
  return { provider: row.provider, scope: row.scope, writer: row.writer };
}

async function syncPrivateDirectory(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function historyLinksMatch(home: string, marker: NativeHistoryLeaseMarker, allowMissing: boolean): Promise<boolean> {
  for (const name of providerHistoryDirectories[marker.provider]) {
    const link = path.join(home, name);
    const stat = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (stat === undefined && allowMissing) continue;
    const target = path.join(marker.scope, name);
    if (!stat?.isSymbolicLink() || await readlink(link) !== target || !await privateDirectory(target)) return false;
  }
  return true;
}

/**
 * Route native histories to a private run-owned scope while keeping the
 * provider home stable for sign-in. Use only dedicated homes owned by the
 * launcher. An existing lease, ordinary history path, or unsafe path blocks
 * admission. Recovery may remove links only after positive writer evidence.
 */
export async function acquireNativeHistoryLease(input: {
  home: string;
  scope: string;
  provider: HistoryProvider;
  writer: WorkspaceConversationWriter;
  previousWriterExited?(writer: WorkspaceConversationWriter): Promise<boolean>;
}): Promise<{ verify(): Promise<boolean> } | undefined> {
  const { home, scope, provider, writer } = input;
  const expectedRunRoot = path.dirname(path.dirname(scope));
  if (!validWriter(writer) || (writer.provider !== undefined && writer.provider !== provider) ||
      (writer.storageHome !== undefined && writer.storageHome !== home) ||
      path.basename(expectedRunRoot) !== writer.runId ||
      path.basename(path.dirname(scope)) !== privateConversationDirectory ||
      !scopeIdPattern.test(path.basename(scope)) ||
      home === scope || home.startsWith(scope + path.sep) || scope.startsWith(home + path.sep)) return undefined;
  const lease = path.join(home, nativeHistoryLeaseDirectory);
  let previous: WorkspaceConversationWriter;
  try {
    if (!await privateDirectory(home) || !await privateDirectory(scope) ||
        !await privateDirectory(path.dirname(scope)) || await exists(path.join(home, nativeHistoryRetiringDirectory)) ||
        (await readdir(home)).some(name => (providerHistoryDirectories[provider] as readonly string[]).includes(name))) {
      return undefined;
    }
    const owner = await readPrivateOwner(scope);
    if (!validWriter(owner) || owner.provider !== writer.provider || owner.storageHome !== writer.storageHome ||
        owner.tenant !== writer.tenant || owner.runId !== writer.runId ||
        owner.generation !== writer.generation) return undefined;
    previous = owner;
    await mkdir(lease, { mode: 0o700 });
    if (await exists(path.join(home, nativeHistoryRetiringDirectory))) {
      await rmdir(lease);
      return undefined;
    }
  } catch { return undefined; }

  const marker = { provider, scope, writer } satisfies NativeHistoryLeaseMarker;
  try {
    if (previous.writerIdentity !== writer.writerIdentity || previous.descendantGroup !== writer.descendantGroup) {
      if (!await input.previousWriterExited?.(previous)) {
        await rmdir(lease);
        return undefined;
      }
      // The caller owns this run's workspace mutation while changing writers.
      // The pruner must see the new writer before native history is writable.
      const pending = path.join(scope, '.owner-' + randomUUID());
      const handle = await open(pending, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(writer));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(pending, path.join(scope, 'owner.json'));
      await syncPrivateDirectory(scope);
    }
    const owner = await open(path.join(lease, 'owner.json'), 'wx', 0o600);
    try {
      await owner.writeFile(JSON.stringify(marker));
      await owner.sync();
    } finally { await owner.close(); }
    await syncPrivateDirectory(lease);
    await syncPrivateDirectory(home);

    // Refuse existing history dirs. This avoids taking over a regular login
    // home or unlinking sessions left by a different writer.
    if (!await historyLinksMatch(home, marker, true) ||
        (await readdir(home)).some(name => (providerHistoryDirectories[provider] as readonly string[]).includes(name))) {
      return undefined;
    }
    for (const name of providerHistoryDirectories[provider]) {
      const target = path.join(scope, name);
      try { await mkdir(target, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (!await privateDirectory(target)) return undefined;
      await symlink(target, path.join(home, name), 'dir');
    }
    await syncPrivateDirectory(scope);
    await syncPrivateDirectory(home);
    return {
      async verify() {
        try {
          const actual = await readNativeHistoryLease(lease);
          return actual.provider === provider && actual.scope === scope &&
            actual.writer.writerIdentity === writer.writerIdentity &&
            actual.writer.descendantGroup === writer.descendantGroup &&
            actual.writer.runId === writer.runId && actual.writer.tenant === writer.tenant &&
            actual.writer.generation === writer.generation && actual.writer.storageHome === writer.storageHome &&
            await historyLinksMatch(home, actual, false);
        } catch { return false; }
      }
    };
  } catch {
    // A partial lease is durable. Leave it for recovery rather than redirect
    // another process while the previous writer state could be uncertain.
    return undefined;
  }
}

/**
 * Unlink only the expected redirections. The host runs under its existing
 * single-dispatcher ownership. Rename first so a restart can retry a partially
 * completed release and a new lease cannot race the old link cleanup.
 */
export async function releaseNativeHistoryLease(input: {
  home: string;
  writerExited(writer: WorkspaceConversationWriter): Promise<boolean>;
}): Promise<boolean> {
  const { home } = input;
  if (releasingNativeHomes.has(home)) return false;
  releasingNativeHomes.add(home);
  const lease = path.join(home, nativeHistoryLeaseDirectory);
  const retiring = path.join(home, nativeHistoryRetiringDirectory);
  try {
    if (!await privateDirectory(home)) return false;
    const alreadyRetiring = await exists(retiring);
    const marker = await readNativeHistoryLease(alreadyRetiring ? retiring : lease);
    if ((marker.writer.storageHome !== undefined && marker.writer.storageHome !== home) ||
        !await historyLinksMatch(home, marker, true) || !await input.writerExited(marker.writer)) return false;
    if (!alreadyRetiring) {
      await rename(lease, retiring);
      await syncPrivateDirectory(home);
    }
    for (const name of providerHistoryDirectories[marker.provider]) {
      const link = path.join(home, name);
      if (await readlink(link).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }) === path.join(marker.scope, name)) await unlink(link);
    }
    await syncPrivateDirectory(home);
    // Commit release atomically while the evidence still exists. A crash
    // between clearing the marker and rmdir must not strand an opaque lease.
    const released = path.join(home, '.autocatalyst-history-released-' + randomUUID());
    await rename(retiring, released);
    await syncPrivateDirectory(home);
    await unlink(path.join(released, 'owner.json')).then(() => rmdir(released)).catch(() => undefined);
    return true;
  } catch { return false; }
  finally { releasingNativeHomes.delete(home); }
}
