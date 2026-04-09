import type { LoadedConfig } from '../types/config.js';
import { createLogger } from './logger.js';
import type pino from 'pino';

interface ServiceOptions {
  logDestination?: pino.DestinationStream;
}

export class Service {
  private config: LoadedConfig;
  private logger: pino.Logger;
  private running = false;
  private stopping = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private _stopped: Promise<void>;
  private _resolveStopped!: () => void;

  constructor(config: LoadedConfig, options?: ServiceOptions) {
    this.config = config;
    this.logger = createLogger('service', { destination: options?.logDestination });
    this._stopped = new Promise(resolve => {
      this._resolveStopped = resolve;
    });
  }

  get stopped(): Promise<void> {
    return this._stopped;
  }

  updateConfig(config: LoadedConfig): void {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const intervalMs = this.config.config.polling?.interval_ms ?? 30000;
    this.tickTimer = setInterval(() => this.tick(), intervalMs);

    this.logger.info({ event: 'service.ready' }, 'Service is ready');
  }

  stop(): void {
    if (this.stopping || !this.running) {
      return; // no-op: either already stopping or never started
    }
    this.stopping = true;

    this.logger.info({ event: 'service.stopping' }, 'Shutting down');

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    this.running = false;
    this.stopping = false;

    this.logger.info({ event: 'service.stopped' }, 'Shutdown complete');
    this._resolveStopped();
  }

  private tick(): void {
    // No-op for now — future features register tick handlers
  }
}
