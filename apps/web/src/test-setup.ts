/**
 * Vitest setup for component tests.
 *
 * - Testing Library auto-cleanup is not wired by default when `globals` is off,
 *   so each test unmounts explicitly here.
 * - jsdom under Node's experimental Web Storage does not reliably expose
 *   `window.localStorage`, so we install a deterministic in-memory Storage when it
 *   is missing. Production code always runs against the real browser Storage.
 */
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

class MemoryStorage implements Storage {
  #data = new Map<string, string>();

  get length(): number {
    return this.#data.size;
  }

  clear(): void {
    this.#data.clear();
  }

  getItem(key: string): string | null {
    return this.#data.has(key) ? (this.#data.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.#data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }
}

function ensureStorage(name: 'localStorage' | 'sessionStorage'): void {
  let usable = false;
  try {
    usable = typeof window[name] === 'object' && window[name] !== null;
    if (usable) {
      window[name].setItem('__probe__', '1');
      window[name].removeItem('__probe__');
    }
  } catch {
    usable = false;
  }
  if (!usable) {
    Object.defineProperty(window, name, {
      configurable: true,
      writable: true,
      value: new MemoryStorage()
    });
  }
}

// Some specs opt into the Node test environment (for example the build-output
// test, which runs a real Vite build). Those have no `window`/DOM, so the
// DOM-dependent setup below is skipped for them.
const HAS_DOM = typeof window !== 'undefined';

if (HAS_DOM) {
  ensureStorage('localStorage');
  ensureStorage('sessionStorage');

  // Base UI's floating-ui positioning (used by the Tooltip wrapper) needs
  // `ResizeObserver`, which jsdom does not implement. Install a no-op observer when
  // it is missing so component tests can mount tooltips. The real browser supplies
  // its own implementation.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class NoopResizeObserver implements ResizeObserver {
      observe(): void {
        /* no-op */
      }

      unobserve(): void {
        /* no-op */
      }

      disconnect(): void {
        /* no-op */
      }
    }
    globalThis.ResizeObserver = NoopResizeObserver;
  }

  afterEach(() => {
    cleanup();
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
  });
}
