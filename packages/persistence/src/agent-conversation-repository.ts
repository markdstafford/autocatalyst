import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';

import { agentConversationSlots as slots, reviewedDispatchAttempts as attempts, runs, runSteps, runWorkspaceMetadata as workspaces, sessions } from './schema.js';
import { asInternalSqliteDatabase, type SqliteDatabase } from './sqlite.js';

export interface ConversationSlotKey {
  readonly tenant: string;
  readonly runId: string;
  readonly step: 'spec.author' | 'implementation.build';
  readonly role: 'implementer' | 'reviewer';
}

export interface ReviewedDispatchAttempt extends ConversationSlotKey {
  readonly id: string;
  readonly occurrenceId: string;
  readonly round: number;
}

export interface ConversationBinding {
  readonly generation: string;
  readonly compatibilityDigest: string;
  readonly scopeDigest: string;
  readonly prIdentity: string | null;
}

export interface ConversationClaim {
  readonly version: number;
  readonly binding: ConversationBinding;
  readonly resume?: { readonly handle: string; readonly storageScope: string };
}

const keyOf = (key: ConversationSlotKey) =>
  and(eq(slots.tenant, key.tenant), eq(slots.runId, key.runId), eq(slots.step, key.step), eq(slots.role, key.role));

export class DrizzleAgentConversationRepository {
  readonly #db: ReturnType<typeof asInternalSqliteDatabase>['drizzle'];

  constructor(db: SqliteDatabase) {
    this.#db = asInternalSqliteDatabase(db).drizzle;
  }

