import { describe, it, expect, vi } from 'vitest';
import {
  findingSignature,
  isBlockingFinding,
  computeCurrentBlockingSet,
  detectOscillation,
  resolveReviewedRoutes
} from './convergence-engine.js';
import type { ReviewerFinding } from '@autocatalyst/api-contract';
import type { ModelRoutingResolver, ModelRoutingResolution } from './model-routing-resolver.js';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';

const warnFinding: ReviewerFinding = { title: 'Missing test', body: 'Add coverage for edge case.', severity: 'warning' };
const blockerFinding: ReviewerFinding = { title: 'Security hole', body: 'SQL injection risk.', severity: 'blocker' };
const infoFinding: ReviewerFinding = { title: 'Style note', body: 'Consider renaming.', severity: 'info' };

describe('findingSignature', () => {
  it('produces stable signature for same finding', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature(warnFinding);
    expect(sig1).toBe(sig2);
  });

  it('produces different signatures for different severities', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature({ ...warnFinding, severity: 'blocker' });
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different titles', () => {
    const sig1 = findingSignature(warnFinding);
    const sig2 = findingSignature({ ...warnFinding, title: 'Different title' });
    expect(sig1).not.toBe(sig2);
  });
});

describe('isBlockingFinding', () => {
  it('info is never blocking', () => {
    expect(isBlockingFinding(infoFinding, [])).toBe(false);
  });

  it('warning is blocking when not declined', () => {
    expect(isBlockingFinding(warnFinding, [])).toBe(true);
  });

  it('blocker is blocking when not declined', () => {
    expect(isBlockingFinding(blockerFinding, [])).toBe(true);
  });

  it('warning is non-blocking when its signature is in declined set', () => {
    const sig = findingSignature(warnFinding);
    expect(isBlockingFinding(warnFinding, [sig])).toBe(false);
  });
});

