/**
 * Token-styled multi-line text input, the textarea sibling of {@link ./input.tsx}.
 *
 * It shares the design-system form-input tokens with `Input` so multi-line fields read the same as
 * single-line ones: a `--color-border` outline on a `--color-background` fill, `--color-text` text,
 * `--color-subtext` placeholder, `--radius-sm`, `--text-sm`, and the `--color-focus` ring on `:focus`
 * (not only `:focus-visible`). This is what the spec-review composer uses so its textarea is
 * near-white in light themes and correct in dark themes instead of a low-contrast grey fill.
 *
 * Unlike `Input` there is no Base UI textarea primitive, so this wraps the native `<textarea>`
 * directly; it is still a `src/ui/` building block that screens compose rather than restyling a raw
 * element.
 */
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';

export interface TextareaProps extends Omit<ComponentPropsWithoutRef<'textarea'>, 'className'> {
  /** Extra utility classes merged after the base classes. */
  readonly className?: string;
  /** Mark the control invalid: red border and `aria-invalid="true"`. */
  readonly error?: boolean;
}

// Mirrors `Input`'s BASE_CLASSES minus the fixed control height (a textarea grows with its rows) and
// with symmetric vertical padding for multi-line text.
const BASE_CLASSES =
  'w-full rounded-sm border bg-background px-2 py-1 ' +
  'text-sm text-text placeholder:text-subtext ' +
  'data-[invalid]:border-red ' +
  'focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-1 focus:ring-offset-background ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

function classes(extra: string | undefined, error: boolean): string {
  return [BASE_CLASSES, error ? 'border-red' : 'border-border', extra]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, error = false, ...rest },
  ref
): ReactNode {
  return (
    <textarea
      ref={ref}
      {...rest}
      className={classes(className, error)}
      {...(error ? { 'aria-invalid': true } : {})}
    />
  );
});
