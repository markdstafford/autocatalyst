import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { requiredCheckEvidenceSchema, type JsonValue, type PullRequest, type RunStep } from '@autocatalyst/api-contract';
import { activeRepairStates, buildEntryRunStep, fullGitSha, getRunStepDefinition,
  type RepairDecision, type RepairMove, type RepairRepository, type RepairState } from '@autocatalyst/core';
import { buildRunStepInsideTransaction, DrizzleRunRepository } from './domain-repositories.js';
import { conversations, projects, prCiRepairHeads as repairs, pullRequests, runs, runSteps, runWorkspaceMetadata, topics } from './schema.js';
import { asInternalSqliteDatabase, type SqliteDatabase } from './sqlite.js';

type Tx = Parameters<Parameters<ReturnType<typeof asInternalSqliteDatabase>['drizzle']['transaction']>[0]>[0];
type Row = typeof repairs.$inferSelect;

function key(pullRequestId: string, headSha: string) {
  return and(eq(repairs.pullRequestId, pullRequestId), eq(repairs.headSha, headSha));
}

function decision(row: Row, pr: { runId: string; tenant: string }): RepairDecision {
  const { failureDetailsJson, pushReceiptJson, ...columns } = row;
  return { ...columns, ...pr, failures: JSON.parse(failureDetailsJson), pushReceipt: pushReceiptJson === null ? null : JSON.parse(pushReceiptJson) };
}

function hasSamePr(row: typeof pullRequests.$inferSelect, expected: PullRequest): boolean {
  return row.state === 'open' && row.runId === expected.runId && row.tenant === expected.tenant &&
    row.provider === expected.provider && row.number === expected.number && row.url === expected.url && row.branch === expected.branch;
}

function openOccurrence(tx: Tx, id: string, runId: string) {
  return tx.select().from(runSteps).where(and(eq(runSteps.id, id), eq(runSteps.runId, runId), isNull(runSteps.endedAt))).get();
}

function advance(
  tx: Tx, source: typeof runSteps.$inferSelect, next: string, now: string, failure: string | null,
  checkpoint?: JsonValue, initial?: JsonValue
): RunStep {
  const step = getRunStepDefinition(next);
  if (step === null) throw new Error('Invalid repair transition.');
  tx.update(runSteps).set({
    endedAt: now, durationMs: Math.max(0, Date.parse(now) - Date.parse(source.startedAt)),
    ...(checkpoint !== undefined ? { checkpointResultJson: JSON.stringify(checkpoint) } : {})
  }).where(eq(runSteps.id, source.id)).run();
  tx.update(runs).set({
    currentStep: next, terminal: step.waitingOn === 'none', updatedAt: now, failureReason: failure
  }).where(eq(runs.id, source.runId)).run();
  return buildRunStepInsideTransaction(tx, source.runId, buildEntryRunStep(step, now), initial);
}

function legalMove(from: RepairState, input: RepairMove): boolean {
  const terminal = input.state === 'superseded' && (
    (input.prTerminal === 'merged' && input.nextStep === 'done') ||
    (input.prTerminal === 'closed' && input.nextStep === 'failed') ||
    (input.prTerminal === undefined && input.nextStep === 'canceled')
  );
  if (terminal) return true;
  if (input.state === 'stopped') return input.nextStep === 'pr.human_review' && input.stopCode !== undefined;
  if (from === 'awaiting_human') return input.state === 'queued' && input.nextStep === 'implementation.build';
  if (from === 'queued') return input.state === 'running' && input.nextStep === undefined && input.ownerEpoch !== undefined;
  if (from === 'running') {
    return (input.state === 'awaiting_human' && input.nextStep === 'implementation.awaiting_input' && input.candidateSha !== undefined) ||
      (input.state === 'running' && input.nextStep === 'pr.finalize') ||
      (input.state === 'publishing' && input.nextStep === undefined && input.publishHeadSha !== undefined);
  }
  if (from === 'publishing') {
    return (input.state === 'pushed' && input.nextStep === 'pr.human_review') ||
      (input.state === 'publishing' && input.nextStep === undefined && input.pushReceipt !== undefined);
  }
  return false;
}

export class DrizzleRepairRepository implements RepairRepository {
  readonly #db;
  readonly #runs;
  constructor(database: SqliteDatabase) {
    this.#db = asInternalSqliteDatabase(database).drizzle;
    this.#runs = new DrizzleRunRepository(database);
  }

