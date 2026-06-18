import type { ConvergenceRoundRecord } from '@autocatalyst/api-contract';

export interface ImplementationSummaryRoundInput {
  readonly fixSummary?: string;
  readonly changedFiles?: readonly string[];
  readonly validation?: readonly string[];
  readonly followUps?: readonly string[];
  readonly nonGoals?: readonly string[];
}

export interface CumulativeImplementationSummary {
  readonly kind: 'cumulative_implementation_summary';
  readonly cumulativeSummary: string;
  readonly changedFiles: readonly string[];
  readonly validationSummary: readonly string[];
  readonly followUps: readonly string[];
  readonly nonGoals: readonly string[];
  readonly sourceRoundCount: number;
  readonly completedAt: string;
}

export function isCumulativeImplementationSummary(value: unknown): value is CumulativeImplementationSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as CumulativeImplementationSummary).kind === 'cumulative_implementation_summary'
  );
}

export class MissingCumulativeImplementationSummaryError extends Error {
  readonly code = 'missing_cumulative_implementation_summary';
  constructor(message = 'Cumulative implementation summary is required but was not found.') {
    super(message);
    this.name = 'MissingCumulativeImplementationSummaryError';
  }
}

export function requireCumulativeImplementationSummary(value: unknown): CumulativeImplementationSummary {
  if (!isCumulativeImplementationSummary(value)) {
    throw new MissingCumulativeImplementationSummaryError();
  }
  return value;
}

export function normalizeRepositoryPath(path: string): string | null {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
  if (normalized.length === 0) return null;
  if (normalized.startsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

export function mergeChangedFiles(...sources: ReadonlyArray<readonly string[]>): readonly string[] {
  const paths = new Set<string>();
  for (const source of sources) {
    for (const path of source) {
      const normalized = normalizeRepositoryPath(path);
      if (normalized !== null) paths.add(normalized);
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function formatPathList(paths: readonly string[]): string {
  if (paths.length === 1) return paths[0]!;
  if (paths.length === 2) return `${paths[0]!} and ${paths[1]!}`;
  return `${paths.slice(0, -1).join(', ')}, and ${paths[paths.length - 1]!}`;
}

export function summarizeChangedPaths(changedFiles: readonly string[]): string {
  const normalized = mergeChangedFiles(changedFiles);
  if (normalized.length === 0) return '';
  const listed = normalized.slice(0, 5);
  if (normalized.length <= 5) {
    return `Updates ${normalized.length === 1 ? listed[0] : `${normalized.length} files: ${formatPathList(listed)}`}.`;
  }
  return `Updates ${normalized.length} files including ${formatPathList(listed)}.`;
}

export function buildImplementationSummaryRoundInputs(
  rounds: readonly ConvergenceRoundRecord[]
): readonly ImplementationSummaryRoundInput[] {
  return rounds.map((round) => {
    const fixedSummaries = round.dispositions
      .filter((disposition) => disposition.disposition === 'fixed')
      .map((disposition) => disposition.summary.trim())
      .filter((summary) => summary.length > 0);
    const changedFiles = mergeChangedFiles(round.changedFilePaths);
    return {
      ...(fixedSummaries.length > 0 ? { fixSummary: fixedSummaries.join('; ') } : {}),
      ...(changedFiles.length > 0 ? { changedFiles } : {})
    };
  });
}

export function buildCumulativeImplementationSummary(input: {
  readonly rounds: readonly ImplementationSummaryRoundInput[];
  readonly completedAt: string;
}): CumulativeImplementationSummary {
  if (input.rounds.length === 0) {
    throw new MissingCumulativeImplementationSummaryError('At least one implementation round is required to build a cumulative summary.');
  }

  // Fold all rounds — append-and-reconcile, not replace
  const summaryParts: string[] = [];
  const changedFilesSet = new Set<string>();
  const validationSet = new Set<string>();
  const followUpsSet = new Set<string>();
  const nonGoalsSet = new Set<string>();

  for (const round of input.rounds) {
    if (round.fixSummary?.trim()) {
      summaryParts.push(round.fixSummary.trim());
    }
    for (const file of round.changedFiles ?? []) {
      changedFilesSet.add(file);
    }
    for (const v of round.validation ?? []) {
      validationSet.add(v);
    }
    for (const f of round.followUps ?? []) {
      followUpsSet.add(f);
    }
    for (const g of round.nonGoals ?? []) {
      nonGoalsSet.add(g);
    }
  }

  return {
    kind: 'cumulative_implementation_summary',
    cumulativeSummary: summaryParts.join('\n\n'),
    changedFiles: mergeChangedFiles([...changedFilesSet]),
    validationSummary: [...validationSet],
    followUps: [...followUpsSet],
    nonGoals: [...nonGoalsSet],
    sourceRoundCount: input.rounds.length,
    completedAt: input.completedAt
  };
}