describe('detectOscillation', () => {
  it('returns false with no previous rounds', () => {
    expect(detectOscillation([], ['sig-1'])).toBe(false);
  });

  it('detects repeated blocking signature after implementer had chance to respond', () => {
    // Round 1 had a finding with same signature, implementer had a chance
    const previousRounds = [{
      round: 1,
      changedFileCount: 0,
      findings: [{ feedbackId: 'fb-1', title: 'Missing test', body: 'Add coverage for edge case.', severity: 'warning' as const, blocking: true, signature: 'sig-1' }],
      dispositions: [],
      outcome: 'continue' as const
    }];
    expect(detectOscillation(previousRounds, ['sig-1'])).toBe(true);
  });

  it('detects non-decreasing blocking count when implementer had at least one chance', () => {
    const previousRounds = [
      { round: 1, changedFileCount: 0, findings: [
        { feedbackId: 'fb-1', title: 'A', body: 'B', severity: 'warning' as const, blocking: true, signature: 'sig-1' },
        { feedbackId: 'fb-2', title: 'C', body: 'D', severity: 'blocker' as const, blocking: true, signature: 'sig-2' }
      ], dispositions: [], outcome: 'continue' as const }
    ];
    // Current blocking set has 2 or more items (non-decreasing from round 1's 2)
    expect(detectOscillation(previousRounds, ['sig-1', 'sig-2', 'sig-3'])).toBe(true);
  });

  it('does not trigger oscillation on first round', () => {
    // No previous rounds = no oscillation possible
    expect(detectOscillation([], ['sig-1', 'sig-2'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveReviewedRoutes
// ---------------------------------------------------------------------------

function makeResolution(profileId: string): ModelRoutingResolution {
  return {
    routeId: `route-${profileId}`,
    profileId,
    routingTableId: 'table-1',
    profile: {
      mode: 'agent',
      providerKind: 'anthropic',
      adapterId: 'claude-code',
      configurationRecordId: profileId,
      model: { model: `model-${profileId}` },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'process_environment'
    },
    credentialReference: {
      required: true,
      secretHandle: 'handle',
      authTarget: 'process_environment'
    }
  };
}

describe('resolveReviewedRoutes', () => {
  it('calls resolveDistinctAgentRoutes with implementer and reviewer roles', async () => {
    const implementerResolution = makeResolution('profile-impl');
    const reviewerResolution = makeResolution('profile-rev');

    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn(),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockResolvedValue({
        step: 'produce',
        distinctBy: 'model',
        resolutionsByRole: {
          implementer: implementerResolution,
          reviewer: reviewerResolution
        }
      })
    };

    const result = await resolveReviewedRoutes({
      tenant: 'tenant-1',
      runId: 'run-1',
      step: 'produce',
      routing
    });

    expect(routing.resolveDistinctAgentRoutes).toHaveBeenCalledWith({
      tenant: 'tenant-1',
      runId: 'run-1',
      step: 'produce',
      roles: ['implementer', 'reviewer']
    });
    expect(result.implementerRoute).toBe(implementerResolution);
    expect(result.reviewerRoute).toBe(reviewerResolution);
    expect(result.routingInfo.distinct).toBe(true);
  });

  it('falls back to single-route when distinctness fails and logs a sanitized warning', async () => {
    const implementerResolution = makeResolution('profile-same');
    const reviewerResolution = makeResolution('profile-same');

    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn()
        .mockResolvedValueOnce(implementerResolution)
        .mockResolvedValueOnce(reviewerResolution),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError(
          'role_distinct_unsatisfied',
          'Resolved roles do not satisfy the distinct-model requirement.',
          { tenant: 'tenant-1', runId: 'run-1', step: 'produce', roles: ['implementer', 'reviewer'], distinctBy: 'model' }
        )
      )
    };

    const logger = { warn: vi.fn() };

    const result = await resolveReviewedRoutes({
      tenant: 'tenant-1',
      runId: 'run-1',
      step: 'produce',
      routing,
      logger
    });

    expect(result.implementerRoute).toBe(implementerResolution);
    expect(result.reviewerRoute).toBe(reviewerResolution);
    expect(result.routingInfo.distinct).toBe(false);
    expect(result.routingInfo.warningCode).toBe('role_distinct_unsatisfied');
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('warning does not include credential data or raw prompts', async () => {
    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn()
        .mockResolvedValueOnce(makeResolution('profile-a'))
        .mockResolvedValueOnce(makeResolution('profile-b')),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError(
          'role_distinct_unsatisfied',
          'Resolved roles do not satisfy the distinct-model requirement.',
          { tenant: 'tenant-1', runId: 'run-2', step: 'produce', roles: ['implementer', 'reviewer'], distinctBy: 'model' }
        )
      )
    };

    const warnCalls: Array<[string, Record<string, unknown>]> = [];
    const logger = {
      warn: (msg: string, details: Record<string, unknown>) => {
        warnCalls.push([msg, details]);
      }
    };

    await resolveReviewedRoutes({
      tenant: 'tenant-1',
      runId: 'run-2',
      step: 'produce',
      routing,
      logger
    });

    expect(warnCalls.length).toBeGreaterThan(0);

    for (const [msg, details] of warnCalls) {
      const serialized = JSON.stringify({ msg, details });
      // Must not contain credential patterns
      expect(serialized).not.toMatch(/sk-/);
      expect(serialized).not.toMatch(/password/i);
      expect(serialized).not.toMatch(/secret/i);
      expect(serialized).not.toMatch(/credential/i);
      // Must contain safe fields
      expect(details['runId']).toBe('run-2');
      expect(details['step']).toBe('produce');
      expect(details['warningCode']).toBe('role_distinct_unsatisfied');
    }
  });

  it('fails safely when no route is available at all', async () => {
    const routing: ModelRoutingResolver = {
      resolveAgentRoute: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError('route_not_found', 'No route found for the requested key.')
      ),
      resolveDirectRoute: vi.fn(),
      resolveDistinctAgentRoutes: vi.fn().mockRejectedValue(
        new ModelRoutingConfigurationError('route_not_found', 'No route found for the requested key.')
      )
    };

    await expect(
      resolveReviewedRoutes({
        tenant: 'tenant-1',
        runId: 'run-3',
        step: 'produce',
        routing
      })
    ).rejects.toThrow(ModelRoutingConfigurationError);
  });
});
