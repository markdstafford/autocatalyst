/**
 * DescriptionList and DescriptionItem — **custom** (non-Base-UI) semantic description
 * lists.
 *
 * Base UI has no description-list primitive, so these render the native `dl`/`dt`/`dd`
 * elements directly. A `DescriptionItem` is one name/value row: a fixed-width `dt` name
 * column (`--width-description-label`, `--text-sm`/`--color-subtext`) beside a `dd` value
 * column (`--text-sm`/`--color-text`) that fills the remaining width, wraps long values,
 * and never overlaps the name column. This is the shared shape behind the run detail
 * Summary fact list — its only caller — which supplies its own per-value test ids and
 * content.
 */
import type { ReactNode } from 'react';

export interface DescriptionListProps {
  readonly children: ReactNode;
  /** Extra utility classes merged onto the `dl`. */
  readonly className?: string;
  /** Optional test id forwarded to the `dl`. */
  readonly 'data-testid'?: string;
}

export function DescriptionList({ children, className, ...rest }: DescriptionListProps): ReactNode {
  const classes = ['flex flex-col gap-3', className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <dl className={classes} {...rest}>
      {children}
    </dl>
  );
}

export interface DescriptionItemProps {
  /** The `dt` name shown in the fixed-width left column. */
  readonly label: string;
  /** The `dd` value content, shown in the wrapping right column. */
  readonly children: ReactNode;
  /** Extra utility classes merged onto the item container. */
  readonly className?: string;
}

export function DescriptionItem({ label, children, className }: DescriptionItemProps): ReactNode {
  const classes = ['flex gap-2', className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <div className={classes}>
      <dt className="shrink-0 text-sm text-subtext" style={{ width: 'var(--width-description-label)' }}>
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words text-sm text-text">{children}</dd>
    </div>
  );
}
