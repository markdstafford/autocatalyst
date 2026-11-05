/**
 * StatusChip — the shared run status chip for the run list and the detail pane header.
 *
 * It renders the design-system {@link Chip} for the descriptor from {@link runStateChip},
 * so the list row and the pane header always show the same label and tone for a run. When
 * the run has no `status` it renders nothing; the caller renders its existing dash
 * placeholder instead. `Needs review` is the only filled (primary) chip, preserving the
 * design-system rule that the primary fill means human attention is needed.
 */
import type { Run } from '@autocatalyst/api-contract';
import type { ReactNode } from 'react';

import { Chip } from '../ui/chip.js';
import { runStateChip } from './run-state.js';

export interface StatusChipProps {
  /** The run whose derived state the chip presents. */
  readonly run: Run;
  /** Optional test id forwarded to the rendered chip. */
  readonly 'data-testid'?: string;
}

export function StatusChip({ run, ...rest }: StatusChipProps): ReactNode {
  const chip = runStateChip(run);
  if (chip === null) {
    return null;
  }
  return (
    <Chip tone={chip.tone} {...rest}>
      {chip.label}
    </Chip>
  );
}
