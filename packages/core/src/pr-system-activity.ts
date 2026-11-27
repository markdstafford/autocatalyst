import { runSystemActivitySchema, type PrCiCoverage, type Run, type RunStep, type RunSystemActivity } from '@autocatalyst/api-contract';
import type { PullRequestRepository } from './domain-repositories.js';
import type { RepairActivityReader, RepairRepository } from './pr-ci-repair.js';
import { safePublicationText } from './pr-publication.js';

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function integrationEntry(step: RunStep): RunSystemActivity | undefined {
  if (step.step !== 'pr.finalize' && step.step !== 'pr.open') return undefined;
  const value = obj(step.checkpointResult);
  const stop = value['kind'] === 'publication_stop';
  const integrated = obj(value['integration']);
  const attestation = obj(value['attestation']);
  if (!stop && (step.step !== 'pr.finalize' || value['kind'] !== 'pull_request_finalize' || attestation['targetSha'] === undefined)) return undefined;
  const code = stop ? value['code'] : 'pr_target_integrated';
  const details = stop ? value : { ...attestation, ...integrated };
  const parsed = runSystemActivitySchema.safeParse({
    key: `${step.id}:${code}`, timestamp: stop ? value['timestamp'] : value['completedAt'],
    kind: 'integration', code, ...Object.fromEntries([
      'base', 'repository', 'branch', 'sourceSha', 'targetSha', 'observedTargetSha', 'reviewedSha', 'publishSha',
      'paths', 'cleanup', 'refreshCount', 'sourcePushed', 'safeReason'
    ].filter(key => details[key] !== undefined).map(key => [key, details[key]]))
  });
  return parsed.success ? parsed.data : undefined;
}

export function createPrActivityReader(input: {
  readonly repairs: RepairRepository;
  readonly pullRequests: PullRequestRepository;
  readonly coverage: (tenant: string) => Promise<PrCiCoverage>;
}): RepairActivityReader {
  return async (run: Run, steps: readonly RunStep[]) => {
    const entries = new Map<string, RunSystemActivity[]>();
    const add = (stepId: string, activity: unknown) => {
      const parsed = runSystemActivitySchema.safeParse(activity);
      if (!parsed.success) return;
      const existing = entries.get(stepId) ?? [];
      existing.push(parsed.data);
      entries.set(stepId, existing);
    };
    const indexed = new Map(steps.map(step => [step.id, step]));
    const [pr, durable] = await Promise.all([input.pullRequests.findByRun(run.id), input.repairs.listByRun(run.id, run.tenant)]);
    const rows = pr?.tenant === run.tenant ? durable : [];
    const prUrl = pr?.tenant === run.tenant && /^https:\/\/github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/pull\/[1-9]\d*$/iu.test(pr.url) ? pr.url : undefined;
    for (const row of rows) {
      const code = row.ordinal === null ? row.stopCode : 'repair_queued';
      const fields = {
        headSha: row.headSha, checks: row.failures, limit: row.limitAtDecision,
        ...(row.ordinal !== null ? { ordinal: row.ordinal } : {}),
        ...(code === 'repair_budget_exhausted' ? { admittedCount: row.admittedCount } : {}),
        ...(prUrl !== undefined ? { prUrl } : {})
      };
      add(row.gateStepId, {
        key: `${row.gateStepId}:${row.pullRequestId}:${row.headSha}:${code}`, timestamp: row.createdAt,
        kind: 'ci_decision', code, ...fields
      });
      if (row.outcomeStepId !== null) {
        const outcome = row.state === 'pushed' ? 'repair_pushed' : row.stopCode;
        const checkpoint = obj(indexed.get(row.outcomeStepId)?.checkpointResult);
        const findings = Array.isArray(checkpoint['findings']) ? checkpoint['findings'].slice(0, 20).flatMap(raw => {
          const finding = obj(raw);
          const severity = finding['severity'];
          const summary = typeof finding['summary'] === 'string' ? safePublicationText(finding['summary']) : null;
          return summary !== null && (severity === 'blocker' || severity === 'warning' || severity === 'info') ? [{ severity, summary }] : [];
        }) : undefined;
        add(row.outcomeStepId, {
          key: `${row.outcomeStepId}:${outcome}`, timestamp: row.updatedAt, kind: 'ci_outcome', code: outcome, ...fields,
          workspaceHold: row.workspaceHold, base: row.baseRef,
          ...(row.state === 'pushed' ? { publishHeadSha: row.publishHeadSha } : {}),
          ...(findings?.length ? { findings } : {}),
          ...Object.fromEntries(['paths', 'sourceSha', 'targetSha', 'cleanup', 'requiredPending'].filter(key => checkpoint[key] !== undefined).map(key => [key, checkpoint[key]]))
        });
      }
      const start = row.repairStepId === null ? undefined : indexed.get(row.repairStepId)?.occurrence.index;
      const end = indexed.get(row.outcomeStepId ?? row.currentStepId ?? '')?.occurrence.index;
      if (start !== undefined && end !== undefined) {
        for (const step of steps) {
          if (step.step !== 'implementation.awaiting_input' || step.occurrence.index <= start || step.occurrence.index > end ||
              obj(obj(step.checkpointResult)['pause'])['kind'] !== 'convergence_escalation') continue;
          add(step.id, {
            key: `${step.id}:repair_needs_guidance`, timestamp: step.startedAt, kind: 'ci_guidance',
            code: 'repair_needs_guidance', ...fields
          });
        }
      }
    }
    const openGate = pr?.state === 'open' && !run.terminal && run.currentStep === 'pr.human_review';
    const coverage = openGate ? await input.coverage(run.tenant) : undefined;
    return steps.map(step => {
      const integration = integrationEntry(step);
      const activity = [...(entries.get(step.id) ?? []), ...(integration === undefined ? [] : [integration])];
      return {
        ...step, ...(activity.length > 0 ? { systemActivity: activity } : {}),
        ...(coverage !== undefined && step.step === 'pr.human_review' && step.endedAt === null ? { prCiCoverage: coverage } : {})
      };
    });
  };
}
