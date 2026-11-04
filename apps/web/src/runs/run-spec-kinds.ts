/**
 * The one `apps/web` table of work kinds that have an API-served spec artifact.
 *
 * This mirrors `specArtifactKindForRun` in `packages/core/src/control-plane-service.ts`:
 * that function returns a spec artifact kind only for `feature` and `enhancement` and
 * `null` for every other work kind. The Spec tab calls `getRunSpec` only for the kinds
 * listed here; every other kind shows the no-spec empty state without a network read.
 *
 * Keep this list in sync with `specArtifactKindForRun` (by function name, not a line
 * number). A parity test asserts the two agree.
 */
export const SPEC_CAPABLE_WORK_KINDS = ['feature', 'enhancement'] as const;

export type SpecCapableWorkKind = (typeof SPEC_CAPABLE_WORK_KINDS)[number];

/** Whether a run's work kind has an API-served spec artifact (so `getRunSpec` applies). */
export function isSpecCapableWorkKind(workKind: string): boolean {
  return (SPEC_CAPABLE_WORK_KINDS as readonly string[]).includes(workKind);
}
