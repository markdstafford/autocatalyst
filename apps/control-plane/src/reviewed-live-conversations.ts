import { randomUUID } from 'node:crypto';
import { NativeResumeRefused, type NativeConversationTurn } from '@autocatalyst/execution';

type MemoryTurn = Extract<NativeConversationTurn, { mode: 'in_memory' }>;
type Resource = NonNullable<MemoryTurn['resource']>;
type Retired = 'expired' | 'evicted' | 'workspace_changed' | 'run_terminal';
export type LiveAdmissionReason = Retired | 'no_prior' | 'compatible' | 'repair_adopted' | 'scope_changed' |
  'pr_changed' | 'active' | 'capacity' | 'shutdown';

interface LiveScope {
  readonly key: string;
  readonly run: string;
  readonly generation: string;
  readonly compatibility: string;
  readonly specPath?: string;
  readonly prIdentity?: string;
  readonly verifyWorkspace: () => Promise<boolean>;
  readonly verifyLaunch: MemoryTurn['verifyLaunch'];
}

interface Entry {
  readonly scope: Pick<LiveScope, 'key' | 'run' | 'generation' | 'compatibility' | 'prIdentity'>;
  readonly id: string;
  resource: Resource | undefined;
  specPath: string | undefined;
  active: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  check?: ReturnType<typeof setInterval>;
}

const idleLimitMs = 48 * 60 * 60 * 1000;
const workspaceCheckMs = 15 * 60 * 1000;

function close(resource?: Resource): void {
  try { resource?.close(); } catch { /* A provider cleanup failure cannot undo retirement. */ }
}

/** Exclusive leases; only accepted native turns can become idle and reusable. */
export class ReviewedLiveConversations {
  readonly #entries = new Map<string, Entry>();
  readonly #retired = new Map<string, Retired>();
  #closed = false;

  constructor(private readonly capacity = 16) {}

  open(scope: LiveScope) {
    const previous = this.#entries.get(scope.key);
    if (this.#closed) return { reason: 'shutdown' as const };
    if (previous?.active) return { reason: 'active' as const };
    let resource: Resource | undefined;
    let id: string = randomUUID();
    let reason: LiveAdmissionReason = this.#retired.get(scope.key) ?? 'no_prior';
    if (previous) {
      this.#remove(previous);
      if (previous.scope.compatibility !== scope.compatibility || previous.specPath !== scope.specPath) {
        reason = 'scope_changed';
      } else if (previous.scope.prIdentity !== undefined && previous.scope.prIdentity !== scope.prIdentity) {
        reason = 'pr_changed';
      } else {
        resource = previous.resource;
        id = previous.id;
        reason = previous.scope.prIdentity === scope.prIdentity ? 'compatible' : 'repair_adopted';
      }
      if (!resource) close(previous.resource);
    }
    if (this.#entries.size >= this.capacity) {
      const victim = [...this.#entries.values()].find(entry => !entry.active);
      if (!victim) return { reason: 'capacity' as const };
      this.#retire(victim, 'evicted');
    }
    this.#retired.delete(scope.key);
    const { key, run, generation, compatibility, prIdentity, verifyWorkspace } = scope;
    const entry: Entry = { scope: { key, run, generation, compatibility, ...(prIdentity ? { prIdentity } : {}) },
      id, resource, specPath: scope.specPath, active: true };
    this.#entries.set(scope.key, entry);
    const owns = () => this.#entries.get(scope.key) === entry && entry.active;
    let completed = false;
    const turn: MemoryTurn = {
      mode: 'in_memory', ...(resource ? { resource } : {}),
      verifyLaunch: async () => {
        if (!owns()) return false;
        if (await scope.verifyLaunch()) return owns();
        this.#retire(entry, 'workspace_changed');
        return false;
      },
      submitting() {
        if (!owns()) throw new NativeResumeRefused('workspace_unverified', false);
      },
      ready: live => {
        if (!owns()) {
          // Retirement already closed the borrowed resource.
          if (live !== entry.resource) close(live);
          return;
        }
        if (live !== entry.resource) close(entry.resource);
        entry.resource = live;
        completed = true;
      }
    };
    return {
      turn, reason, id,
      finish: (accepted: boolean, acceptedSpecPath?: string) => {
        if (!owns()) return;
        if (!accepted || !completed || !entry.resource) {
          this.#retire(entry);
          return;
        }
        entry.specPath = acceptedSpecPath ?? entry.specPath;
        entry.active = false;
        // Order by last completed use, not by first admission.
        this.#entries.delete(scope.key);
        this.#entries.set(scope.key, entry);
        entry.expiry = setTimeout(() => this.#retire(entry, 'expired'), idleLimitMs);
        entry.expiry.unref();
        let checking = false;
        entry.check = setInterval(() => {
          if (checking) return;
          checking = true;
          void verifyWorkspace().catch(() => false).then(valid => {
            if (!valid) this.#retire(entry, 'workspace_changed');
          }).finally(() => { checking = false; });
        }, workspaceCheckMs);
        entry.check.unref();
      }
    };
  }

  discard(key: string): void {
    const entry = this.#entries.get(key);
    if (entry && !entry.active) this.#retire(entry);
  }

  retireRun(run: string, reason: 'run_terminal' | 'workspace_changed', currentGeneration?: string): void {
    for (const entry of this.#entries.values()) {
      if (entry.scope.run === run && (currentGeneration === undefined || entry.scope.generation !== currentGeneration)) {
        this.#retire(entry, reason);
      }
    }
  }

  #remove(entry: Entry): void {
    this.#entries.delete(entry.scope.key);
    clearTimeout(entry.expiry);
    clearInterval(entry.check);
  }

  #retire(entry: Entry, reason?: Retired): void {
    if (this.#entries.get(entry.scope.key) !== entry) return;
    this.#remove(entry);
    close(entry.resource);
    if (!reason) return;
    this.#retired.delete(entry.scope.key);
    this.#retired.set(entry.scope.key, reason);
    while (this.#retired.size > this.capacity) {
      const oldest = this.#retired.keys().next().value;
      if (oldest === undefined) break;
      this.#retired.delete(oldest);
    }
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) this.#retire(entry);
    this.#retired.clear();
  }
}

export const reviewedLiveRunKey = (tenant: string, runId: string): string => JSON.stringify([tenant, runId]);
