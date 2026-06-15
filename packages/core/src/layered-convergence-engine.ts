import type {
  AltitudeCheckpointRef,
  ConvergenceCheckpoint,
  ConvergenceOutcome,
  ConvergenceRoundFinding,
  ConvergenceRoundOutcome,
  ConvergenceRoundRecord,
  Feedback,
  FindingDisposition,
  ImplementationAltitude,
  Principal,
  ReviewerFinding,
  ReviewerFindingContext,
  ReviewerResult,
  Run
} from '@autocatalyst/api-contract';
import { findingDispositionSchema, reviewerResultSchema } from '@autocatalyst/api-contract';
import type { ModelRoutingResolver } from './model-routing-resolver.js';
import type { FeedbackRepository, RunStepRepository } from './domain-repositories.js';
import type {
  ReviewedRoleDispatcher,
  ReviewedRoleDispatchResult,
  ReviewContext
} from './reviewed-role-dispatcher.js';
import type { RunWorkspaceGitPort } from './run-workspace-git.js';
import { createConvergenceFeedback } from './convergence-feedback.js';
import { validateAltitudeContract } from './altitude-contract-validator.js';
import { validateBuildContractPreservation } from './build-contract-preservation.js';
import { filterAltitudeFindings } from './layered-finding-filter.js';
import type { RunStepDefinition, RunStepId } from './run-step-catalog.js';
import type { RunDirective, RunWorkflowDefinition } from './run-workflows.js';
import type { ResolvedStepConvergencePolicy } from './convergence-policy.js';
import { getStepConvergencePolicy, getImplementationAltitudeLadder } from './convergence-policy.js';
import type { RunWorkResult, WorkspaceContext } from './orchestrator.js';
import {
  findingSignature,
  isBlockingFinding,
  detectOscillation,
  resolveReviewedRoutes,
  ConvergenceEngineConfigurationError,
  type ResolvedReviewedRoutes,
  type ConvergenceEngine,
  type ConvergenceEngineInput,
  type ConvergenceEngineResult
} from './convergence-engine.js';

export interface LayeredConvergenceEngineOptions {
  readonly dispatcher: ReviewedRoleDispatcher;
  readonly git: RunWorkspaceGitPort;
  readonly feedback: FeedbackRepository;
  readonly runSteps: RunStepRepository;
  readonly routing: ModelRoutingResolver;
  readonly getPolicy?: (
    workflow: RunWorkflowDefinition,
    step: RunStepId
  ) => ResolvedStepConvergencePolicy;
  readonly logger?: { warn(message: string, details?: unknown): void };
  readonly clock?: () => string;
  readonly idGenerator?: () => string;
  readonly reviewerPrincipal?: Principal;
}

function defaultReviewerPrincipal(tenant: string): Principal {
  return { id: 'reviewer', kind: 'model', tenantId: tenant };
}

const ALTITUDE_ALLOWED_WORK: Readonly<Record<ImplementationAltitude, string>> = {
  layout: 'Define module layout and file structure only — no implementations or tests.',
  public_api: 'Define public TypeScript type declarations only — no implementations or tests.',
  private_api: 'Define private TypeScript type declarations only — no implementations or tests.',
  build: 'Implement all functionality and add tests.'
};

const ALTITUDE_FINDING_CATEGORIES: Readonly<Record<ImplementationAltitude, readonly string[]>> = {
  layout: ['layout', 'contract_violation'],
  public_api: ['public_api', 'contract_violation'],
  private_api: ['private_api', 'contract_violation'],
  build: ['layout', 'public_api', 'private_api', 'build', 'contract_violation', 'build_drift']
};

function findingContextFromFeedback(
  feedback: Feedback,
  finding: ReviewerFinding
): ReviewerFindingContext {
  return {
    feedbackId: feedback.id,
    title: finding.title,
    body: finding.body,
    severity: finding.severity,
    ...(finding.externalId !== undefined ? { externalId: finding.externalId } : {}),
    ...(finding.anchor !== undefined ? { anchor: finding.anchor } : {})
  };
}

