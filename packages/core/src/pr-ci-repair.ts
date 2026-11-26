import type { JsonValue, PullRequest, Run, RunStep } from '@autocatalyst/api-contract';
import type { RequiredCheckEvidence } from './code-host.js';
import type { OrchestratedRunResult } from './orchestrator.js';
import type { PublicationPushReceipt } from './pr-publication.js';

export type RepairState = 'external' | 'exhausted' | 'queued' | 'running' | 'awaiting_human' | 'publishing' | 'pushed' | 'stopped' | 'superseded';
export type TerminalRepairState = 'pushed' | 'stopped' | 'superseded';
export const activeRepairStates = new Set<RepairState>(['queued', 'running', 'awaiting_human', 'publishing']);

export interface RepairDecision {
  readonly pullRequestId: string;
  readonly runId: string;
  readonly tenant: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly gateStepId: string;
  readonly repairStepId: string | null;
  readonly currentStepId: string | null;
  readonly outcomeStepId: string | null;
  readonly ordinal: number | null;
  readonly limitAtDecision: number;
  readonly admittedCount: number;
  readonly state: RepairState;
  readonly failures: readonly RequiredCheckEvidence[];
  readonly ownerEpoch: string | null;
  readonly publishHeadSha: string | null;
  readonly candidateSha: string | null;
  readonly pushReceipt: PublicationPushReceipt | null;
  readonly refreshCount: number;
  readonly stopCode: string | null;
  readonly workspaceHold: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RepairMove = {
  readonly from: RepairDecision;
  readonly state: RepairState;
  readonly now: string;
  readonly nextStep?: 'implementation.build' | 'implementation.awaiting_input' | 'pr.finalize' | 'pr.human_review' | 'done' | 'failed' | 'canceled';
  readonly checkpoint?: JsonValue;
  readonly initialCheckpoint?: JsonValue;
  readonly stopCode?: string;
  readonly ownerEpoch?: string;
  readonly candidateSha?: string;
  readonly publishHeadSha?: string;
  readonly pushReceipt?: PublicationPushReceipt;
  readonly incrementRefresh?: true;
  readonly hold?: true;
  readonly prTerminal?: 'merged' | 'closed';
};

export interface RepairRepository {
  admit(input: {
    readonly run: Run; readonly pr: PullRequest; readonly gateId: string; readonly headSha: string;
    readonly baseRef: string; readonly repository: string; readonly failures: readonly RequiredCheckEvidence[]; readonly limit: number;
    readonly now: string; readonly deadlineMs: number;
  }): Promise<{ decision: RepairDecision; transition?: OrchestratedRunResult } | null>;
  listByRun(runId: string, tenant: string): Promise<readonly RepairDecision[]>;
  listRecoverable(): Promise<readonly RepairDecision[]>;
  move(input: RepairMove): Promise<{ decision: RepairDecision; transition?: OrchestratedRunResult } | null>;
  clearDrainedHold(from: RepairDecision): Promise<void>;
}

export function isActiveRepair(row: RepairDecision): boolean {
  return activeRepairStates.has(row.state);
}

export function findCurrentRepair(rows: readonly RepairDecision[]): RepairDecision | undefined {
  return rows.find(isActiveRepair);
}

export function exactRepairBinding(facts: import('./code-host.js').CodeHostPullRequestFacts, pr: PullRequest, repository: string): boolean {
  return facts.number === pr.number && facts.provider === pr.provider &&
    facts.url.toLowerCase() === pr.url.toLowerCase() &&
    facts.url.toLowerCase() === `https://github.com/${repository}/pull/${pr.number}`.toLowerCase();
}

export type RepairActivityReader = (run: Run, steps: readonly RunStep[]) => Promise<readonly RunStep[]>;