  async admit(input: Parameters<RepairRepository['admit']>[0]): ReturnType<RepairRepository['admit']> {
    if (!fullGitSha.safeParse(input.headSha).success || !Number.isSafeInteger(input.limit) || input.limit < 0 ||
        input.failures.length === 0 || input.failures.length > 20 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,249}$/u.test(input.baseRef) ||
        input.baseRef.includes('..')) return null;
    const validated = input.failures.map(failure => requiredCheckEvidenceSchema.safeParse(failure));
    if (validated.some(value => !value.success)) return null;
    const result = this.#db.transaction(tx => {
      if (Date.now() >= input.deadlineMs) return null;
      const pr = tx.select().from(pullRequests).where(eq(pullRequests.id, input.pr.id)).get();
      if (pr === undefined || !hasSamePr(pr, input.pr) || pr.tenant !== input.run.tenant || pr.runId !== input.run.id) return null;
      const run = tx.select().from(runs).where(and(eq(runs.id, pr.runId), eq(runs.tenant, pr.tenant))).get();
      if (run === undefined || run.terminal || run.currentStep !== 'pr.human_review') return null;
      const project = tx.select({ binding: projects.hostRepositoryJson, setting: projects.codeHostSettingJson })
        .from(topics).innerJoin(conversations, eq(conversations.id, topics.conversationId))
        .innerJoin(projects, eq(projects.id, conversations.projectId)).where(and(eq(topics.id, run.topicId),
          eq(topics.tenant, pr.tenant), eq(conversations.tenant, pr.tenant), eq(projects.tenant, pr.tenant))).get();
      if (project?.setting == null) return null;
      const binding = JSON.parse(project.binding) as { provider: string; owner: string; name: string };
      const setting = JSON.parse(project.setting) as { provider: string; credentialRef?: unknown };
      if (binding.provider !== pr.provider || setting.provider !== pr.provider || setting.credentialRef === undefined ||
          `${binding.owner}/${binding.name}`.toLowerCase() !== input.repository.toLowerCase()) return null;
      const source = openOccurrence(tx, input.gateId, run.id);
      if (source?.step !== 'pr.human_review') return null;
      const work = tx.select().from(runWorkspaceMetadata).where(eq(runWorkspaceMetadata.runId, run.id)).get();
      if (work?.workspaceHandle !== pr.branch) return null;
      const rows = tx.select().from(repairs).where(eq(repairs.pullRequestId, pr.id)).all();
      if (rows.some(row => row.headSha === input.headSha || row.workspaceHold || activeRepairStates.has(row.state))) return null;
      const admitted = rows.reduce((max, row) => Math.max(max, row.ordinal ?? 0), 0);
      const state = input.limit === 0 ? 'exhausted' : input.headSha !== pr.autocatalystHeadSha ? 'external' :
        admitted >= input.limit ? 'exhausted' : 'queued';
      const stopCode = input.limit === 0 ? 'repair_disabled' : state === 'exhausted' ? 'repair_budget_exhausted' :
        state === 'external' ? 'repair_unverified_provenance' : null;
      const step = state === 'queued' ? advance(tx, source, 'implementation.build', input.now, null) : undefined;
      const row = tx.insert(repairs).values({
        pullRequestId: pr.id, headSha: input.headSha, baseRef: input.baseRef, gateStepId: input.gateId,
        repairStepId: step?.id ?? null, currentStepId: step?.id ?? null, ordinal: step ? admitted + 1 : null,
        limitAtDecision: input.limit, admittedCount: admitted, state, stopCode, failureDetailsJson: JSON.stringify(input.failures),
        createdAt: input.now, updatedAt: input.now
      }).returning().get();
      return { decision: decision(row, { runId: pr.runId, tenant: pr.tenant }), step };
    }, { behavior: 'immediate' });
    return this.#transition(result);
  }

  async listByRun(runId: string, tenant: string): Promise<readonly RepairDecision[]> {
    return this.#db.select({ repair: repairs, runId: pullRequests.runId, tenant: pullRequests.tenant })
      .from(repairs).innerJoin(pullRequests, eq(pullRequests.id, repairs.pullRequestId))
      .where(and(eq(pullRequests.runId, runId), eq(pullRequests.tenant, tenant)))
      .orderBy(asc(repairs.createdAt), asc(repairs.headSha)).all().map(({ repair, ...pr }) => decision(repair, pr));
  }

  async listRecoverable(): Promise<readonly RepairDecision[]> {
    return this.#db.select({ repair: repairs, runId: pullRequests.runId, tenant: pullRequests.tenant })
      .from(repairs).innerJoin(pullRequests, eq(pullRequests.id, repairs.pullRequestId))
      .where(inArray(repairs.state, ['queued', 'running', 'publishing']))
      .all().map(({ repair, ...pr }) => decision(repair, pr));
  }

  async move(input: RepairMove): ReturnType<RepairRepository['move']> {
    const from = input.from;
    if (!activeRepairStates.has(from.state) || from.currentStepId === null || !legalMove(from.state, input)) return null;
    const occurrenceId = from.currentStepId;
    const result = this.#db.transaction(tx => {
      const row = tx.select().from(repairs).where(key(from.pullRequestId, from.headSha)).get();
      if (row?.state !== from.state || row.currentStepId !== occurrenceId || row.ownerEpoch !== from.ownerEpoch ||
          row.publishHeadSha !== from.publishHeadSha || (row.pushReceiptJson !== null && input.pushReceipt !== undefined)) return null;
      const pr = tx.select().from(pullRequests).where(and(eq(pullRequests.id, from.pullRequestId),
        eq(pullRequests.runId, from.runId), eq(pullRequests.tenant, from.tenant), eq(pullRequests.state, 'open'))).get();
      if (pr === undefined) return null;
      const run = tx.select().from(runs).where(and(eq(runs.id, pr.runId), eq(runs.tenant, pr.tenant))).get();
      const source = openOccurrence(tx, occurrenceId, pr.runId);
      if (run === undefined || run.terminal || source?.step !== run.currentStep) return null;
      if (input.state === 'publishing' && from.state === 'running' &&
          (source.step !== 'pr.finalize' || pr.autocatalystHeadSha !== row.headSha || !fullGitSha.safeParse(input.publishHeadSha).success)) return null;
      if (input.incrementRefresh && (row.refreshCount >= 2 || source.step !== 'pr.finalize')) return null;
      if (input.candidateSha !== undefined && !fullGitSha.safeParse(input.candidateSha).success) return null;
      if (input.pushReceipt !== undefined && (input.pushReceipt.runId !== pr.runId || input.pushReceipt.branch !== pr.branch ||
          input.pushReceipt.headSha !== row.publishHeadSha || !fullGitSha.safeParse(input.pushReceipt.headSha).success)) return null;
      if (input.state === 'pushed') {
        const receipt = row.pushReceiptJson === null ? null : JSON.parse(row.pushReceiptJson);
        if (receipt === null || receipt.headSha !== row.publishHeadSha || pr.autocatalystHeadSha !== row.headSha) return null;
        tx.update(pullRequests).set({ autocatalystHeadSha: receipt.headSha, updatedAt: input.now }).where(eq(pullRequests.id, pr.id)).run();
      }
      if (input.prTerminal !== undefined) {
        tx.update(pullRequests).set({ state: input.prTerminal, updatedAt: input.now }).where(eq(pullRequests.id, pr.id)).run();
      }
      if (input.nextStep === undefined && input.checkpoint !== undefined) {
        tx.update(runSteps).set({ checkpointResultJson: JSON.stringify(input.checkpoint) }).where(eq(runSteps.id, source.id)).run();
      }
      const step = input.nextStep === undefined ? undefined : advance(tx, source, input.nextStep, input.now,
        input.prTerminal === 'closed' ? 'pull_request_closed_without_merge' : null, input.checkpoint, input.initialCheckpoint);
      const holding = input.hold === true;
      const staysActive = activeRepairStates.has(input.state);
      const updated = tx.update(repairs).set({
        state: input.state, currentStepId: staysActive ? (step?.id ?? occurrenceId) : null,
        outcomeStepId: staysActive ? null : occurrenceId,
        ownerEpoch: input.state === 'running' || input.state === 'publishing' || holding ? (input.ownerEpoch ?? from.ownerEpoch) : null,
        candidateSha: input.candidateSha ?? row.candidateSha,
        publishHeadSha: input.publishHeadSha ?? row.publishHeadSha,
        pushReceiptJson: input.pushReceipt === undefined ? row.pushReceiptJson : JSON.stringify(input.pushReceipt),
        refreshCount: row.refreshCount + (input.incrementRefresh ? 1 : 0),
        stopCode: input.stopCode ?? null, workspaceHold: holding, updatedAt: input.now
      }).where(key(pr.id, row.headSha)).returning().get();
      return { decision: decision(updated, { runId: pr.runId, tenant: pr.tenant }), step };
    }, { behavior: 'immediate' });
    return this.#transition(result);
  }

  async clearDrainedHold(from: RepairDecision): Promise<void> {
    if (from.ownerEpoch === null || from.currentStepId === null) return;
    this.#db.update(repairs).set({ workspaceHold: false, ownerEpoch: null }).where(and(
      key(from.pullRequestId, from.headSha), eq(repairs.ownerEpoch, from.ownerEpoch),
      eq(repairs.outcomeStepId, from.currentStepId), eq(repairs.workspaceHold, true),
      or(eq(repairs.state, 'superseded'), eq(repairs.state, 'stopped'))
    )).run();
  }

  async #transition(result: { decision: RepairDecision; step: RunStep | undefined } | null) {
    if (result === null) return null;
    if (result.step === undefined) return { decision: result.decision };
    const run = await this.#runs.findById(result.decision.runId);
    if (run === null) throw new Error('Repair run disappeared.');
    return { decision: result.decision, transition: { run, runStep: result.step } };
  }
}