function buildLayeredCheckpoint(args: {
  readonly step: string;
  readonly maxRounds: number;
  readonly routes: ResolvedReviewedRoutes;
  readonly rounds: readonly ConvergenceRoundRecord[];
  readonly outcome: ConvergenceOutcome;
  readonly openFeedbackIds: readonly string[];
  readonly lastImplementerLastPosition: string | undefined;
  readonly lastReviewerLastPosition: string | undefined;
  readonly depth: ResolvedStepConvergencePolicy['depth'];
  readonly currentAltitude: ImplementationAltitude;
  readonly acceptedCheckpoints: readonly AltitudeCheckpointRef[];
}): ConvergenceCheckpoint {
  const routing: ConvergenceCheckpoint['routing'] = {
    distinct: args.routes.routingInfo.distinct,
    ...(args.routes.routingInfo.warningCode !== undefined
      ? { warningCode: args.routes.routingInfo.warningCode as 'role_distinct_unsatisfied' }
      : {})
  };
  const lastPositions: ConvergenceCheckpoint['lastPositions'] = {
    ...(args.lastImplementerLastPosition !== undefined
      ? { implementer: args.lastImplementerLastPosition }
      : {}),
    ...(args.lastReviewerLastPosition !== undefined
      ? { reviewer: args.lastReviewerLastPosition }
      : {})
  };
  return {
    kind: 'convergence_review',
    step: args.step,
    maxRounds: args.maxRounds,
    routing,
    rounds: args.rounds.map((r) => r),
    outcome: args.outcome,
    openFeedbackIds: [...args.openFeedbackIds],
    lastPositions,
    depth: args.depth,
    currentAltitude: args.currentAltitude,
    acceptedCheckpoints: args.acceptedCheckpoints.map((c) => c)
  };
}

function collectOpenFeedbackIds(
  rounds: readonly ConvergenceRoundRecord[]
): readonly string[] {
  const lastRound = rounds[rounds.length - 1];
  if (lastRound === undefined) return [];
  return lastRound.findings.filter((f) => f.blocking).map((f) => f.feedbackId);
}

interface AltitudeLoopState {
  readonly allRounds: ConvergenceRoundRecord[];
  readonly acceptedCheckpoints: AltitudeCheckpointRef[];
  lastImplementerLastPosition: string | undefined;
  lastReviewerLastPosition: string | undefined;
  reviewerPrincipal: Principal;
}

type AltitudeLoopOutcome =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'escalated'; readonly reason: 'max_rounds' | 'oscillation' }
  | { readonly kind: 'failed'; readonly workResult: RunWorkResult };

