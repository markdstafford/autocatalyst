/**
 * Chip — a small, **custom** (non-Base-UI) non-interactive label.
 *
 * Base UI has no chip/badge primitive, so this is a plain styled `span`, not a wrapper.
 * It is token-only: `--text-xs`, `--radius-sm`, no wrap, and colors drawn from the tone
 * table below. It carries no interaction — a clickable pill (a view chip) is a button,
 * not this component.
 *
 * Tones (see the design system's status and meta patterns):
 * - `neutral`: `--color-border` outline with `--color-text` (the work-kind chip).
 * - `muted`:   `--color-border` outline with `--color-subtext` (the "Working" chip).
 * - `primary`: `--color-primary` fill with `--color-on-primary` (the "Waiting on you"
 *   attention chip; carries weight 500 to match the design-system filled chip).
 * - `green`:   `--color-border` outline with `--color-green` text.
 * - `red`:     `--color-border` outline with `--color-red` text.
 */
import type { ReactNode } from 'react';

export type ChipTone = 'neutral' | 'muted' | 'primary' | 'green' | 'red';

export interface ChipProps {
  /** The tone-to-token mapping. Defaults to `neutral`. */
  readonly tone?: ChipTone;
  readonly children: ReactNode;
  /** Extra utility classes merged after the tone classes. */
  readonly className?: string;
  /** Optional test id forwarded to the rendered element. */
  readonly 'data-testid'?: string;
}

const BASE_CLASSES = 'inline-flex items-center whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs';

export const CHIP_TONE_CLASSES: Readonly<Record<ChipTone, string>> = {
  neutral: 'border border-border text-text',
  muted: 'border border-border text-subtext',
  primary: 'bg-primary font-medium text-on-primary',
  green: 'border border-border text-green',
  red: 'border border-border text-red'
};

export function Chip({ tone = 'neutral', children, className, ...rest }: ChipProps): ReactNode {
  const classes = [BASE_CLASSES, CHIP_TONE_CLASSES[tone], className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
