import { createHash } from 'node:crypto';
import type {
  ConvergenceCheckpoint,
  ConvergenceRoundFinding,
  ConvergenceRoundRecord,
  ConvergenceRoundOutcome,
  ConvergenceOutcome,
  Feedback,
  FindingDisposition,
  Principal,
  ReviewerFinding,
  ReviewerFindingContext,
  ReviewerResult,
  Run,
  RunStep
} from '@autocatalyst/api-contract';
import { reviewerResultSchema, findingDispositionSchema } from '@autocatalyst/api-contract';
import type {
  ModelRoutingResolver,
  ModelRoutingResolution
} from './model-routing-resolver.js';
import { ModelRoutingConfigurationError } from './model-routing-resolver.js';
import type { FeedbackRepository, RunStepRepository } from './domain-repositories.js';
import type {
  ReviewedRoleDispatcher,
  ReviewedRoleDispatchResult
} from './reviewed-role-dispatcher.js';
import type { RunWorkspaceGitPort } from './run-workspace-git.js';
import { createReviewerFeedback } from './convergence-feedback.js';
import { addressOpenFeedbackForRunTarget } from './feedback-lifecycle.js';
import type { FeedbackLifecycleDependencies } from './feedback-lifecycle.js';
import type { RunStepDefinition, RunStepId } from './run-step-catalog.js';
import type { RunWorkflowDefinition, RunDirective } from './run-workflows.js';
import type { ResolvedStepConvergencePolicy } from './convergence-policy.js';
import { getStepConvergencePolicy } from './convergence-policy.js';
import type { RunWorkResult, WorkspaceContext } from './orchestrator.js';

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

  // Intentionally conservative: escalates even when round N's blockers are entirely new/distinct
  // from round N-1's. False positives pause for a human rather than ship unconverged work.
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
      ...(runId !== undefined ? { runId } : {}),
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
      routing.resolveAgentRoute({ tenant, ...(runId !== undefined ? { runId } : {}), step, role: 'implementer' }),
      routing.resolveAgentRoute({ tenant, ...(runId !== undefined ? { runId } : {}), step, role: 'reviewer' })
    ]);

    return {
      implementerRoute,
      reviewerRoute,
      routingInfo: { distinct: false, warningCode: 'role_distinct_unsatisfied' }
    };
  }
}

// ---------------------------------------------------------------------------
// Convergence engine
// ---------------------------------------------------------------------------

export class ConvergenceEngineConfigurationError extends Error {
  readonly code: 'missing_roles' | 'unsupported_step';
  constructor(code: 'missing_roles' | 'unsupported_step', message: string) {
    super(message);
    this.name = 'ConvergenceEngineConfigurationError';
    this.code = code;
  }
}

export interface ConvergenceEngineOptions {
  readonly dispatcher: ReviewedRoleDispatcher;
  readonly git: RunWorkspaceGitPort;
  readonly feedback: FeedbackRepository;
  readonly runSteps: RunStepRepository;
  readonly routing: ModelRoutingResolver;
  readonly getPolicy?: (workflow: RunWorkflowDefinition, step: RunStepId) => ResolvedStepConvergencePolicy;
  readonly logger?: { warn(message: string, details?: unknown): void };
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
  readonly reviewerPrincipal?: Principal;
  readonly feedbackLifecycle?: FeedbackLifecycleDependencies;
}

export interface ConvergenceEngineInput {
  readonly runId: string;
  readonly run: Run;
  readonly tenant: string;
  readonly runStep: RunStep;
  readonly stepDefinition: RunStepDefinition;
  readonly workflow: RunWorkflowDefinition;
  readonly workspace?: WorkspaceContext;
  readonly humanGuidance?: string;
}

export type ConvergenceEscalationReason = 'max_rounds' | 'oscillation';

export interface ConvergenceEngineResult {
  readonly workResult: RunWorkResult;
  readonly checkpointResult: ConvergenceCheckpoint;
}

export interface ConvergenceEngine {
  run(input: ConvergenceEngineInput): Promise<ConvergenceEngineResult>;
}

function defaultReviewerPrincipal(tenant: string): Principal {
  return { id: 'reviewer', kind: 'model', tenantId: tenant };
}

function declinedSignaturesFromDispositions(
  dispositions: readonly FindingDisposition[],
  findingsByFeedbackId: ReadonlyMap<string, ReviewerFinding>
): readonly string[] {
  const out: string[] = [];
  for (const d of dispositions) {
    if (d.disposition !== 'declined') continue;
    const finding = findingsByFeedbackId.get(d.feedbackId);
    if (finding === undefined) continue;
    out.push(findingSignature(finding));
  }
  return out;
}

