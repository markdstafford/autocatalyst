import { guardConvergenceFeedback, commitConvergenceEffect, StaleDispatchError } from './dispatch-result-commits.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  reviewedSpecAuthorResultSchema, specReviewerResultSchema,
  type Feedback, type FindingDisposition, type JsonValue, type Principal, type Run,
  type SpecAuthorResult, type SpecReviewerFinding, type ImplementationAltitude
} from '@autocatalyst/api-contract';
import { makeSanitizedFailureReason } from '@autocatalyst/execution';
import { resolveReviewedRoutes, type ConvergenceEngineInput } from './convergence-engine.js';
import { getImplementationAltitudeLadder, getStepConvergencePolicy } from './convergence-policy.js';
import type { LayeredConvergenceEngineOptions } from './layered-convergence-engine.js';
import type { CompleteSpecAuthoringOutput } from './spec-authoring-service.js';
import type { WorkspaceContext } from './orchestrator.js';
import { parseSpecFrontmatter, renderReviewedSpecCandidate } from './spec-frontmatter.js';
import { locateSpecQuote, validateSpecAnchor, type SpecQuoteLookup } from './spec-anchor-validator.js';
import { safeFailureReasonFromError } from './safe-failure-reason.js';

type Role = 'implementer' | 'reviewer';
type Outcome = 'converged' | 'max_rounds' | 'oscillation';
type Location =
  | 'bound' | 'document_scope' | 'quote_missing' | 'quote_not_found_in_candidate'
  | 'quote_non_unique_in_candidate' | 'quote_removed_from_selected' | 'quote_non_unique_in_selected';
type ReviewProgress = { altitude: ImplementationAltitude; round: number; role: Role | 'none' };

type Candidate = {
  path: string;
  key: string;
  digest: string;
  dispositions: FindingDisposition[];
  implementerSessionId?: string;
  implementer: Principal;
  authorAnswer?: string;
};

type Evidence = {
  id: string;
  occurrenceId: string;
  signature: string;
  scope: SpecReviewerFinding['scope'];
  severity: SpecReviewerFinding['severity'];
  quote?: string;
  lookup: SpecQuoteLookup['status'];
  digest: string;
  altitude: ImplementationAltitude;
  round: number;
  location?: Location;
};

type Round = {
  altitude: ImplementationAltitude;
  round: number;
  implementerSessionId?: string;
  reviewerSessionId?: string;
  findings: string[];
  findingEvidence: { feedbackId: string; scope: Evidence['scope']; severity: Evidence['severity']; lookup: Evidence['lookup']; candidateDigest: string }[];
  dispositions: FindingDisposition[];
  dispositionRejected: string[];
  outcome: 'continue' | Outcome;
};

export type SpecQuestionPause = {
  kind: 'spec_question';
  producingStep: 'spec.author';
  role: Role;
  question: string;
  sourceStepId: string;
  sessionId?: string;
};

type State = {
  occurrenceId: string;
  depth: ReturnType<typeof getStepConvergencePolicy>['depth'];
  maxRounds: number;
  altitudeIndex: number;
  round: number;
  rounds: Round[];
  evidence: Record<string, Evidence>;
  decisions: Record<string, FindingDisposition>;
  decisionAuthors: Record<string, Principal>;
  openIds: string[];
  pending?: Candidate;
  intake?: { findings: SpecReviewerFinding[]; reviewer: Principal; sessionId?: string };
  last?: Candidate;
  outcome?: Outcome;
  completion?: CompleteSpecAuthoringOutput['checkpointResult'];
  answer?: { role: Role; body: string };
  pause?: SpecQuestionPause;
  distinct?: boolean;
};

export type SpecConvergenceInput = ConvergenceEngineInput & {
  readonly steps: readonly ConvergenceEngineInput['runStep'][];
  readonly answer?: { sourceStepId: string; role: Role; body: string };
  readonly complete: (spec: SpecAuthorResult, markdown: string) => Promise<CompleteSpecAuthoringOutput | undefined>;
  readonly readHead: (relativePath: string) => Promise<string | null>;
  readonly readCanonicalSpec: () => Promise<{ path: string; markdown: string } | undefined>;
};

