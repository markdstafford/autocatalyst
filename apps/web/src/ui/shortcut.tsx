/**
 * Kbd, Shortcut, and ShortcutList — **custom** (non-Base-UI) keyboard display components.
 *
 * - `Kbd` renders one key cap with the design-system cap styling (`--font-mono`,
 *   `--text-xs`, `--color-subtext`, `--color-surface` fill, `--color-border` outline).
 * - `Shortcut` renders one binding: a combo is one cap; a sequence is a cap per step
 *   separated by a small "then", with an accessible name such as "g then r".
 * - `ShortcutList` renders alternate bindings separated by "or" and honours a `limit`
 *   so a tooltip or menu can show just the first binding while the overlay shows all.
 *
 * Every component takes a `platform` so the gallery can show macOS and non-macOS caps
 * side by side without touching the real platform.
 */
import { Fragment, type ReactNode } from 'react';

import { formatChord, type Binding } from '../shell/key-utils.js';

export type ShortcutPlatform = 'mac' | 'other';

const CAP_CLASSES =
  'inline-flex min-w-5 items-center justify-center rounded-sm border border-border bg-surface ' +
  'px-1.5 py-0.5 font-mono text-xs text-subtext';

const SEPARATOR_CLASSES = 'px-0.5 text-xs text-subtext';

export interface KbdProps {
  readonly children: ReactNode;
  readonly className?: string;
  /** Hide from the accessibility tree (the parent `Shortcut` supplies the name). */
  readonly 'aria-hidden'?: boolean;
}

export function Kbd({ children, className, ...rest }: KbdProps): ReactNode {
  const classes = [CAP_CLASSES, className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <kbd className={classes} {...rest}>
      {children}
    </kbd>
  );
}

export interface ShortcutProps {
  /** The binding to display (a combo or a sequence). */
  readonly binding: Binding;
  readonly platform: ShortcutPlatform;
  readonly className?: string;
}

/** The accessible name for a binding, e.g. `g then r` or `⌘,`. */
export function bindingAccessibleName(binding: Binding, platform: ShortcutPlatform): string {
  return binding.map((chord) => formatChord(chord, platform === 'mac')).join(' then ');
}

export function Shortcut({ binding, platform, className }: ShortcutProps): ReactNode {
  const isMac = platform === 'mac';
  const caps = binding.map((chord) => formatChord(chord, isMac));
  const classes = ['inline-flex items-center gap-1', className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <span className={classes} aria-label={bindingAccessibleName(binding, platform)}>
      {caps.map((cap, index) => (
        <Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden className={SEPARATOR_CLASSES}>
              then
            </span>
          ) : null}
          <Kbd aria-hidden>{cap}</Kbd>
        </Fragment>
      ))}
    </span>
  );
}

export interface ShortcutListProps {
  /** The alternate bindings for one action. */
  readonly bindings: readonly Binding[];
  readonly platform: ShortcutPlatform;
  /** Show at most this many alternates (tooltips/menus pass `1`); default shows all. */
  readonly limit?: number;
  readonly className?: string;
}

export function ShortcutList({ bindings, platform, limit, className }: ShortcutListProps): ReactNode {
  const shown = limit !== undefined ? bindings.slice(0, limit) : bindings;
  const classes = ['inline-flex items-center gap-1', className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
  return (
    <span className={classes}>
      {shown.map((binding, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className={SEPARATOR_CLASSES}>or</span> : null}
          <Shortcut binding={binding} platform={platform} />
        </Fragment>
      ))}
    </span>
  );
}
