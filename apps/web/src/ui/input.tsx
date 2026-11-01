/**
 * Token-styled text input wrapper around Base UI's `Input`.
 *
 * Screens import this wrapper and never `@base-ui/react` directly (enforced by the
 * `src/ui/`-only lint restriction and the import-conventions test). Base UI's
 * `Input` auto-wires to a surrounding `Field`, so this wrapper composes cleanly
 * inside the `Field` wrapper for an accessible label/hint association.
 *
 * Styling is token-only, matching the design-system form input: `--height-control-base`
 * tall, `--radius-sm`, a `--color-border` outline on a `--color-background` fill, and
 * `--text-sm`. Inputs show the `--color-focus` ring on `:focus` (not only
 * `:focus-visible`).
 */
import { Input as BaseInput } from '@base-ui/react/input';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';

type BaseInputProps = ComponentPropsWithoutRef<typeof BaseInput>;

export interface InputProps extends Omit<BaseInputProps, 'className'> {
  /** Extra utility classes merged after the base classes. */
  readonly className?: string;
}

const BASE_CLASSES =
  'h-control-base w-full rounded-sm border border-border bg-background px-2 ' +
  'text-sm text-text placeholder:text-subtext ' +
  'focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-1 focus:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

function classes(extra: string | undefined): string {
  return [BASE_CLASSES, extra]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...rest },
  ref
): ReactNode {
  return <BaseInput ref={ref} className={classes(className)} {...rest} />;
});
