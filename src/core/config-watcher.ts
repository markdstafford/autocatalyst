import { watch, watchFile, unwatchFile, type FSWatcher } from 'node:fs';
import type pino from 'pino';
import { createLogger } from './logger.js';

interface ConfigWatcherOptions {
  onReload: () => void;
  debounceMs?: number;
  logDestination?: pino.DestinationStream;
}

export class ConfigWatcher {
  private filePath: string;
  private onReload: () => void;
  private debounceMs: number;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private watching: boolean = false;
  private readonly logger: pino.Logger;

  constructor(filePath: string, options: ConfigWatcherOptions) {
    this.filePath = filePath;
    this.onReload = options.onReload;
    this.debounceMs = options.debounceMs ?? 200;
    this.logger = createLogger('config-watcher', { destination: options.logDestination });
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;
    this.attachWatcher();
    this.logger.info({ event: 'config_watcher.started', file_path: this.filePath }, 'Config watcher started');
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
    this.logger.info({ event: 'config_watcher.stopped', file_path: this.filePath }, 'Config watcher stopped');
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

      this.watcher.on('error', (err) => {
        this.logger.warn(
          { event: 'config_watcher.watch_error', file: this.filePath, error: String(err) },
          'fs.watch error, falling back to polling',
        );
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
    this.logger.debug({ event: 'config_watcher.reload_scheduled', file_path: this.filePath }, 'Config reload scheduled');
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.logger.info({ event: 'config_watcher.reload_fired', file_path: this.filePath }, 'Config reload fired');
      this.onReload();
    }, this.debounceMs);
  }
}
