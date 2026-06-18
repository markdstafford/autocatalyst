import type { NonModelPrincipal } from '@autocatalyst/api-contract';
import type { ControlPlaneService, ServiceReconcilePullRequestsResult } from '@autocatalyst/core';

export interface PullRequestReconciliationTickerOptions {
  readonly controlPlane: ControlPlaneService;
  readonly principal: NonModelPrincipal;
  readonly tenant: string;
  readonly intervalMs: number;
  readonly logger?: {
    readonly warn: (message: string, details?: unknown) => void;
    readonly info?: (message: string, details?: unknown) => void;
  };
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}

export type PullRequestReconciliationTickerRunResult =
  | { readonly status: 'completed'; readonly result: ServiceReconcilePullRequestsResult }
  | { readonly status: 'skipped'; readonly reason: 'in_flight' }
  | { readonly status: 'failed'; readonly errorCode: 'reconciliation_failed' };

export class PullRequestReconciliationTicker {
  readonly #controlPlane: ControlPlaneService;
  readonly #principal: NonModelPrincipal;
  readonly #tenant: string;
  readonly #intervalMs: number;
  readonly #logger: PullRequestReconciliationTickerOptions['logger'];
  readonly #setInterval: typeof globalThis.setInterval;
  readonly #clearInterval: typeof globalThis.clearInterval;
  #timer: ReturnType<typeof globalThis.setInterval> | undefined;
  #inFlight = false;

  constructor(options: PullRequestReconciliationTickerOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 1)
      throw new Error('Pull-request reconciliation ticker intervalMs must be a positive integer.');
    if (options.tenant.trim().length === 0)
      throw new Error('Pull-request reconciliation ticker tenant must be non-empty.');
    if (options.tenant !== options.principal.tenantId)
      throw new Error('Pull-request reconciliation ticker tenant must match principal tenantId.');
    this.#controlPlane = options.controlPlane;
    this.#principal = options.principal;
    this.#tenant = options.tenant;
    this.#intervalMs = options.intervalMs;
    this.#logger = options.logger;
    this.#setInterval = options.setInterval ?? globalThis.setInterval;
    this.#clearInterval = options.clearInterval ?? globalThis.clearInterval;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#setInterval(() => { void this.runOnce(); }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer === undefined) return;
    this.#clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<PullRequestReconciliationTickerRunResult> {
    if (this.#inFlight) return { status: 'skipped', reason: 'in_flight' };
    this.#inFlight = true;
    try {
      const result = await this.#controlPlane.reconcilePullRequests({ principal: this.#principal, tenant: this.#tenant });
      return { status: 'completed', result };
    } catch {
      this.#logger?.warn('Pull-request reconciliation ticker pass failed.', { tenant: this.#tenant, errorCode: 'reconciliation_failed' });
      return { status: 'failed', errorCode: 'reconciliation_failed' };
    } finally {
      this.#inFlight = false;
    }
  }
}

export function createPullRequestReconciliationTicker(
  options: PullRequestReconciliationTickerOptions
): PullRequestReconciliationTicker {
  return new PullRequestReconciliationTicker(options);
}