function findingContextFromFeedback(feedback: Feedback, finding: ReviewerFinding): ReviewerFindingContext {
  return {
    feedbackId: feedback.id,
    title: finding.title,
    body: finding.body,
    severity: finding.severity,
    ...(finding.externalId !== undefined ? { externalId: finding.externalId } : {}),
    ...(finding.anchor !== undefined ? { anchor: finding.anchor } : {})
  };
}

export function createConvergenceEngine(options: ConvergenceEngineOptions): ConvergenceEngine {
  const getPolicy = options.getPolicy ?? getStepConvergencePolicy;

  async function runEngine(input: ConvergenceEngineInput): Promise<ConvergenceEngineResult> {
    // ---- Validate step has both roles -------------------------------------
    const roles = input.stepDefinition.roles;
    const hasImplementer = roles.includes('implementer');
    const hasReviewer = roles.includes('reviewer');
    if (!hasImplementer || !hasReviewer) {
      throw new ConvergenceEngineConfigurationError(
        'missing_roles',
        `Step '${input.stepDefinition.id}' must declare both implementer and reviewer roles for convergence.`
      );
    }

    const policy = getPolicy(input.workflow, input.stepDefinition.id);
    const maxRounds = policy.maxRounds;

    // ---- Resolve routes ---------------------------------------------------
    const routes = await resolveReviewedRoutes({
      tenant: input.tenant,
      runId: input.runId,
      step: input.stepDefinition.id,
      routing: options.routing,
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    });

    // ---- State across rounds ----------------------------------------------
    let reviewerPrincipal = options.reviewerPrincipal ?? defaultReviewerPrincipal(input.tenant);
    const rounds: ConvergenceRoundRecord[] = [];
    const accumulatedDeclinedSignatures: string[] = [];
    // Map every persisted finding by feedbackId so future-round dispositions can resolve.
    const findingsByFeedbackId = new Map<string, ReviewerFinding>();
    // Latest round's persisted feedback (used to feed required dispositions next round).
    let lastReviewerFindingContexts: ReviewerFindingContext[] = [];
    let lastBlockingFindingContexts: ReviewerFindingContext[] = [];
    let lastImplementerLastPosition: string | undefined;
    let lastReviewerLastPosition: string | undefined;
    let escalation: ConvergenceEscalationReason | undefined;

    // ---- Construct feedbackLifecycle deps if possible ----------------------
    const feedbackLifecycleDeps: FeedbackLifecycleDependencies | undefined =
      options.idGenerator !== undefined && options.clock !== undefined
        ? { feedback: options.feedback, ids: options.idGenerator, clock: options.clock }
        : options.feedbackLifecycle;

    // Load open implementation feedback from human revisions to seed round 1 context.
    if (feedbackLifecycleDeps !== undefined) {
      const openHumanFeedback = await options.feedback.listByRun(input.runId);
      const openImpl = openHumanFeedback.filter(
        fb => fb.target === 'implementation' && fb.status === 'open'
      );
      if (openImpl.length > 0) {
        lastBlockingFindingContexts = openImpl.map(fb => ({
          feedbackId: fb.id,
          title: fb.title,
          body: fb.body,
          severity: 'blocker' as const
        }));
      }
    }

    let humanGuidance: string | undefined = input.humanGuidance;

    for (let roundNumber = 1; roundNumber <= maxRounds; roundNumber++) {
      // 1) Implementer
      const implReviewContext = lastBlockingFindingContexts.length > 0 || humanGuidance !== undefined
        ? {
            previousRounds: rounds.map(r => r),
            previousFindings: lastReviewerFindingContexts,
            requiredDispositions: lastBlockingFindingContexts.map(c => ({
              feedbackId: c.feedbackId,
              title: c.title,
              severity: c.severity,
              body: c.body
            })),
            routingDistinct: routes.routingInfo.distinct,
            ...(humanGuidance !== undefined ? { humanGuidance } : {})
          }
        : {
            previousRounds: rounds.map(r => r),
            routingDistinct: routes.routingInfo.distinct
          };

      const implDispatch: ReviewedRoleDispatchResult = await options.dispatcher.runRole({
        runId: input.runId,
        run: input.run,
        tenant: input.tenant,
        role: 'implementer',
        round: roundNumber,
        reviewContext: implReviewContext,
        toolPolicyMode: 'write',
        routeProfileId: routes.implementerRoute.profileId,
        route: routes.implementerRoute
      });

      // If implementer asked for input, surface that immediately.
      if (implDispatch.workResult.directive === 'needs_input') {
        return {
          workResult: implDispatch.workResult,
          checkpointResult: buildCheckpoint({
            step: input.stepDefinition.id,
            maxRounds,
            routes,
            rounds,
            outcome: 'needs_input',
            openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
            lastImplementerLastPosition: implDispatch.lastPosition ?? lastImplementerLastPosition,
            lastReviewerLastPosition
          })
        };
      }
      if (implDispatch.workResult.directive === 'fail') {
        return {
          workResult: implDispatch.workResult,
          checkpointResult: buildCheckpoint({
            step: input.stepDefinition.id,
            maxRounds,
            routes,
            rounds,
            outcome: 'max_rounds',
            openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
            lastImplementerLastPosition: implDispatch.lastPosition ?? lastImplementerLastPosition,
            lastReviewerLastPosition
          })
        };
      }
      lastImplementerLastPosition = implDispatch.lastPosition ?? lastImplementerLastPosition;

      // Validate and track declined dispositions from implementer so they become non-blocking going forward.
      const rawImplDispositions = implDispatch.dispositions ?? [];
      const implDispositions: FindingDisposition[] = [];
      for (const raw of rawImplDispositions) {
        const parsedDisposition = findingDispositionSchema.safeParse(raw);
        if (!parsedDisposition.success) {
          return {
            workResult: { directive: 'fail', reason: 'disposition_invalid' },
            checkpointResult: buildCheckpoint({
              step: input.stepDefinition.id,
              maxRounds,
              routes,
              rounds,
              outcome: 'max_rounds',
              openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
              lastImplementerLastPosition: implDispatch.lastPosition ?? lastImplementerLastPosition,
              lastReviewerLastPosition
            })
          };
        }
        implDispositions.push(parsedDisposition.data);
      }

      // In later rounds, require a disposition for every carried-forward blocking finding.
      if (roundNumber > 1 && lastBlockingFindingContexts.length > 0) {
        const disposedFeedbackIds = new Set(implDispositions.map(d => d.feedbackId));
        const missing = lastBlockingFindingContexts.filter(c => !disposedFeedbackIds.has(c.feedbackId));
        if (missing.length > 0) {
          return {
            workResult: { directive: 'fail', reason: 'disposition_missing' },
            checkpointResult: buildCheckpoint({
              step: input.stepDefinition.id,
              maxRounds,
              routes,
              rounds,
              outcome: 'max_rounds',
              openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
              lastImplementerLastPosition: implDispatch.lastPosition ?? lastImplementerLastPosition,
              lastReviewerLastPosition
            })
          };
        }
      }

      const newlyDeclined = declinedSignaturesFromDispositions(implDispositions, findingsByFeedbackId);
      for (const sig of newlyDeclined) {
        if (!accumulatedDeclinedSignatures.includes(sig)) accumulatedDeclinedSignatures.push(sig);
      }

      // 2) Commit implementer's changes BEFORE reviewer runs.
      const commitMessage = `convergence(${input.stepDefinition.id}): round ${roundNumber} implementer`;
      const commitResult = await options.git.commitFiles({
        runId: input.runId,
        workspaceRepoRoot: input.workspace?.workspaceRepoRoot ?? '',
        message: commitMessage,
        allowEmpty: true
      });

      // 3) Reviewer (read-only).
      const reviewDispatch: ReviewedRoleDispatchResult = await options.dispatcher.runRole({
        runId: input.runId,
        run: input.run,
        tenant: input.tenant,
        role: 'reviewer',
        round: roundNumber,
        reviewContext: {
          previousRounds: rounds.map(r => r),
          routingDistinct: routes.routingInfo.distinct
        },
        toolPolicyMode: 'read_only',
        routeProfileId: routes.reviewerRoute.profileId,
        route: routes.reviewerRoute
      });
      lastReviewerLastPosition = reviewDispatch.lastPosition ?? lastReviewerLastPosition;
      if (reviewDispatch.modelPrincipal !== undefined) {
        reviewerPrincipal = reviewDispatch.modelPrincipal;
      }

      // 4) Validate reviewer result against schema.
      const rawResult = reviewDispatch.reviewerResult
        ?? (reviewDispatch.workResult.directive === 'advance'
          ? (reviewDispatch.workResult.result as unknown)
          : undefined);
      if (rawResult === undefined) {
        return {
          workResult: { directive: 'fail', reason: 'reviewer_result_missing' },
          checkpointResult: buildCheckpoint({
            step: input.stepDefinition.id,
            maxRounds,
            routes,
            rounds,
            outcome: 'max_rounds',
            openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
            lastImplementerLastPosition,
            lastReviewerLastPosition
          })
        };
      }
      const parsed = reviewerResultSchema.safeParse(rawResult);
      if (!parsed.success) {
        return {
          workResult: { directive: 'fail', reason: 'reviewer_result_invalid' },
          checkpointResult: buildCheckpoint({
            step: input.stepDefinition.id,
            maxRounds,
            routes,
            rounds,
            outcome: 'max_rounds',
            openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
            lastImplementerLastPosition,
            lastReviewerLastPosition
          })
        };
      }
      const reviewerResult: ReviewerResult = parsed.data;
      const findings: readonly ReviewerFinding[] = reviewerResult.status === 'findings' ? reviewerResult.findings : [];

      // 5) Persist reviewer findings as Feedback BEFORE convergence decision.
      const persisted = findings.length > 0
        ? await createReviewerFeedback({
            run: input.run,
            step: input.stepDefinition.id,
            reviewerPrincipal,
            findings,
            repository: options.feedback,
            ...(options.clock !== undefined ? { clock: options.clock } : {}),
            ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {})
          })
        : { feedback: [] as readonly Feedback[], findingsByFeedbackId: {} as Record<string, ReviewerFinding> };

      // Update findings-by-feedbackId map.
      const roundFindings: ConvergenceRoundFinding[] = [];
      const roundFindingContexts: ReviewerFindingContext[] = [];
      for (const fb of persisted.feedback) {
        const finding = persisted.findingsByFeedbackId[fb.id]!;
        findingsByFeedbackId.set(fb.id, finding);
        const sig = findingSignature(finding);
        const blocking = isBlockingFinding(finding, accumulatedDeclinedSignatures);
        roundFindings.push({
          feedbackId: fb.id,
          title: finding.title,
          body: finding.body,
          severity: finding.severity,
          ...(finding.externalId !== undefined ? { externalId: finding.externalId } : {}),
          ...(finding.anchor !== undefined ? { anchor: finding.anchor } : {}),
          blocking,
          signature: sig
        });
        roundFindingContexts.push(findingContextFromFeedback(fb, finding));
      }

      // 6) Compute blocking set from this round's persisted findings.
      const currentBlockingSignatures = roundFindings.filter(f => f.blocking).map(f => f.signature);
      const blockingThisRound = roundFindings.filter(f => f.blocking);
      lastReviewerFindingContexts = roundFindingContexts;
      lastBlockingFindingContexts = blockingThisRound.map(f => {
        const ctx: ReviewerFindingContext = {
          feedbackId: f.feedbackId,
          title: f.title,
          body: f.body,
          severity: f.severity
        };
        return ctx;
      });

      // 7) Decide outcome for this round.
      const noBlocking = currentBlockingSignatures.length === 0;
      let outcome: ConvergenceRoundOutcome;
      if (noBlocking) {
        outcome = 'converged';
      } else if (roundNumber >= maxRounds) {
        outcome = 'max_rounds';
        escalation = 'max_rounds';
      } else if (detectOscillation(rounds, currentBlockingSignatures)) {
        outcome = 'oscillation';
        escalation = 'oscillation';
      } else {
        outcome = 'continue';
      }

      const roundRecord: ConvergenceRoundRecord = {
        round: roundNumber,
        ...(implDispatch.sessionId !== undefined ? { implementerSessionId: implDispatch.sessionId } : {}),
        ...(reviewDispatch.sessionId !== undefined ? { reviewerSessionId: reviewDispatch.sessionId } : {}),
        ...(commitResult.commitSha !== null ? { implementerCommitSha: commitResult.commitSha } : { implementerCommitSha: null }),
        changedFileCount: commitResult.changedFileCount,
        findings: roundFindings,
        dispositions: implDispositions,
        outcome,
        altitude: 'build'
      };
      rounds.push(roundRecord);

      // 8) Persist checkpoint after each reviewer pass.
      const checkpointOutcome: ConvergenceOutcome = noBlocking
        ? 'converged'
        : (escalation ?? 'max_rounds');
      const checkpoint = buildCheckpoint({
        step: input.stepDefinition.id,
        maxRounds,
        routes,
        rounds,
        outcome: checkpointOutcome,
        openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
        lastImplementerLastPosition,
        lastReviewerLastPosition
      });
      try {
        await options.runSteps.updateCheckpoint({
          runStepId: input.runStep.id,
          runId: input.runId,
          tenant: input.tenant,
          checkpointResult: checkpoint as unknown as import('@autocatalyst/api-contract').JsonValue
        });
      } catch (err) {
        options.logger?.warn('convergence checkpoint persistence failed', {
          runId: input.runId,
          step: input.stepDefinition.id,
          round: roundNumber,
          errorName: err instanceof Error ? err.name : typeof err
        });
      }

      // 9) Decide loop continuation
      if (noBlocking) {
        // Address open human-provided implementation feedback now that convergence succeeded.
        if (feedbackLifecycleDeps !== undefined) {
          await addressOpenFeedbackForRunTarget({
            runId: input.runId,
            target: 'implementation',
            actor: input.run.owner,
            body: 'Addressed during implementation revision.'
          }, feedbackLifecycleDeps);
        }
        return {
          workResult: { directive: 'advance', result: checkpoint as unknown as Readonly<Record<string, unknown>> },
          checkpointResult: checkpoint
        };
      }
      if (escalation !== undefined) {
        break;
      }
      // Clear humanGuidance after round 1 so it is not re-sent to subsequent rounds.
      humanGuidance = undefined;
      // Else continue to next round.
    }

    // Loop exited without converging — escalate.
    const finalOutcome: ConvergenceOutcome = escalation ?? 'max_rounds';
    const checkpoint = buildCheckpoint({
      step: input.stepDefinition.id,
      maxRounds,
      routes,
      rounds,
      outcome: finalOutcome,
      openFeedbackIds: collectOpenFeedbackIds(rounds, accumulatedDeclinedSignatures),
      lastImplementerLastPosition,
      lastReviewerLastPosition
    });

    // Decide directive for escalation: prefer 'needs_input' when the workflow allows it.
    const transitions = input.workflow.transitions as Record<string, Partial<Record<RunDirective, RunStepId>> | undefined>;
    const hasNeedsInputEdge = transitions[input.stepDefinition.id]?.['needs_input'] !== undefined;
    const workResult: RunWorkResult = hasNeedsInputEdge
      ? { directive: 'needs_input', question: `Convergence escalated: ${finalOutcome}` }
      : { directive: 'fail', reason: 'workflow_escalation_edge_missing' };

    return { workResult, checkpointResult: checkpoint };
  }

  return { run: runEngine };
}

