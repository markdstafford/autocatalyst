import { createHash } from 'node:crypto';
import type { ReviewerFinding, ConvergenceRoundRecord } from '@autocatalyst/api-contract';
import type {
  ModelRoutingResolver,
  ModelRoutingResolution
} from './model-routing-resolver.js';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';

export function findingSignature(finding: ReviewerFinding): string {
  const normalized = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const bodyHash = createHash('sha256')
    .update(normalized(finding.body))
    .digest('hex')
    .slice(0, 16);
  const anchor = finding.anchor !== undefined ? JSON.stringify(finding.anchor) : '';
  return `${finding.severity}:${normalized(finding.title)}:${bodyHash}:${anchor}`;
}

export function isBlockingFinding(finding: ReviewerFinding, declinedSignatures: readonly string[]): boolean {
  if (finding.severity === 'info') return false;
  const sig = findingSignature(finding);
  return !declinedSignatures.includes(sig);
}

export function computeCurrentBlockingSet(
  findings: readonly ReviewerFinding[],
  declinedSignatures: readonly string[]
): readonly string[] {
  return findings
    .filter(f => isBlockingFinding(f, declinedSignatures))
    .map(f => findingSignature(f));
}

export function detectOscillation(
  previousRounds: readonly ConvergenceRoundRecord[],
  currentBlockingSignatures: readonly string[]
): boolean {
  if (previousRounds.length === 0) return false;

  const lastRound = previousRounds[previousRounds.length - 1];
  if (lastRound === undefined) return false;

  const previousBlockingSignatures = lastRound.findings
    .filter(f => f.blocking)
    .map(f => f.signature);

  const repeatedSignature = currentBlockingSignatures.some(sig => previousBlockingSignatures.includes(sig));
  if (repeatedSignature) return true;

  if (currentBlockingSignatures.length >= previousBlockingSignatures.length && previousBlockingSignatures.length > 0) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Route resolution for reviewed steps
// ---------------------------------------------------------------------------

export interface ResolvedReviewedRoutes {
  readonly implementerRoute: ModelRoutingResolution;
  readonly reviewerRoute: ModelRoutingResolution;
  readonly routingInfo: {
    readonly distinct: boolean;
    readonly warningCode?: string;
  };
}

export interface ResolveReviewedRoutesInput {
  readonly tenant: string;
  readonly runId?: string;
  readonly step: string;
  readonly routing: ModelRoutingResolver;
  readonly logger?: {
    warn(message: string, details: Record<string, unknown>): void;
  };
}

export async function resolveReviewedRoutes(
  input: ResolveReviewedRoutesInput
): Promise<ResolvedReviewedRoutes> {
  const { tenant, runId, step, routing, logger } = input;

  // Attempt distinct resolution first
  try {
    const distinct = await routing.resolveDistinctAgentRoutes({
      tenant,
      runId,
      step,
      roles: ['implementer', 'reviewer']
    });

    return {
      implementerRoute: distinct.resolutionsByRole['implementer']!,
      reviewerRoute: distinct.resolutionsByRole['reviewer']!,
      routingInfo: { distinct: true }
    };
  } catch (err) {
    // Only fall back on role_distinct_unsatisfied; re-throw everything else
    if (
      !(err instanceof ModelRoutingConfigurationError) ||
      err.code !== 'role_distinct_unsatisfied'
    ) {
      throw err;
    }

    // Log a sanitized warning — safe fields only, no credentials or raw config
    if (logger !== undefined) {
      const safeDetails = err.safeDetails;
      logger.warn('route_distinct_unsatisfied: falling back to per-role resolution', {
        runId: runId ?? null,
        step,
        roles: ['implementer', 'reviewer'],
        distinctBy: safeDetails?.distinctBy ?? null,
        warningCode: 'role_distinct_unsatisfied'
      });
    }

    // Fall back to resolving each role independently
    const [implementerRoute, reviewerRoute] = await Promise.all([
      routing.resolveAgentRoute({ tenant, runId, step, role: 'implementer' }),
      routing.resolveAgentRoute({ tenant, runId, step, role: 'reviewer' })
    ]);

    return {
      implementerRoute,
      reviewerRoute,
      routingInfo: { distinct: false, warningCode: 'role_distinct_unsatisfied' }
    };
  }
}
