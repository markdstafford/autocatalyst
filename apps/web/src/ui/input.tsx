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
 *
 * Two optional states follow the design-system "input error" and "input loading"
 * rules:
 *  - `error` marks the control invalid: the border uses `--color-red` and the control
 *    reports `aria-invalid="true"`. A `Field` with an `error` message also lights this
 *    border through Base UI's `data-invalid` state.
 *  - `loading` reports `aria-busy="true"`, makes the control **read-only** (not
 *    disabled, so it stays focusable), and shows a small spinner at the trailing edge.
 *    The spinner does not animate when `prefers-reduced-motion` is set.
 */
import { Input as BaseInput } from '@base-ui/react/input';
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';

type BaseInputProps = ComponentPropsWithoutRef<typeof BaseInput>;

export interface InputProps extends Omit<BaseInputProps, 'className'> {
  /** Extra utility classes merged after the base classes. */
  readonly className?: string;
  /** Mark the control invalid: red border and `aria-invalid="true"`. */
  readonly error?: boolean;
  /** Mark the control busy: `aria-busy`, read-only, and a trailing spinner. */
  readonly loading?: boolean;
}

// `border-border` / `border-red` are chosen explicitly below (never both), and
// `data-[invalid]:border-red` lets a surrounding invalid `Field` light the border too.
const BASE_CLASSES =
  'h-control-base w-full rounded-sm border bg-background px-2 ' +
  'text-sm text-text placeholder:text-subtext ' +
  'data-[invalid]:border-red ' +
  'focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-1 focus:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

function classes(extra: string | undefined, error: boolean, loading: boolean): string {
  return [
    BASE_CLASSES,
    error ? 'border-red' : 'border-border',
    loading ? 'pr-7' : undefined,
    extra
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

/** A small token-styled spinner; no animation under `prefers-reduced-motion`. */
function Spinner(): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-testid="input-spinner"
      className={
        'pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 rounded-full ' +
        'border-2 border-border border-t-transparent motion-safe:animate-spin'
      }
    />
  );
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, error = false, loading = false, readOnly, ...rest },
  ref
): ReactNode {
  // The wrapper span is always present so toggling `loading` never changes the
  // element type at this position: React keeps the same `<input>` DOM node, so a
  // focused control (e.g. the Connection token field entering its checking state)
  // keeps focus instead of being remounted. The spinner is the only conditional part.
  return (
    <span className="relative block w-full">
      <BaseInput
        ref={ref}
        {...rest}
        className={classes(className, error, loading)}
        readOnly={loading ? true : readOnly}
        {...(error ? { 'aria-invalid': true } : {})}
        {...(loading ? { 'aria-busy': true } : {})}
      />
      {loading ? <Spinner /> : null}
    </span>
  );
});
