import { describe, expect, it, vi } from 'vitest';

import type { NonModelPrincipal } from '@autocatalyst/api-contract';
import type { ControlPlaneService, ServiceReconcilePullRequestsResult } from '@autocatalyst/core';

import { PullRequestReconciliationTicker } from './pr-reconciliation-ticker.js';

const tenant = 'tenant_dev';

const principal: NonModelPrincipal = {
  kind: 'system',
  id: 'principal_system_reconciliation',
  tenantId: tenant
};

function makeControlPlane(
  reconcile: () => Promise<ServiceReconcilePullRequestsResult> = async () => ({ merged: [], skipped: [] })
): ControlPlaneService {
  return {
    reconcilePullRequests: vi.fn(reconcile)
  } as unknown as ControlPlaneService;
}

describe('PullRequestReconciliationTicker — constructor validation', () => {
  it('throws for zero intervalMs', () => {
    expect(() => new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 0
    })).toThrow('Pull-request reconciliation ticker intervalMs must be a positive integer.');
  });

  it('throws for negative intervalMs', () => {
    expect(() => new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: -1
    })).toThrow('Pull-request reconciliation ticker intervalMs must be a positive integer.');
  });

  it('throws for non-integer intervalMs', () => {
    expect(() => new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 1.5
    })).toThrow('Pull-request reconciliation ticker intervalMs must be a positive integer.');
  });

  it('throws for empty tenant', () => {
    expect(() => new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal: { kind: 'system', id: 'id', tenantId: '   ' },
      tenant: '   ',
      intervalMs: 1000
    })).toThrow('Pull-request reconciliation ticker tenant must be non-empty.');
  });

  it('throws when tenant does not match principal.tenantId', () => {
    expect(() => new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal: { kind: 'system', id: 'id', tenantId: 'tenant_a' },
      tenant: 'tenant_b',
      intervalMs: 1000
    })).toThrow('Pull-request reconciliation ticker tenant must match principal tenantId.');
  });

  it('constructs successfully with valid options', () => {
    expect(() => new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 1000
    })).not.toThrow();
  });
});

describe('PullRequestReconciliationTicker — runOnce()', () => {
  it('calls reconcilePullRequests and returns completed status', async () => {
    const fakeResult: ServiceReconcilePullRequestsResult = { merged: [], skipped: [] };
    const controlPlane = makeControlPlane(async () => fakeResult);
    const ticker = new PullRequestReconciliationTicker({ controlPlane, principal, tenant, intervalMs: 1000 });

    const result = await ticker.runOnce();

    expect(result).toEqual({ status: 'completed', result: fakeResult });
    expect(controlPlane.reconcilePullRequests).toHaveBeenCalledWith({ principal, tenant });
  });

  it('returns skipped when another pass is in flight', async () => {
    let resolveFirst!: () => void;
    const firstCallPromise = new Promise<void>((resolve) => { resolveFirst = resolve; });

    const controlPlane = makeControlPlane(() => firstCallPromise.then(() => ({ merged: [], skipped: [] })));
    const ticker = new PullRequestReconciliationTicker({ controlPlane, principal, tenant, intervalMs: 1000 });

    // Start the first call but don't await it yet
    const firstCall = ticker.runOnce();
    // Immediately make a second call — should be skipped since first is in-flight
    const secondResult = await ticker.runOnce();

    expect(secondResult).toEqual({ status: 'skipped', reason: 'in_flight' });

    // Now let the first call complete
    resolveFirst();
    const firstResult = await firstCall;
    expect(firstResult).toEqual({ status: 'completed', result: { merged: [], skipped: [] } });
  });

  it('catches service errors, calls logger.warn, and returns failed status', async () => {
    const controlPlane = makeControlPlane(async () => { throw new Error('service error'); });
    const warnSpy = vi.fn();
    const ticker = new PullRequestReconciliationTicker({
      controlPlane,
      principal,
      tenant,
      intervalMs: 1000,
      logger: { warn: warnSpy }
    });

    const result = await ticker.runOnce();

    expect(result).toEqual({ status: 'failed', errorCode: 'reconciliation_failed' });
    expect(warnSpy).toHaveBeenCalledOnce();
    // Verify warn message does not include token/secret-like content
    const [message, details] = warnSpy.mock.calls[0] as [string, unknown];
    expect(message).toBe('Pull-request reconciliation ticker pass failed.');
    expect(details).toMatchObject({ tenant, errorCode: 'reconciliation_failed' });
  });

  it('resets inFlight flag after completion so subsequent calls can proceed', async () => {
    const fakeResult: ServiceReconcilePullRequestsResult = { merged: [], skipped: [] };
    const controlPlane = makeControlPlane(async () => fakeResult);
    const ticker = new PullRequestReconciliationTicker({ controlPlane, principal, tenant, intervalMs: 1000 });

    await ticker.runOnce();
    const result = await ticker.runOnce();
    expect(result).toEqual({ status: 'completed', result: fakeResult });
  });
});

describe('PullRequestReconciliationTicker — start() and stop()', () => {
  function makeInjectableTimers() {
    const timers: ReturnType<typeof setInterval>[] = [];
    const setIntervalMock = vi.fn((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      timers.push(id);
      return id;
    });
    const clearIntervalMock = vi.fn((id) => { clearInterval(id); });
    return { timers, setIntervalMock, clearIntervalMock };
  }

  it('calls setInterval with configured intervalMs on start()', () => {
    const { setIntervalMock, clearIntervalMock, timers } = makeInjectableTimers();
    const ticker = new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 5000,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    });

    ticker.start();

    expect(setIntervalMock).toHaveBeenCalledOnce();
    expect(setIntervalMock.mock.calls[0]?.[1]).toBe(5000);

    // Cleanup
    for (const id of timers) clearInterval(id);
  });

  it('second start() is idempotent — does not create another timer', () => {
    const { setIntervalMock, clearIntervalMock, timers } = makeInjectableTimers();
    const ticker = new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 5000,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    });

    ticker.start();
    ticker.start();

    expect(setIntervalMock).toHaveBeenCalledOnce();

    // Cleanup
    for (const id of timers) clearInterval(id);
  });

  it('stop() calls clearInterval with the timer id', () => {
    const { setIntervalMock, clearIntervalMock } = makeInjectableTimers();
    const ticker = new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 5000,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    });

    ticker.start();
    const timerId = setIntervalMock.mock.results[0]?.value;
    ticker.stop();

    expect(clearIntervalMock).toHaveBeenCalledOnce();
    expect(clearIntervalMock.mock.calls[0]?.[0]).toBe(timerId);
  });

  it('second stop() is idempotent — does not call clearInterval again', () => {
    const { setIntervalMock, clearIntervalMock } = makeInjectableTimers();
    const ticker = new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 5000,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    });

    ticker.start();
    ticker.stop();
    ticker.stop();

    expect(clearIntervalMock).toHaveBeenCalledOnce();
  });

  it('stop() before start() is a no-op', () => {
    const { setIntervalMock, clearIntervalMock } = makeInjectableTimers();
    const ticker = new PullRequestReconciliationTicker({
      controlPlane: makeControlPlane(),
      principal,
      tenant,
      intervalMs: 5000,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    });

    expect(() => ticker.stop()).not.toThrow();
    expect(clearIntervalMock).not.toHaveBeenCalled();
  });
});
