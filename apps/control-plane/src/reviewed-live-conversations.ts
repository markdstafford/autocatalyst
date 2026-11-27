import type { NativeConversationTurn } from '@autocatalyst/execution';

type MemoryTurn = Extract<NativeConversationTurn, { mode: 'in_memory' }>;
type Resource = NonNullable<MemoryTurn['resource']>;

/** One idle conversation per eligible run/step/role, with exclusive ownership through result validation. */
export class ReviewedLiveConversations {
  readonly #entries = new Map<string, {
    compatibility: string;
    resource: Resource | undefined;
    timer: ReturnType<typeof setTimeout> | undefined;
    active: boolean;
  }>();
  #closed = false;

  open(scope: string, compatibility: string, verifyLaunch: MemoryTurn['verifyLaunch']) {
    const previous = this.#entries.get(scope);
    if (this.#closed || previous?.active) return undefined;
    let resource: Resource | undefined;
    if (previous) {
      clearTimeout(previous.timer);
      if (previous.compatibility === compatibility) resource = previous.resource;
      else previous.resource?.close();
      this.#entries.delete(scope);
    }
    if (this.#entries.size >= 16) {
      const victim = [...this.#entries].find(([, entry]) => !entry.active);
      if (!victim) return undefined;
      clearTimeout(victim[1].timer);
      victim[1].resource?.close();
      this.#entries.delete(victim[0]);
    }
    const entry = { compatibility, resource, timer: undefined as ReturnType<typeof setTimeout> | undefined, active: true };
    this.#entries.set(scope, entry);
    let completed = false;
    const turn: MemoryTurn = {
      mode: 'in_memory', ...(resource ? { resource } : {}), verifyLaunch,
      ready: live => {
        if (this.#entries.get(scope) !== entry || !entry.active) {
          live.close();
          return;
        }
        entry.resource = live;
        completed = true;
      }
    };
    return {
      turn,
      finish: (accepted: boolean) => {
        if (this.#entries.get(scope) !== entry || !entry.active) return;
        if (!accepted || !completed || !entry.resource) {
          this.#entries.delete(scope);
          entry.resource?.close();
          return;
        }
        entry.active = false;
        entry.timer = setTimeout(() => {
          this.#entries.delete(scope);
          entry.resource?.close();
        }, 60 * 60 * 1000);
        entry.timer.unref();
      }
    };
  }

  discard(scope: string): void {
    const entry = this.#entries.get(scope);
    if (!entry || entry.active) return;
    this.#entries.delete(scope);
    clearTimeout(entry.timer);
    entry.resource?.close();
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#entries.values()) {
      clearTimeout(entry.timer);
      entry.resource?.close();
    }
    this.#entries.clear();
  }
}
