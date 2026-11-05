/**
 * EmptyState — the **custom** (non-Base-UI) empty-state block.
 *
 * It follows the design-system empty-state pattern: centered in its region, a title in
 * `--text-md`, one explanatory line in `--text-sm` and `--color-subtext`, at most one
 * primary action, and no illustration. The title is a heading (`h2`) so assistive technology
 * keeps the region's name. Copy stays with the caller (for the run detail
 * pane, in `runs/run-detail-empty-states.ts`) so this component holds no wording.
 */
import type { ReactNode } from 'react';

import { Button } from './button.js';

export interface EmptyStateAction {
  /** The action's button label. */
  readonly label: string;
  onClick(): void;
}

export interface EmptyStateProps {
  /** The centered title line (`--text-md`). */
  readonly title: string;
  /** The single explanatory line (`--text-sm`, `--color-subtext`). Optional. */
  readonly message?: string;
  /** An optional single primary action rendered below the message. */
  readonly action?: EmptyStateAction;
  /** Optional test id for the surrounding region. */
  readonly 'data-testid'?: string;
  /** Extra utility classes merged onto the container. */
  readonly className?: string;
}

export function EmptyState({ title, message, action, className, ...rest }: EmptyStateProps): ReactNode {
  const containerClass = [
    'flex h-full flex-col items-center justify-center gap-1 p-6 text-center',
    className
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <div className={containerClass} {...rest}>
      <h2 className="text-md font-medium text-text">{title}</h2>
      {message !== undefined && message.length > 0 ? (
        <p className="text-sm text-subtext" style={{ maxWidth: 'var(--width-reading-column)' }}>
          {message}
        </p>
      ) : null}
      {action !== undefined ? (
        <Button variant="primary" className="mt-2" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