function buildCheckpoint(args: {
  readonly step: string;
  readonly maxRounds: number;
  readonly routes: ResolvedReviewedRoutes;
  readonly rounds: readonly ConvergenceRoundRecord[];
  readonly outcome: ConvergenceOutcome;
  readonly openFeedbackIds: readonly string[];
  readonly lastImplementerLastPosition: string | undefined;
  readonly lastReviewerLastPosition: string | undefined;
}): ConvergenceCheckpoint {
  const routing: ConvergenceCheckpoint['routing'] = {
    distinct: args.routes.routingInfo.distinct,
    ...(args.routes.routingInfo.warningCode !== undefined
      ? { warningCode: args.routes.routingInfo.warningCode as 'role_distinct_unsatisfied' }
      : {})
  };
  const lastPositions: ConvergenceCheckpoint['lastPositions'] = {
    ...(args.lastImplementerLastPosition !== undefined ? { implementer: args.lastImplementerLastPosition } : {}),
    ...(args.lastReviewerLastPosition !== undefined ? { reviewer: args.lastReviewerLastPosition } : {})
  };
  return {
    kind: 'convergence_review',
    step: args.step,
    maxRounds: args.maxRounds,
    routing,
    rounds: args.rounds.map(r => r),
    outcome: args.outcome,
    openFeedbackIds: [...args.openFeedbackIds],
    lastPositions
  };
}

function collectOpenFeedbackIds(
  rounds: readonly ConvergenceRoundRecord[],
  declinedSignatures: readonly string[]
): readonly string[] {
  // Only report findings that are still blocking in the last reviewer pass.
  // Earlier rounds' blockers that were fixed by a later implementer are not open.
  const lastRound = rounds[rounds.length - 1];
  if (lastRound === undefined) return [];
  const declined = new Set(declinedSignatures);
  return lastRound.findings
    .filter(f => f.severity !== 'info' && !declined.has(f.signature))
    .map(f => f.feedbackId);
}
