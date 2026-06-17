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
    changedFiles: [...changedFilesSet],
    validationSummary: [...validationSet],
    followUps: [...followUpsSet],
    nonGoals: [...nonGoalsSet],
    sourceRoundCount: input.rounds.length,
    completedAt: input.completedAt
  };
}
