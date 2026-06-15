import type { ImplementationAltitude, ImplementationConvergenceDepth } from '@autocatalyst/api-contract';
import {
  implementationAltitudeSchema,
  implementationConvergenceDepthSchema
} from '@autocatalyst/api-contract';
import type { RunStepId } from './run-step-catalog.js';
import type { RunWorkflowDefinition } from './run-workflows.js';

export const defaultConvergenceMaxRounds = 3 as const;
export const defaultConvergenceDepth: ImplementationConvergenceDepth = 'build_only';

export interface StepConvergencePolicy {
  readonly maxRounds?: number;
  readonly depth?: ImplementationConvergenceDepth;
}

export interface ResolvedStepConvergencePolicy {
  readonly maxRounds: number;
  readonly depth: ImplementationConvergenceDepth;
}

export class StepConvergencePolicyError extends Error {
  readonly code: 'invalid_depth' | 'invalid_max_rounds';
  constructor(code: 'invalid_depth' | 'invalid_max_rounds', message: string) {
    super(message);
    this.name = 'StepConvergencePolicyError';
    this.code = code;
  }
}

export function getStepConvergencePolicy(
  workflow: RunWorkflowDefinition,
  step: RunStepId
): ResolvedStepConvergencePolicy {
  const configured = (workflow as { convergence?: Record<string, StepConvergencePolicy> }).convergence?.[step];

  let maxRounds: number = defaultConvergenceMaxRounds;
  if (configured?.maxRounds !== undefined) {
    const rounds = configured.maxRounds;
    if (!Number.isInteger(rounds) || rounds < 1) {
      throw new StepConvergencePolicyError(
        'invalid_max_rounds',
        `Invalid maxRounds for step '${step}': ${String(rounds)} (must be a positive integer).`
      );
    }
    maxRounds = rounds;
  }

  let depth: ImplementationConvergenceDepth = defaultConvergenceDepth;
  if (configured?.depth !== undefined) {
    const parsed = implementationConvergenceDepthSchema.safeParse(configured.depth);
    if (!parsed.success) {
      throw new StepConvergencePolicyError(
        'invalid_depth',
        `Invalid depth for step '${step}': ${String(configured.depth)}.`
      );
    }
    depth = parsed.data;
  }

  return { maxRounds, depth };
}

export function getImplementationAltitudeLadder(
  policy: ResolvedStepConvergencePolicy
): readonly ImplementationAltitude[] {
  switch (policy.depth) {
    case 'build_only':
      return ['build'];
    case 'layout':
      return ['layout', 'build'];
    case 'public_api':
      return ['layout', 'public_api', 'build'];
    case 'full':
      return ['layout', 'public_api', 'private_api', 'build'];
  }
}

// Re-export referenced contract types for ergonomic imports.
export type { ImplementationAltitude, ImplementationConvergenceDepth };
// Side-effect-free reference to keep schema import warnings away if tree-shaken.
void implementationAltitudeSchema;