const cancelledSpec = { directive: 'cancelled' } as const;

export type SpecConvergenceResult =
  | typeof cancelledSpec
  | { readonly directive: 'fail'; readonly reason: string }
  | { readonly directive: 'needs_input'; readonly checkpoint: JsonValue; readonly pause: SpecQuestionPause }
  | { readonly directive: 'advance'; readonly checkpoint: JsonValue };

export interface SpecReviewSessionInput {
  readonly resultFile: string;
  readonly canonicalPath?: string;
  readonly previousMarkdown?: string;
  readonly revision?: string;
  readonly priorReview?: string;
  readonly candidateKey?: string;
  readonly feedback?: readonly {
    readonly feedbackId: string;
    readonly title: string;
    readonly body: string;
    readonly severity?: SpecReviewerFinding['severity'];
    readonly thread: Feedback['thread'];
  }[];
  readonly priorDispositions?: readonly FindingDisposition[];
  readonly focus: string;
  readonly answer?: string;
  readonly correction?: string;
}

const focusByAltitude: Record<ImplementationAltitude, string> = {
  layout: 'Requirements, scope, and document structure',
  public_api: 'User-visible behavior and contracts',
  private_api: 'Internal design, failure cases, and testability',
  build: 'Whole-spec review: scope, contradictions, edge cases, and testability'
};

const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const clock = () => new Date().toISOString();

function stateOf(value: JsonValue | null | undefined): State | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'spec_convergence' || record['producingStep'] !== 'spec.author') return undefined;
  return record['privateSpecReview'] as State | undefined;
}

export function publicSpecCheckpoint(value: JsonValue | null): JsonValue | null {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'specAnswer' in value) return null;
  if (!stateOf(value)) return value;
  const { privateSpecReview: _private, ...audit } = value as Record<string, JsonValue>;
  return audit;
}

export function hasSpecConvergenceState(value: JsonValue | null): boolean {
  return stateOf(value) !== undefined;
}

export function recoverableSelectedSpecCheckpoint(value: JsonValue | null): boolean {
  const state = stateOf(value);
  return !!state?.outcome && !!state.last;
}

export function eligibleSpecFinding(
  checkpoint: JsonValue | null | undefined, feedbackId: string
): boolean {
  const state = stateOf(checkpoint);
  return !!state?.completion && (state.outcome === 'max_rounds' || state.outcome === 'oscillation') &&
    state.openIds.includes(feedbackId) && state.evidence[feedbackId] !== undefined;
}

function checkpoint(state: State): JsonValue {
  return {
    kind: 'spec_convergence',
    producingStep: 'spec.author',
    occurrenceId: state.occurrenceId,
    depth: state.depth,
    maxRounds: state.maxRounds,
    currentAltitude: getImplementationAltitudeLadder(state)[state.altitudeIndex]!,
    round: state.round,
    rounds: state.rounds,
    findings: Object.values(state.evidence).map(({ quote: _quote, signature: _signature, ...audit }) => audit),
    openFeedbackIds: state.openIds,
    ...(state.distinct !== undefined ? { routing: { distinct: state.distinct,
      ...(state.distinct ? {} : { warningCode: 'role_distinct_unsatisfied' }) } } : {}),
    ...(state.outcome !== undefined ? { outcome: state.outcome } : {}),
    ...(state.completion !== undefined ? { ...state.completion, selectedDigest: state.last?.digest } : {}),
    privateSpecReview: state
  } as unknown as JsonValue;
}

async function scratchRoot(workspace: WorkspaceContext): Promise<string> {
  const sibling = join(dirname(await realpath(workspace.workspaceRepoRoot)), 'scratch');
  if (!(await lstat(sibling)).isDirectory()) throw new Error('Invalid candidate root.');
  return sibling;
}

