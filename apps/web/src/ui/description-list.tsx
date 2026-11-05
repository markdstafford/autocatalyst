/**
 * DescriptionList and DescriptionItem — **custom** (non-Base-UI) semantic description
 * lists.
 *
 * Base UI has no description-list primitive, so these render the native `dl`/`dt`/`dd`
 * elements directly. A `DescriptionItem` is one label-above-value pair: a `dt` label in
 * `--text-xs`/`--color-subtext` over a `dd` value in `--text-base`/`--color-text`. This
 * is the shared shape behind the run detail Summary fact list, which supplies its own
 * per-value test ids and content.
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
  /** The `dt` label shown above the value. */
  readonly label: string;
  /** The `dd` value content. */
  readonly children: ReactNode;
  /** Extra utility classes merged onto the item container. */
  readonly className?: string;
}

export function DescriptionItem({ label, children, className }: DescriptionItemProps): ReactNode {
  const classes = ['flex flex-col gap-0.5', className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <div className={classes}>
      <dt className="text-xs font-medium text-subtext">{label}</dt>
      <dd className="text-base text-text">{children}</dd>
    </div>
  );
}
