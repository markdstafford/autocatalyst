/**
 * The Spec tab body: chooses the correct empty state from the spec discriminator the
 * data hook computes.
 *
 * The discriminator is decided upstream (the hook probes `getRunSpec` only for
 * spec-capable work kinds — see `run-spec-kinds.ts`), so this component is a pure map
 * from discriminator to copy. No run in this feature renders the spec document itself.
 */
import type { ReactNode } from 'react';

import { RunDetailEmptyState } from './run-detail-empty-state.js';
import { SPEC_EMPTY_STATES } from './run-detail-empty-states.js';
import type { SpecDiscriminator } from './run-detail-facts.js';

export interface RunDetailSpecTabProps {
  readonly spec: SpecDiscriminator;
}

export function RunDetailSpecTab({ spec }: RunDetailSpecTabProps): ReactNode {
  switch (spec.status) {
    case 'no-spec':
      return <RunDetailEmptyState testId="pane-spec-empty" copy={SPEC_EMPTY_STATES.noSpec} />;
    case 'drafting':
      return <RunDetailEmptyState testId="pane-spec-empty" copy={SPEC_EMPTY_STATES.drafting} />;
    case 'ready':
      return <RunDetailEmptyState testId="pane-spec-empty" copy={SPEC_EMPTY_STATES.ready} />;
    case 'error':
      return (
        <div data-testid="pane-spec-error" className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
          <div className="text-md font-medium text-text">Spec could not be loaded</div>
          <p className="text-sm text-subtext">{spec.message}</p>
        </div>
      );
    case 'loading':
    default:
      return (
        <div data-testid="pane-spec-loading" className="flex h-full items-center justify-center p-6 text-sm text-subtext">
          Loading spec…
        </div>
      );
  }
}