async function readCandidate(workspace: WorkspaceContext, candidate: Candidate): Promise<string | undefined> {
  if (!/^spec-candidate-[a-f0-9-]+\.md$/u.test(candidate.key)) throw new Error('Invalid candidate key.');
  try {
    const path = join(await scratchRoot(workspace), candidate.key);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) return undefined;
      const bytes = await file.readFile();
      return createHash('sha256').update(bytes).digest('hex') === candidate.digest ? bytes.toString('utf8') : undefined;
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (['ENOENT', 'ELOOP'].includes((cause as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw cause;
  }
}

function candidateResult(path: string, markdown: string, kind: SpecAuthorResult['kind']): SpecAuthorResult {
  return {
    relativePath: path, kind, slug: basename(path, '.md').replace(/^(feature|enhancement)-/u, ''),
    frontmatter: parseSpecFrontmatter(markdown),
    body: markdown.replace(/^---\n[\s\S]*?\n---\n/u, '')
  };
}

function findingSignature(finding: SpecReviewerFinding): string {
  const normalize = (text: string) => text.trim().replace(/\s+/gu, ' ').toLowerCase();
  return digest(JSON.stringify([finding.scope, finding.severity, normalize(finding.title),
    normalize(finding.body), finding.scope === 'passage' ? finding.passageQuote ?? null : null]));
}

export function specBinding(evidence: Pick<Evidence, 'scope' | 'lookup' | 'quote'>, markdown: string, artifactId: string) {
  const fallback = (location: Location) => ({ location, anchor: null });
  if (evidence.scope === 'document') return fallback('document_scope');
  if (evidence.lookup === 'missing') return fallback('quote_missing');
  if (evidence.lookup === 'not_found') return fallback('quote_not_found_in_candidate');
  if (evidence.lookup === 'non_unique') return fallback('quote_non_unique_in_candidate');
  const selected = locateSpecQuote(markdown, evidence.quote);
  if (selected.status !== 'unique') return fallback(selected.status === 'non_unique'
    ? 'quote_non_unique_in_selected' : 'quote_removed_from_selected');
  const anchor = { kind: 'artifact_range' as const, artifactId, from: selected.from, to: selected.to, quotedText: evidence.quote! };
  validateSpecAnchor({ anchor, currentSpec: { markdown, artifactId } });
  return { location: 'bound' as const, anchor };
}

function exactDispositions(dispositions: readonly FindingDisposition[], ids: readonly string[]): boolean {
  const expected = new Set(ids);
  return dispositions.every(d => expected.delete(d.feedbackId)) && expected.size === 0;
}

export async function runSpecConvergence(
  input: SpecConvergenceInput,
  options: LayeredConvergenceEngineOptions
): Promise<SpecConvergenceResult> {
  if (input.signal?.aborted) return cancelledSpec;
  const policy = (options.getPolicy ?? getStepConvergencePolicy)(input.workflow, 'spec.author');
  const progress: ReviewProgress = { altitude: getImplementationAltitudeLadder(policy)[0]!, round: 1, role: 'none' };
  const tags = { component: 'spec-convergence', runId: input.run.id, phase: 'spec', step: 'spec.author' };
  const logFailure = (reason: unknown) => {
    // Only allowlisted codes/phrases may reach telemetry, never a runner reason verbatim.
    const safe = makeSanitizedFailureReason(reason);
    const failureCode = !safe || safe === 'Runner failed before terminal result.'
      ? 'runner_failed_before_terminal_result' : safe.replace(/^Execution failed: /u, '');
    options.logger?.error?.('spec_convergence_failed', { ...tags, ...progress, outcome: 'failed', failureCode });
  };
  let result: SpecConvergenceResult;
  try {
    result = await runSpecReview(input, options, policy, progress, tags);
  } catch (cause) {
    if (input.signal?.aborted) return cancelledSpec;
    if (cause instanceof StaleDispatchError) throw cause;
    await commitConvergenceEffect(input.commitResult, async () => logFailure((cause == null ? undefined : safeFailureReasonFromError(cause)) ?? 'spec_authoring_failed'));
    throw cause;
  }
  if (input.signal?.aborted) return cancelledSpec;
  if (result.directive === 'fail') await commitConvergenceEffect(input.commitResult, async () => logFailure(result.reason));
  return result;
}

async function runSpecReview(
  input: SpecConvergenceInput,
  options: LayeredConvergenceEngineOptions,
  policy: ReturnType<typeof getStepConvergencePolicy>,
  progress: ReviewProgress,
  tags: Readonly<Record<string, string>>
): Promise<SpecConvergenceResult> {
  const { run, runStep } = input;
  options = { ...options, feedback: guardConvergenceFeedback(options.feedback, input.commitResult) };
  const fail = (reason: string): SpecConvergenceResult => ({ directive: 'fail', reason });
  if (!options.feedback.createSpecReviewFinding || !options.feedback.bindSpecReviewAnchor) {
    return fail('spec_review_not_configured');
  }
  const kind = input.workflow.artifactKind;
  if (kind !== 'feature_spec' && kind !== 'enhancement_spec') return fail('spec_review_not_configured');
  let state = stateOf(runStep.checkpointResult);
  if (!state && input.answer) {
    const previous = stateOf(input.steps.find(step => step.id === input.answer?.sourceStepId)?.checkpointResult);
    if (!previous?.pause || previous.pause.role !== input.answer.role) return fail('spec_review_checkpoint_invalid');
    state = { ...previous, answer: { body: input.answer.body, role: input.answer.role } };
    delete state.pause;
  }
  const items = new Map((await options.feedback.listByRun(run.id))
    .filter(item => item.tenant === run.tenant && item.target === 'artifact').map(item => [item.id, item]));
  if (!state) {
    const evidenceById: Record<string, Evidence> = {};
    for (const step of [...input.steps].sort((a, b) => a.occurrence.index - b.occurrence.index)) {
      Object.assign(evidenceById, stateOf(step.checkpointResult)?.evidence ?? {});
    }
    const open = [...items.values()].filter(item => item.status === 'open' &&
      (item.thread[0]?.author.kind === 'human' || evidenceById[item.id] !== undefined));
    state = { occurrenceId: runStep.id, ...policy, altitudeIndex: 0, round: 1,
      rounds: [], decisions: {}, decisionAuthors: {}, openIds: open.map(item => item.id), evidence: {} };
    for (const item of open) {
      const evidence = evidenceById[item.id];
      if (evidence) state.evidence[item.id] = { ...evidence };
    }
  }

  const current = state;
  const ladder = getImplementationAltitudeLadder(current);
  progress.altitude = ladder[current.altitudeIndex]!;
  progress.round = current.round;
  if (current.pause) return { directive: 'needs_input', pause: current.pause, checkpoint: checkpoint(current) };
  const persist = async () => {
    input.signal?.throwIfAborted();
    await commitConvergenceEffect(input.commitResult, () => options.runSteps.updateCheckpoint({ runStepId: runStep.id, runId: run.id, tenant: run.tenant,
      checkpointResult: checkpoint(current) }));
  };
  let workspace = input.workspace;
  const getWorkspace = async () => {
    workspace ??= await options.workspaceContextRefresher?.(run.id);
    if (!workspace) throw new Error('Spec review requires a materialized workspace.');
    return workspace;
  };
  const pause = async (role: Role, question: string | undefined, sessionId: string | undefined): Promise<SpecConvergenceResult> => {
    let safeQuestion = question?.trim() || 'More information is needed to continue spec review.';
    if (current.pending) safeQuestion = safeQuestion.replaceAll(current.pending.key, 'the draft');
    if (workspace) safeQuestion = safeQuestion.replaceAll(dirname(workspace.workspaceRepoRoot), 'the workspace');
    current.pause = { kind: 'spec_question', producingStep: 'spec.author', role,
      question: safeQuestion, sourceStepId: runStep.id, ...(sessionId ? { sessionId } : {}) };
    await persist();
    options.logger?.info?.('spec_convergence_paused', { ...tags, ...progress, outcome: 'needs_input' });
    return { directive: 'needs_input', pause: current.pause, checkpoint: checkpoint(current) };
  };

  if (!current.outcome) {
    const routes = await resolveReviewedRoutes({ runId: run.id, tenant: run.tenant, step: 'spec.author',
      routing: options.routing, ...(options.logger ? { logger: options.logger } : {}) });
    const author = routes.implementerRoute.profile;
    const reviewer = routes.reviewerRoute.profile;
    current.distinct = author.model.provider !== reviewer.model.provider || author.model.model !== reviewer.model.model;
    if (!current.distinct && routes.routingInfo.distinct) {
      options.logger?.warn('route_distinct_unsatisfied: spec roles resolve to the same model', {
        runId: run.id, step: 'spec.author', warningCode: 'role_distinct_unsatisfied'
      });
    }
    const canonical = await input.readCanonicalSpec();
    while (!current.outcome) {
      if (input.signal?.aborted) return cancelledSpec;
      const altitude = ladder[current.altitudeIndex]!;
      const round = current.round;
      Object.assign(progress, { altitude, round, role: 'none' });
      const base = { run, runId: run.id, tenant: run.tenant, round };
      let pending = current.pending;
      let markdown = pending ? await readCandidate(await getWorkspace(), pending) : undefined;
      const previousMarkdown = current.last ? await readCandidate(await getWorkspace(), current.last) : undefined;
      const previousDraft = previousMarkdown ?? canonical?.markdown;
      const canonicalPath = canonical?.path ?? current.last?.path ?? pending?.path;

      const runRole = (role: Role, attempt: number, task: Omit<SpecReviewSessionInput, 'resultFile' | 'focus'>) => {
        input.signal?.throwIfAborted();
        progress.role = role;
        return options.dispatcher.runRole({
          ...base, role, ...(input.signal ? { signal: input.signal } : {}), reviewedOccurrence: { id: input.runStep.id, workflow: input.workflow,
            ...(input.stillOwns ? { stillOwns: input.stillOwns } : {}) }, route: role === 'reviewer' ? routes.reviewerRoute : routes.implementerRoute,
          toolPolicyMode: 'read_only',
          specReview: { ...task, focus: focusByAltitude[altitude],
            resultFile: `spec-review-${digest(current.occurrenceId).slice(0, 12)}-${altitude}-${round}-${role}-${attempt}-${randomUUID()}.json`,
            ...(current.answer?.role === role ? { answer: current.answer.body } : {}) }
        });
      };

      if (!pending || markdown === undefined) {
        if (pending && current.intake) {
          // The old candidate cannot be selected. Retain any findings already
          // written by a partial intake; the replacement still needs a review.
          for (const evidence of Object.values(current.evidence)) {
            if (evidence.digest !== pending.digest || evidence.round !== round || evidence.altitude !== altitude) continue;
            if (!items.has(evidence.id)) delete current.evidence[evidence.id];
            else if (!current.openIds.includes(evidence.id) && !current.decisions[evidence.id]) current.openIds.push(evidence.id);
          }
        }
        delete current.intake;
        const authorAnswer = current.answer?.role === 'implementer' ? current.answer.body : pending?.authorAnswer;
        const feedback = current.openIds.map(id => {
          const item = items.get(id);
          if (!item) throw new Error('Missing carried spec feedback.');
          const severity = current.evidence[id]?.severity;
          return { feedbackId: id, title: item.title, body: item.body, thread: item.thread,
            ...(severity ? { severity } : {}) };
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          const output = await runRole('implementer', attempt, {
            ...(previousDraft !== undefined ? { revision: digest(previousDraft) } : {}),
            feedback, priorDispositions: Object.values(current.decisions),
            ...(authorAnswer ? { answer: authorAnswer } : {}),
            ...(canonicalPath ? { canonicalPath } : {}), ...(previousDraft ? { previousMarkdown: previousDraft } : {}),
            ...(attempt ? { correction: 'Return a valid spec envelope and disposition every listed ID exactly once.' } : {})
          });
          if (output.workResult.directive === 'cancelled' || input.signal?.aborted) return cancelledSpec;
          if (output.workResult.directive === 'needs_input') return pause('implementer', output.workResult.question, output.sessionId);
          const parsed = reviewedSpecAuthorResultSchema.safeParse(output.sessionCheckpointResult ??
            (output.workResult.directive === 'advance' ? output.workResult.result : undefined));
          if (output.workResult.directive === 'advance' && parsed.success &&
              exactDispositions(parsed.data.dispositions, current.openIds) && parsed.data.spec.kind === kind &&
              (!canonicalPath || canonicalPath === parsed.data.spec.relativePath)) {
            const rendered = renderReviewedSpecCandidate(parsed.data.spec, previousDraft, canonical?.markdown);
            markdown = rendered.markdown;
            if (Buffer.from(markdown, 'utf8').toString('utf8') !== markdown) return fail('spec_author_result_invalid');
            const key = `spec-candidate-${randomUUID()}.md`;
            await writeFile(join(await scratchRoot(await getWorkspace()), key), markdown, { flag: 'wx', mode: 0o600 });
            pending = { key, path: rendered.spec.relativePath, digest: digest(markdown),
              dispositions: parsed.data.dispositions,
              implementer: output.modelPrincipal?.kind === 'model' ? output.modelPrincipal
                : { id: `${author.model.provider}:${author.model.model}`, kind: 'model', tenantId: run.tenant },
              ...(authorAnswer ? { authorAnswer } : {}),
              ...(output.sessionId ? { implementerSessionId: output.sessionId } : {}) };
            current.pending = pending;
            if (current.answer?.role === 'implementer') delete current.answer;
            await persist();
            break;
          }
          if (output.workResult.directive === 'fail' && !isResultFailure(output.workResult.reason)) return fail(output.workResult.reason);
          if (attempt === 1) return fail('spec_author_result_invalid');
        }
      }
      if (!pending || markdown === undefined) return fail('spec_review_checkpoint_invalid');

      for (let attempt = 0; !current.intake && attempt < 2; attempt++) {
        const output = await runRole('reviewer', attempt, {
          candidateKey: pending.key, canonicalPath: pending.path, revision: pending.digest,
          priorReview: JSON.stringify({
            lastReviewedRevision: current.last?.digest ?? null,
            earlierFindings: Object.keys(current.evidence).flatMap(id => {
              const item = items.get(id);
              return item ? [{ id, title: item.title, body: item.body, status: item.status }] : [];
            }),
            dispositions: [...Object.values(current.decisions), ...pending.dispositions]
          }),
          ...(attempt ? { correction: 'Return a valid verdict with scoped findings. Never supply anchors.' } : {})
        });
        if (output.workResult.directive === 'cancelled' || input.signal?.aborted) return cancelledSpec;
        if (output.workResult.directive === 'needs_input') return pause('reviewer', output.workResult.question, output.sessionId);
        const parsed = specReviewerResultSchema.safeParse(output.sessionCheckpointResult ??
          (output.workResult.directive === 'advance' ? output.workResult.result : undefined));
        if (output.workResult.directive === 'advance' && parsed.success) {
          const profile = routes.reviewerRoute.profile;
          if (await readCandidate(await getWorkspace(), pending) !== markdown) return fail('spec_review_candidate_changed');
          current.intake = { findings: parsed.data.status === 'findings' ? parsed.data.findings : [],
            reviewer: output.modelPrincipal?.kind === 'model' ? output.modelPrincipal
              : { id: `${profile.model.provider}:${profile.model.model}`, kind: 'model', tenantId: run.tenant },
            ...(output.sessionId ? { sessionId: output.sessionId } : {}) };
          await persist();
          break;
        }
        if (output.workResult.directive === 'fail' && !isResultFailure(output.workResult.reason)) return fail(output.workResult.reason);
        if (attempt === 1) return fail(
          (output.workResult.directive === 'fail' && /missing/u.test(output.workResult.reason)) ||
          (output.workResult.directive === 'advance' && output.workResult.result === undefined && output.sessionCheckpointResult === undefined)
            ? 'reviewer_result_missing' : 'reviewer_result_invalid');

      }
      const reviewed = current.intake;
      if (!reviewed || await readCandidate(await getWorkspace(), pending) !== markdown) return fail('spec_review_candidate_changed');
      delete current.answer;

      const matched = new Set<string>();
      const raised: string[] = [];
      const rows: { id: string; finding: SpecReviewerFinding }[] = [];
      for (const finding of reviewed.findings) {
        const signature = findingSignature(finding);
        const prior = Object.values(current.evidence).find(entry => entry.signature === signature && !matched.has(entry.id));
        const id = prior?.id ?? `fb_spec_${digest(JSON.stringify([current.occurrenceId, signature, raised.length]))}`;
        matched.add(id);
        raised.push(id);
        if (!items.has(id)) rows.push({ id, finding });
        const quote = finding.scope === 'passage' ? finding.passageQuote : undefined;
        current.evidence[id] = { id, occurrenceId: current.occurrenceId, signature, altitude, round, scope: finding.scope,
          severity: finding.severity, digest: pending.digest, lookup: locateSpecQuote(markdown, quote).status,
          ...(quote !== undefined ? { quote } : {}) };
      }
      // Persist binding evidence before creating feedback rows. If intake is
      // interrupted, resuming the same verdict reuses the recorded IDs.
      if (rows.length) await persist();
      for (const { id, finding } of rows) {
        const item = await options.feedback.createSpecReviewFinding(id, {
          runId: run.id, tenant: run.tenant, owner: run.owner, target: 'artifact', status: 'open',
          title: finding.title, body: finding.body,
          thread: [{ id: `thread_${id}`, author: reviewed.reviewer, body: finding.body, createdAt: (options.clock ?? clock)() }]
        });
        items.set(id, item);
      }

      for (const d of pending.dispositions) {
        current.decisions[d.feedbackId] = d;
        current.decisionAuthors[d.feedbackId] = pending.implementer;
      }
      const dispositionRejected: string[] = [];
      for (const id of raised) {
        if (current.decisions[id]?.disposition === 'fixed') {
          delete current.decisions[id];
          delete current.decisionAuthors[id];
          dispositionRejected.push(id);
        }
      }
      current.openIds = [...new Set([...current.openIds, ...raised])].filter(id => current.decisions[id] === undefined);
      const previous = current.rounds.at(-1);
      const settled = current.openIds.length === 0;
      const outcome = settled ? 'converged' : round >= current.maxRounds ? 'max_rounds'
        : previous?.altitude === altitude && current.openIds.some(id => previous.findings.includes(id))
          ? 'oscillation' : 'continue';
      current.rounds.push({ altitude, round, findings: raised,
        findingEvidence: raised.map(feedbackId => {
          const evidence = current.evidence[feedbackId]!;
          return { feedbackId, scope: evidence.scope, severity: evidence.severity,
            lookup: evidence.lookup, candidateDigest: evidence.digest };
        }),
        dispositions: pending.dispositions, outcome, dispositionRejected,
        ...(pending.implementerSessionId ? { implementerSessionId: pending.implementerSessionId } : {}),
        ...(reviewed.sessionId ? { reviewerSessionId: reviewed.sessionId } : {}) });
      current.last = pending;
      delete current.pending;
      delete current.intake;
      if (settled && current.altitudeIndex < ladder.length - 1) {
        current.altitudeIndex++;
        current.round = 1;
      } else if (outcome !== 'continue') {
        current.outcome = outcome;
      } else {
        current.round++;
      }
      await persist();
      options.logger?.info?.('spec_convergence_round', { ...tags, altitude, round, role: 'reviewer', outcome });
    }
  }

  progress.role = 'none';
  if (current.completion) return { directive: 'advance', checkpoint: checkpoint(current) };
  const selected = current.last;
  if (!selected) return fail('spec_review_checkpoint_invalid');
  const markdown = (await readCandidate(await getWorkspace(), selected)) ?? await input.readHead(selected.path);
  if (markdown === null || digest(markdown) !== selected.digest) return fail('spec_review_candidate_changed');
  if (input.signal?.aborted) return cancelledSpec;
  const completed = await input.complete(candidateResult(selected.path, markdown, kind), markdown);
  if (!completed || completed.committedMarkdown !== markdown) return fail('spec_authoring_failed');

  for (const evidence of Object.values(current.evidence)) {
    const binding = specBinding(evidence, completed.committedMarkdown, completed.artifact.id);
    await options.feedback.bindSpecReviewAnchor({
      runId: run.id, tenant: run.tenant, artifactId: completed.artifact.id,
      feedbackId: evidence.id, anchor: binding.anchor
    });
    evidence.location = binding.location;
    options.logger?.info?.('spec_convergence_binding', {
      ...tags, altitude: evidence.altitude, round: evidence.round, role: 'reviewer', feedbackId: evidence.id,
      outcome: binding.location === 'bound' ? 'bound' : 'target_level',
      ...(binding.location !== 'bound' ? { fallbackCode: binding.location } : {})
    });
  }

  for (const disposition of Object.values(current.decisions)) {
    await settleDisposition(run, disposition, current.occurrenceId, current.decisionAuthors[disposition.feedbackId], options);
  }
  current.completion = completed.checkpointResult;
  await persist();
  return { directive: 'advance', checkpoint: checkpoint(current) };
}

function isResultFailure(reason: string): boolean {
  return /result_(?:file|json|missing|invalid|malformed)|schema_validation_failed|(?:missing|duplicate)_structured_result/u.test(reason);
}

async function settleDisposition(
  run: Run, disposition: FindingDisposition, occurrence: string, implementer: Principal | undefined,
  options: LayeredConvergenceEngineOptions
): Promise<void> {
  const feedbackId = disposition.feedbackId;
  const item = await options.feedback.findById(feedbackId);
  if (!item || item.runId !== run.id || item.tenant !== run.tenant || item.target !== 'artifact') {
    throw new Error('Invalid spec disposition target.');
  }
  const model = item.thread[0]?.author.kind === 'model';
  const fixed = disposition.disposition === 'fixed';
  const body = fixed ? disposition.summary : disposition.reason;
  const threadId = `thread_spec_${digest(JSON.stringify([occurrence, feedbackId]))}`;
  const time = (options.clock ?? clock)();
  const system: Principal = { id: 'system', kind: 'system', tenantId: run.tenant };
  const entry = { id: threadId, author: implementer ?? system, body, createdAt: time };
  if (item.status === 'open' && !item.thread.some(comment => comment.id === threadId)) {
    if (!model && !fixed) {
      await options.feedback.appendThreadEntry({ feedbackId, threadEntry: entry, updatedAt: time });
    } else {
      await options.feedback.updateStatusAndAppendThread({ feedbackId, expectedStatus: 'open',
        nextStatus: fixed ? 'addressed' : 'wont_fix', threadEntry: entry, updatedAt: time });
    }
  }
  if (model && fixed && (await options.feedback.findById(feedbackId))?.status === 'addressed') {
    await options.feedback.updateStatusAndAppendThread({ feedbackId, expectedStatus: 'addressed', nextStatus: 'resolved',
      threadEntry: { ...entry, id: `${threadId}_resolved`, author: system, body: 'Resolved by spec convergence.' }, updatedAt: time });
  }
}