  /** The proof is a host-derived fingerprint of both verified root instances. */
  enroll(input: { tenant: string; runId: string; root: string; branch: string; proof: string | null }): string | null {
    return this.#db.transaction(tx => {
      const row = tx.select({ workspace: workspaces }).from(workspaces).innerJoin(runs, eq(runs.id, workspaces.runId))
        .where(and(eq(runs.id, input.runId), eq(runs.tenant, input.tenant),
          eq(workspaces.workspaceRepoRoot, input.root), eq(workspaces.workspaceHandle, input.branch))).get()?.workspace;
      if (!row) return null;
      if (input.proof !== null && row.enrollmentProof === input.proof && row.generation !== '') return row.generation;
      const generation = randomUUID();
      tx.update(workspaces).set({ generation, enrollmentProof: input.proof }).where(eq(workspaces.runId, input.runId)).run();
      tx.update(slots).set({
        state: 'retired', nativeHandle: null, claimingAttemptId: null
      }).where(and(eq(slots.runId, input.runId), eq(slots.tenant, input.tenant))).run();
      return input.proof !== null ? generation : null;
    }, { behavior: 'immediate' });
  }

  invalidateWorkspace(tenant: string, runId: string): void {
    this.#db.transaction(tx => {
      const run = tx.select({ id: runs.id }).from(runs).where(and(eq(runs.id, runId), eq(runs.tenant, tenant))).get();
      if (!run) return;
      tx.update(workspaces).set({ generation: randomUUID(), enrollmentProof: null }).where(eq(workspaces.runId, runId)).run();
      tx.update(slots).set({ state: 'retired', nativeHandle: null, claimingAttemptId: null })
        .where(and(eq(slots.runId, runId), eq(slots.tenant, tenant))).run();
    }, { behavior: 'immediate' });
  }

  /** Called under workspace ownership; only live slot references preserve history. */
  referencedScopes(tenant: string, runId: string, generation: string): ReadonlySet<string> {
    const rows = this.#db.select({ id: slots.storageScope, state: slots.state }).from(slots)
      .where(and(eq(slots.tenant, tenant), eq(slots.runId, runId), eq(slots.workspaceGeneration, generation))).all();
    return new Set(rows.flatMap(row => row.state !== 'retired' && row.id ? [row.id] : []));
  }

  /** Startup only: work that was still in flight did not publish a reusable scope. */
  readyWorkspaceScopes(input: { tenant: string; runId: string; root: string; branch: string }) {
    const workspace = this.#db.select({ generation: workspaces.generation }).from(workspaces)
      .innerJoin(runs, eq(runs.id, workspaces.runId))
      .where(and(eq(runs.id, input.runId), eq(runs.tenant, input.tenant), eq(workspaces.workspaceRepoRoot, input.root),
        eq(workspaces.workspaceHandle, input.branch), isNotNull(workspaces.enrollmentProof))).get();
    if (!workspace) return undefined;
    const ready = this.#db.select({ id: slots.storageScope }).from(slots)
      .where(and(eq(slots.tenant, input.tenant), eq(slots.runId, input.runId),
        eq(slots.workspaceGeneration, workspace.generation), eq(slots.state, 'ready'))).all();
    return { generation: workspace.generation, scopes: new Set(ready.map(row => row.id)) };
  }

  begin(attempt: ReviewedDispatchAttempt, binding?: ConversationBinding, mode?: 'fallback'): ConversationClaim | undefined {
    return this.#db.transaction(tx => {
      const owner = tx.select({ step: runs.currentStep }).from(runs)
        .where(and(eq(runs.id, attempt.runId), eq(runs.tenant, attempt.tenant))).get();
      const occurrence = tx.select({ id: runSteps.id }).from(runSteps)
        .where(and(eq(runSteps.id, attempt.occurrenceId), eq(runSteps.runId, attempt.runId),
          eq(runSteps.step, attempt.step), isNull(runSteps.endedAt))).get();
      if (owner?.step !== attempt.step || !occurrence) throw new Error('reviewed_dispatch_not_owned');
      const previous = tx.select().from(slots).where(keyOf(attempt)).get();
      const workspace = tx.select().from(workspaces).where(eq(workspaces.runId, attempt.runId)).get();
      const latest = tx.select({ id: attempts.id }).from(attempts).where(and(
        eq(attempts.runId, attempt.runId), eq(attempts.tenant, attempt.tenant), eq(attempts.step, attempt.step), eq(attempts.role, attempt.role)
      )).orderBy(desc(attempts.order)).limit(1).get();
      const latestSession = tx.select({ id: sessions.id }).from(sessions).where(and(
        eq(sessions.runId, attempt.runId), eq(sessions.step, attempt.step), eq(sessions.role, attempt.role)
      )).orderBy(desc(sessions.sequence)).limit(1).get();
      const eligible = previous?.state !== 'in_flight' && binding !== undefined && workspace?.enrollmentProof != null && binding.generation === workspace.generation;
      const reusable = eligible && mode !== 'fallback' && previous?.state === 'ready' &&
        previous.nativeHandle !== null && previous.storageScope !== null && previous.adapterMetadata?.version === 1 &&
        previous.completedAttemptId === latest?.id && previous.completedAttemptId === latestSession?.id &&
        previous.latestAttemptId === latest.id && previous.workspaceGeneration === binding.generation &&
        previous.compatibilityDigest === binding.compatibilityDigest && previous.scopeDigest === binding.scopeDigest &&
        (previous.prIdentity === binding.prIdentity || (previous.prIdentity === null && binding.prIdentity !== null));
      const resume = reusable ? { handle: previous.nativeHandle!, storageScope: previous.storageScope! } : undefined;
      tx.insert(attempts).values({
        id: attempt.id, tenant: attempt.tenant, runId: attempt.runId, step: attempt.step,
        role: attempt.role, round: attempt.round, occurrenceId: attempt.occurrenceId,
        decision: mode ?? (resume ? 'resume' : eligible ? 'fresh' : 'retention_disallowed')
      }).run();
      const version = (previous?.version ?? 0) + 1;
      const next = {
        version, state: eligible ? 'in_flight' as const : 'retired' as const,
        workspaceGeneration: workspace?.generation ?? '',
        latestAttemptId: attempt.id, claimingAttemptId: eligible ? attempt.id : null,
        compatibilityDigest: eligible ? binding.compatibilityDigest : null,
        scopeDigest: eligible ? binding.scopeDigest : null, prIdentity: eligible ? binding.prIdentity : null,
        storageScope: resume?.storageScope ?? null, nativeHandle: resume?.handle ?? null, adapterMetadata: null,
        completedAttemptId: null
      };
      if (previous) tx.update(slots).set(next).where(and(keyOf(attempt), eq(slots.version, previous.version))).run();
      else if (eligible) tx.insert(slots).values({ tenant: attempt.tenant, runId: attempt.runId, step: attempt.step, role: attempt.role, ...next }).run();
      return eligible ? { version, binding, ...(resume ? { resume } : {}) } : undefined;
    }, { behavior: 'immediate' });
  }

  markLaunched(attempt: ReviewedDispatchAttempt, launch: NonNullable<typeof attempts.$inferSelect.launch>): void {
    this.#db.update(attempts).set({ launch }).where(and(
      eq(attempts.id, attempt.id), eq(attempts.tenant, attempt.tenant), isNull(attempts.launch)
    )).run();
  }

  unrecordedLaunches(): readonly (typeof attempts.$inferSelect)[] {
    return this.#db.select({ attempt: attempts }).from(attempts).leftJoin(sessions, eq(attempts.id, sessions.id))
      .where(and(isNotNull(attempts.launch), isNull(sessions.id))).orderBy(attempts.order).all().map(row => row.attempt);
  }

  /** Move a refused preflight onto the fresh invocation, without a synthetic Session. */
  markFreshAfterPreflight(attempt: ReviewedDispatchAttempt): void {
    this.#db.update(attempts).set({ decision: 'fresh', launch: null }).where(and(
      eq(attempts.id, attempt.id), eq(attempts.tenant, attempt.tenant), eq(attempts.runId, attempt.runId)
    )).run();
  }

  finish(attempt: ReviewedDispatchAttempt, claim: ConversationClaim, native?: { handle: string; storageScope: string }): boolean {
    return this.#db.transaction(tx => {
      const workspace = tx.select().from(workspaces).innerJoin(runs, eq(workspaces.runId, runs.id))
        .where(and(eq(runs.id, attempt.runId), eq(runs.tenant, attempt.tenant), eq(runs.currentStep, attempt.step))).get()?.run_workspace_metadata;
      const session = tx.select({ id: sessions.id, outcome: sessions.outcome }).from(sessions)
        .where(and(eq(sessions.runId, attempt.runId), eq(sessions.step, attempt.step), eq(sessions.role, attempt.role)))
        .orderBy(desc(sessions.sequence)).limit(1).get();
      const occurrence = tx.select({ id: runSteps.id }).from(runSteps)
        .where(and(eq(runSteps.id, attempt.occurrenceId), eq(runSteps.runId, attempt.runId),
          eq(runSteps.step, attempt.step), isNull(runSteps.endedAt))).get();
      const ready = occurrence !== undefined && native !== undefined && native.handle.length > 0 && native.storageScope.length > 0 &&
        (!claim.resume || (claim.resume.handle === native.handle && claim.resume.storageScope === native.storageScope)) &&
        workspace?.generation === claim.binding.generation && workspace.enrollmentProof !== null &&
        session?.id === attempt.id && session.outcome === 'succeeded';
      const changed = tx.update(slots).set({
        state: ready ? 'ready' : 'retired',
        nativeHandle: ready ? native.handle : null, storageScope: ready ? native.storageScope : null,
        completedAttemptId: ready ? attempt.id : null, adapterMetadata: ready ? { version: 1 } : null,
        claimingAttemptId: null, version: claim.version + 1
      }).where(and(keyOf(attempt), eq(slots.state, 'in_flight'), eq(slots.version, claim.version),
        eq(slots.claimingAttemptId, attempt.id), eq(slots.workspaceGeneration, claim.binding.generation))).run().changes;
      return changed === 1 && ready;
    }, { behavior: 'immediate' });
  }
}
