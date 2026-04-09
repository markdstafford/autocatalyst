import { watch, watchFile, unwatchFile, type FSWatcher, existsSync } from 'node:fs';
import { dirname } from 'node:path';

interface ConfigWatcherOptions {
  onReload: () => void;
  debounceMs?: number;
}

export class ConfigWatcher {
  private filePath: string;
  private onReload: () => void;
  private debounceMs: number;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watching: boolean = false;

  constructor(filePath: string, options: ConfigWatcherOptions) {
    this.filePath = filePath;
    this.onReload = options.onReload;
    this.debounceMs = options.debounceMs ?? 200;
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.attachWatcher();
  }

  stop(): void {
    this.watching = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    unwatchFile(this.filePath);
  }

  private attachWatcher(): void {
    // Use watchFile (stat-based polling) for reliable cross-platform detection
    // including synchronous writes in the same event loop tick
    watchFile(this.filePath, { persistent: false, interval: 10 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        this.scheduleReload();
      }
    });

    // Also use fs.watch for lower latency when available
    try {
      this.watcher = watch(this.filePath, () => {
        this.scheduleReload();
      });

      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
        // watchFile polling continues as fallback
      });
    } catch {
      // watchFile polling is sufficient fallback
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onReload();
    }, this.debounceMs);
  }
}