export function createLayeredConvergenceEngine(
  options: LayeredConvergenceEngineOptions
): ConvergenceEngine {
  const getPolicy = options.getPolicy ?? getStepConvergencePolicy;

  async function runAltitude(params: {
    readonly altitude: ImplementationAltitude;
    readonly maxRounds: number;
    readonly depth: ResolvedStepConvergencePolicy['depth'];
    readonly input: ConvergenceEngineInput;
    readonly routes: ResolvedReviewedRoutes;
    readonly state: AltitudeLoopState;
  }): Promise<AltitudeLoopOutcome> {
    const { altitude, maxRounds, depth, input, routes, state } = params;

    const altitudeRounds: ConvergenceRoundRecord[] = [];
    const declinedSignatures: string[] = [];
    const findingsByFeedbackId = new Map<string, ReviewerFinding>();
    let lastReviewerFindingContexts: ReviewerFindingContext[] = [];
    let lastBlockingFindingContexts: ReviewerFindingContext[] = [];
    let escalation: 'max_rounds' | 'oscillation' | undefined;
    // Track deterministic key → feedbackId within this altitude to enable deduplication.
    let deterministicFeedbackIdByKey: Readonly<Record<string, string>> = {};
    // Cumulative tracking across rounds within this altitude for deterministic checks.
    // Ensures no-op rounds (commitSha === null) still re-run checks using the last known HEAD.
    let lastHeadSha: string | null = null;
    const altitudeChangedFilesSet = new Set<string>();

    for (let roundNumber = 1; roundNumber <= maxRounds; roundNumber++) {
      // 1) Implementer dispatch
      const implReviewContext: ReviewContext = {
        previousRounds: state.allRounds.map((r) => r),
        routingDistinct: routes.routingInfo.distinct,
        altitudeContext: {
          altitude,
          altitudeRound: roundNumber,
          acceptedCheckpoints: state.acceptedCheckpoints.map((c) => c),
          allowedWork: ALTITUDE_ALLOWED_WORK[altitude],
          findingCategories: ALTITUDE_FINDING_CATEGORIES[altitude]
        },
        ...(lastBlockingFindingContexts.length > 0
          ? {
              previousFindings: lastReviewerFindingContexts,
              requiredDispositions: lastBlockingFindingContexts.map((c) => ({
                feedbackId: c.feedbackId,
                title: c.title,
                severity: c.severity,
                body: c.body
              }))
            }
          : {})
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

      if (implDispatch.workResult.directive === 'needs_input') {
        state.lastImplementerLastPosition =
          implDispatch.lastPosition ?? state.lastImplementerLastPosition;
        return { kind: 'failed', workResult: implDispatch.workResult };
      }
      if (implDispatch.workResult.directive === 'fail') {
        state.lastImplementerLastPosition =
          implDispatch.lastPosition ?? state.lastImplementerLastPosition;
        return { kind: 'failed', workResult: implDispatch.workResult };
      }
      state.lastImplementerLastPosition =
        implDispatch.lastPosition ?? state.lastImplementerLastPosition;

      // Validate dispositions
      const rawImplDispositions = implDispatch.dispositions ?? [];
      const implDispositions: FindingDisposition[] = [];
      for (const raw of rawImplDispositions) {
        const parsed = findingDispositionSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            kind: 'failed',
            workResult: { directive: 'fail', reason: 'disposition_invalid' }
          };
        }
        implDispositions.push(parsed.data);
      }

      if (roundNumber > 1 && lastBlockingFindingContexts.length > 0) {
        const disposedFeedbackIds = new Set(implDispositions.map((d) => d.feedbackId));
        // Only reviewer-source findings require dispositions; deterministic findings cannot be declined.
        const requiredContexts = lastBlockingFindingContexts.filter((c) => {
          const finding = findingsByFeedbackId.get(c.feedbackId);
          return finding !== undefined; // reviewer findings are tracked here
        });
        const missing = requiredContexts.filter((c) => !disposedFeedbackIds.has(c.feedbackId));
        if (missing.length > 0) {
          return {
            kind: 'failed',
            workResult: { directive: 'fail', reason: 'disposition_missing' }
          };
        }
      }

      // Track declined signatures (only for reviewer findings)
      for (const d of implDispositions) {
        if (d.disposition !== 'declined') continue;
        const finding = findingsByFeedbackId.get(d.feedbackId);
        if (finding === undefined) continue;
        const sig = findingSignature(finding);
        if (!declinedSignatures.includes(sig)) declinedSignatures.push(sig);
      }

      // 2) Commit implementer changes
      const commitMessage = `convergence(${input.stepDefinition.id}): ${altitude} round ${roundNumber} implementer`;
      const commitResult = await options.git.commitFiles({
        runId: input.runId,
        workspaceRepoRoot: input.workspace?.workspaceRepoRoot ?? '',
        message: commitMessage,
        allowEmpty: true
      });

      // Update cumulative altitude tracking so no-op rounds can re-run deterministic checks.
      if (commitResult.commitSha !== null) {
        lastHeadSha = commitResult.commitSha;
        for (const f of commitResult.changedFilePaths) {
          altitudeChangedFilesSet.add(f);
        }
      }

      // 3) Deterministic findings: altitude contract (early) or build drift (build).
      let deterministicFindings: ConvergenceRoundFinding[] = [];
      if (
        altitude !== 'build' &&
        lastHeadSha !== null &&
        altitudeChangedFilesSet.size > 0 &&
        input.workspace?.workspaceRepoRoot !== undefined
      ) {
        const repoRoot = input.workspace.workspaceRepoRoot;
        const sha = lastHeadSha;
        // Use the cumulative set of files changed across all rounds at this altitude.
        // This ensures no-op rounds still re-check violations from prior rounds.
        const changedFiles = Array.from(altitudeChangedFilesSet);
        const validatorFindings = await validateAltitudeContract({
          altitude: altitude as Exclude<ImplementationAltitude, 'build'>,
          headCommitSha: sha,
          changedFiles,
          readFileAtRef: (path) =>
            options.git.readFileAtRef({ workspaceRepoRoot: repoRoot, ref: sha, path })
        });
        deterministicFindings = validatorFindings;
      }

      // 4) Reviewer dispatch (read-only)
      const reviewDispatch: ReviewedRoleDispatchResult = await options.dispatcher.runRole({
        runId: input.runId,
        run: input.run,
        tenant: input.tenant,
        role: 'reviewer',
        round: roundNumber,
        reviewContext: {
          previousRounds: state.allRounds.map((r) => r),
          routingDistinct: routes.routingInfo.distinct,
          altitudeContext: {
            altitude,
            altitudeRound: roundNumber,
            acceptedCheckpoints: state.acceptedCheckpoints.map((c) => c),
            allowedWork: ALTITUDE_ALLOWED_WORK[altitude],
            findingCategories: ALTITUDE_FINDING_CATEGORIES[altitude]
          }
        },
        toolPolicyMode: 'read_only',
        routeProfileId: routes.reviewerRoute.profileId,
        route: routes.reviewerRoute
      });
      state.lastReviewerLastPosition =
        reviewDispatch.lastPosition ?? state.lastReviewerLastPosition;
      if (reviewDispatch.modelPrincipal !== undefined) {
        state.reviewerPrincipal = reviewDispatch.modelPrincipal;
      }

      // Validate reviewer result
      const rawResult =
        reviewDispatch.reviewerResult ??
        (reviewDispatch.workResult.directive === 'advance'
          ? (reviewDispatch.workResult.result as unknown)
          : undefined);
      if (rawResult === undefined) {
        return {
          kind: 'failed',
          workResult: { directive: 'fail', reason: 'reviewer_result_missing' }
        };
      }
      const parsedReviewer = reviewerResultSchema.safeParse(rawResult);
      if (!parsedReviewer.success) {
        return {
          kind: 'failed',
          workResult: { directive: 'fail', reason: 'reviewer_result_invalid' }
        };
      }
      const reviewerResult: ReviewerResult = parsedReviewer.data;
      const reviewerFindings: readonly ReviewerFinding[] =
        reviewerResult.status === 'findings' ? reviewerResult.findings : [];

      // 5) Build drift check at build altitude before convergence
      if (
        altitude === 'build' &&
        state.acceptedCheckpoints.length > 0 &&
        lastHeadSha !== null &&
        input.workspace?.workspaceRepoRoot !== undefined
      ) {
        const repoRoot = input.workspace.workspaceRepoRoot;
        const sha = lastHeadSha;
        const driftFindings = await validateBuildContractPreservation({
          workspaceRepoRoot: repoRoot,
          buildCommitSha: sha,
          acceptedCheckpoints: state.acceptedCheckpoints,
          readFileAtRef: (i) =>
            options.git.readFileAtRef({ workspaceRepoRoot: repoRoot, ref: i.ref, path: i.path }),
          listFilesAtRef: (i) =>
            options.git.listFilesAtRef({ workspaceRepoRoot: repoRoot, ref: i.ref })
        });
        deterministicFindings = [...deterministicFindings, ...driftFindings];
      }

      // 6) Persist reviewer findings as feedback
      const persistedReviewer =
        reviewerFindings.length > 0
          ? await createConvergenceFeedback({
              run: input.run,
              step: input.stepDefinition.id,
              altitude,
              round: roundNumber,
              reviewerPrincipal: state.reviewerPrincipal,
              findings: reviewerFindings.map(
                (f) =>
                  ({
                    feedbackId: 'pending',
                    title: f.title,
                    body: f.body,
                    severity: f.severity,
                    ...(f.externalId !== undefined ? { externalId: f.externalId } : {}),
                    ...(f.anchor !== undefined ? { anchor: f.anchor } : {}),
                    blocking: true,
                    signature: findingSignature(f),
                    source: 'reviewer',
                    altitude
                  }) as ConvergenceRoundFinding
              ),
              repository: options.feedback,
              ...(options.clock !== undefined ? { clock: options.clock } : {}),
              ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {})
            })
          : { feedback: [] as readonly Feedback[], updatedFindings: [] as readonly ConvergenceRoundFinding[], deterministicFeedbackIdByKey: {} as Record<string, string> };

      // Map persisted feedback back to original reviewer findings by sequence order.
      const persistedReviewerFindings: ConvergenceRoundFinding[] = [];
      const roundFindingContexts: ReviewerFindingContext[] = [];
      for (let i = 0; i < persistedReviewer.updatedFindings.length; i++) {
        const fb = persistedReviewer.feedback[i]!;
        const originalFinding = reviewerFindings[i]!;
        findingsByFeedbackId.set(fb.id, originalFinding);
        const sig = findingSignature(originalFinding);
        const blocking = isBlockingFinding(originalFinding, declinedSignatures);
        persistedReviewerFindings.push({
          feedbackId: fb.id,
          title: originalFinding.title,
          body: originalFinding.body,
          severity: originalFinding.severity,
          ...(originalFinding.externalId !== undefined ? { externalId: originalFinding.externalId } : {}),
          ...(originalFinding.anchor !== undefined ? { anchor: originalFinding.anchor } : {}),
          blocking,
          signature: sig,
          source: 'reviewer',
          altitude
        });
        roundFindingContexts.push(findingContextFromFeedback(fb, originalFinding));
      }

      // 7) Persist deterministic findings as feedback (separate call so authoring uses system principal).
      // Pass deduplication state so re-emitted keys reuse existing feedback and stale keys are resolved.
      const persistedDeterministic =
        deterministicFindings.length > 0 || Object.keys(deterministicFeedbackIdByKey).length > 0
          ? await createConvergenceFeedback({
              run: input.run,
              step: input.stepDefinition.id,
              altitude,
              round: roundNumber,
              findings: deterministicFindings,
              repository: options.feedback,
              deterministicFeedbackIdByKey,
              ...(options.clock !== undefined ? { clock: options.clock } : {}),
              ...(options.idGenerator !== undefined ? { idGenerator: options.idGenerator } : {})
            })
          : { feedback: [] as readonly Feedback[], updatedFindings: [] as readonly ConvergenceRoundFinding[], deterministicFeedbackIdByKey: {} as Record<string, string> };

      // Update deduplication state for next round.
      deterministicFeedbackIdByKey = persistedDeterministic.deterministicFeedbackIdByKey;

      const persistedDeterministicFindings: ConvergenceRoundFinding[] = [
        ...persistedDeterministic.updatedFindings
      ];

      // 8) Combine and filter by altitude scope
      const combined: ConvergenceRoundFinding[] = [
        ...persistedReviewerFindings,
        ...persistedDeterministicFindings
      ];
      const filtered = filterAltitudeFindings({ altitude, findings: combined });

      // 9) Decide outcome
      const currentBlockingSignatures = filtered
        .filter((f) => f.blocking)
        .map((f) => f.signature);
      const noBlocking = currentBlockingSignatures.length === 0;

      let outcome: ConvergenceRoundOutcome;
      if (noBlocking) {
        outcome = 'converged';
      } else if (roundNumber >= maxRounds) {
        outcome = 'max_rounds';
        escalation = 'max_rounds';
      } else if (detectOscillation(altitudeRounds, currentBlockingSignatures)) {
        outcome = 'oscillation';
        escalation = 'oscillation';
      } else {
        outcome = 'continue';
      }

      const roundRecord: ConvergenceRoundRecord = {
        round: roundNumber,
        ...(implDispatch.sessionId !== undefined
          ? { implementerSessionId: implDispatch.sessionId }
          : {}),
        ...(reviewDispatch.sessionId !== undefined
          ? { reviewerSessionId: reviewDispatch.sessionId }
          : {}),
        ...(commitResult.commitSha !== null
          ? { implementerCommitSha: commitResult.commitSha }
          : { implementerCommitSha: null }),
        changedFileCount: commitResult.changedFileCount,
        findings: filtered,
        dispositions: implDispositions,
        outcome,
        altitude
      };

      altitudeRounds.push(roundRecord);
      state.allRounds.push(roundRecord);

      lastReviewerFindingContexts = roundFindingContexts;
      lastBlockingFindingContexts = filtered
        .filter((f) => f.blocking)
        .map((f) => {
          const ctx: ReviewerFindingContext = {
            feedbackId: f.feedbackId,
            title: f.title,
            body: f.body,
            severity: f.severity
          };
          return ctx;
        });

      // Persist a snapshot checkpoint after each round.
      const snapshotOutcome: ConvergenceOutcome = noBlocking
        ? 'converged'
        : (escalation ?? 'max_rounds');
      const snapshot = buildLayeredCheckpoint({
        step: input.stepDefinition.id,
        maxRounds,
        routes,
        rounds: state.allRounds,
        outcome: snapshotOutcome,
        openFeedbackIds: collectOpenFeedbackIds(state.allRounds),
        lastImplementerLastPosition: state.lastImplementerLastPosition,
        lastReviewerLastPosition: state.lastReviewerLastPosition,
        depth,
        currentAltitude: altitude,
        acceptedCheckpoints: state.acceptedCheckpoints
      });
      try {
        await options.runSteps.updateCheckpoint({
          runStepId: input.runStep.id,
          runId: input.runId,
          tenant: input.tenant,
          checkpointResult: snapshot as unknown as import('@autocatalyst/api-contract').JsonValue
        });
      } catch (err) {
        options.logger?.warn('layered convergence checkpoint persistence failed', {
          runId: input.runId,
          step: input.stepDefinition.id,
          altitude,
          round: roundNumber,
          errorName: err instanceof Error ? err.name : typeof err
        });
      }

      if (noBlocking) return { kind: 'accepted' };
      if (escalation !== undefined) return { kind: 'escalated', reason: escalation };
    }

    return { kind: 'escalated', reason: escalation ?? 'max_rounds' };
  }

  async function runEngine(input: ConvergenceEngineInput): Promise<ConvergenceEngineResult> {
    const roles = input.stepDefinition.roles;
    if (!roles.includes('implementer') || !roles.includes('reviewer')) {
      throw new ConvergenceEngineConfigurationError(
        'missing_roles',
        `Step '${input.stepDefinition.id}' must declare both implementer and reviewer roles for convergence.`
      );
    }

    const policy = getPolicy(input.workflow, input.stepDefinition.id);
    const maxRounds = policy.maxRounds;
    const ladder = getImplementationAltitudeLadder(policy);
    const finalAltitude = ladder[ladder.length - 1]!;

    const routes = await resolveReviewedRoutes({
      tenant: input.tenant,
      runId: input.runId,
      step: input.stepDefinition.id,
      routing: options.routing,
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    });

    const state: AltitudeLoopState = {
      allRounds: [],
      acceptedCheckpoints: [],
      lastImplementerLastPosition: undefined,
      lastReviewerLastPosition: undefined,
      reviewerPrincipal: options.reviewerPrincipal ?? defaultReviewerPrincipal(input.tenant)
    };

    let currentAltitude: ImplementationAltitude = ladder[0]!;

    for (const altitude of ladder) {
      currentAltitude = altitude;

      const altResult = await runAltitude({ altitude, maxRounds, depth: policy.depth, input, routes, state });

      if (altResult.kind === 'failed') {
        const checkpoint = buildLayeredCheckpoint({
          step: input.stepDefinition.id,
          maxRounds,
          routes,
          rounds: state.allRounds,
          outcome: 'max_rounds',
          openFeedbackIds: collectOpenFeedbackIds(state.allRounds),
          lastImplementerLastPosition: state.lastImplementerLastPosition,
          lastReviewerLastPosition: state.lastReviewerLastPosition,
          depth: policy.depth,
          currentAltitude,
          acceptedCheckpoints: state.acceptedCheckpoints
        });
        return { workResult: altResult.workResult, checkpointResult: checkpoint };
      }

      if (altResult.kind === 'escalated') {
        const finalOutcome: ConvergenceOutcome = altResult.reason;
        const checkpoint = buildLayeredCheckpoint({
          step: input.stepDefinition.id,
          maxRounds,
          routes,
          rounds: state.allRounds,
          outcome: finalOutcome,
          openFeedbackIds: collectOpenFeedbackIds(state.allRounds),
          lastImplementerLastPosition: state.lastImplementerLastPosition,
          lastReviewerLastPosition: state.lastReviewerLastPosition,
          depth: policy.depth,
          currentAltitude,
          acceptedCheckpoints: state.acceptedCheckpoints
        });
        const transitions = input.workflow.transitions as Record<
          string,
          Partial<Record<RunDirective, RunStepId>> | undefined
        >;
        const hasNeedsInputEdge =
          transitions[input.stepDefinition.id]?.['needs_input'] !== undefined;
        const workResult: RunWorkResult = hasNeedsInputEdge
          ? {
              directive: 'needs_input',
              question: `Convergence escalated at ${altitude}: ${finalOutcome}`
            }
          : { directive: 'fail', reason: 'workflow_escalation_edge_missing' };
        return { workResult, checkpointResult: checkpoint };
      }

      // Accepted at this altitude. If not the final altitude, capture a checkpoint ref.
      if (altitude !== finalAltitude) {
        // Find the last non-null implementerCommitSha from rounds at the current altitude.
        // A no-op accepting round has commitSha === null, so we must look back to the
        // most recent round that actually committed something.
        const altitudeRoundsForCurrent = state.allRounds.filter(r => r.altitude === altitude);
        const lastCommitSha = altitudeRoundsForCurrent.slice().reverse().find(r => r.implementerCommitSha != null)?.implementerCommitSha ?? null;
        if (
          lastCommitSha !== null &&
          input.workspace?.workspaceRepoRoot !== undefined
        ) {
          try {
            const refResult = await options.git.captureCheckpointRef({
              runId: input.runId,
              workspaceRepoRoot: input.workspace.workspaceRepoRoot,
              altitude: altitude as Exclude<ImplementationAltitude, 'build'>,
              commitSha: lastCommitSha
            });
            state.acceptedCheckpoints.push({
              altitude: altitude as Exclude<ImplementationAltitude, 'build'>,
              ref: refResult.ref,
              commitSha: refResult.commitSha,
              acceptedAt: options.clock?.() ?? new Date().toISOString()
            });
          } catch (err) {
            options.logger?.warn('layered convergence checkpoint ref capture failed', {
              runId: input.runId,
              altitude,
              errorName: err instanceof Error ? err.name : typeof err
            });
            const checkpoint = buildLayeredCheckpoint({
              step: input.stepDefinition.id,
              maxRounds,
              routes,
              rounds: state.allRounds,
              outcome: 'needs_input',
              openFeedbackIds: collectOpenFeedbackIds(state.allRounds),
              lastImplementerLastPosition: state.lastImplementerLastPosition,
              lastReviewerLastPosition: state.lastReviewerLastPosition,
              depth: policy.depth,
              currentAltitude: altitude,
              acceptedCheckpoints: state.acceptedCheckpoints
            });
            const transitions = input.workflow.transitions as Record<
              string,
              Partial<Record<RunDirective, RunStepId>> | undefined
            >;
            const hasNeedsInputEdge =
              transitions[input.stepDefinition.id]?.['needs_input'] !== undefined;
            const workResult: RunWorkResult = hasNeedsInputEdge
              ? { directive: 'needs_input', question: 'Checkpoint capture failed' }
              : { directive: 'fail', reason: 'checkpoint_capture_failed' };
            return { workResult, checkpointResult: checkpoint };
          }
        }
      }
    }

    // All altitudes accepted
    const checkpoint = buildLayeredCheckpoint({
      step: input.stepDefinition.id,
      maxRounds,
      routes,
      rounds: state.allRounds,
      outcome: 'converged',
      openFeedbackIds: collectOpenFeedbackIds(state.allRounds),
      lastImplementerLastPosition: state.lastImplementerLastPosition,
      lastReviewerLastPosition: state.lastReviewerLastPosition,
      depth: policy.depth,
      currentAltitude,
      acceptedCheckpoints: state.acceptedCheckpoints
    });
    return {
      workResult: {
        directive: 'advance',
        result: checkpoint as unknown as Readonly<Record<string, unknown>>
      },
      checkpointResult: checkpoint
    };
  }

  return { run: runEngine };
}

