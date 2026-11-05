/**
 * Labelled form field wrapper around Base UI's `Field` parts.
 *
 * A `Field` is a label above a control with an optional hint below (design-system
 * form pattern). Base UI's `Field.Root` context accessibly associates the label
 * with the first Base UI control nested inside it (for example the `Input`
 * wrapper) and wires the control's `aria-describedby` to the hint, so consumers
 * write:
 *
 *   <Field label="Bearer token" hint="…">
 *     <Input type="password" />
 *   </Field>
 *
 * Error and loading follow the design-system "input error" / "input loading" rules:
 *  - `error` is a message string. The field is marked invalid, so Base UI sets
 *    `aria-invalid="true"` on the control and wires the message into the control's
 *    `aria-describedby`; the message renders below the control in `--text-sm` and
 *    `--color-red`, and the control's border turns `--color-red`
 *    (via the `data-invalid` state styled in the `Input` wrapper).
 *  - `loading` is forwarded to the nested control so it reports `aria-busy`, becomes
 *    read-only (not disabled), and shows a trailing spinner.
 *
 * Styling is token-only.
 */
import { Field as BaseField } from '@base-ui/react/field';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

export interface FieldProps {
  /** The visible label text, accessibly associated with the control. */
  readonly label: string;
  /** Optional hint rendered below the control and wired as its description. */
  readonly hint?: string;
  /** Optional error message rendered below the control and wired as its description. */
  readonly error?: string;
  /** When set, forward a busy/read-only loading state to the nested control. */
  readonly loading?: boolean;
  /** The form control, typically the `Input` wrapper. */
  readonly children: ReactNode;
  /** Extra utility classes merged onto the field container. */
  readonly className?: string;
}

const ROOT_CLASSES = 'flex flex-col gap-1';
const LABEL_CLASSES = 'text-sm font-medium text-text';
const HINT_CLASSES = 'text-xs text-subtext';
const ERROR_CLASSES = 'text-sm text-red';

export function Field({
  label,
  hint,
  error,
  loading,
  children,
  className
}: FieldProps): ReactNode {
  const rootClassName = [ROOT_CLASSES, className]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');

  const hasError = typeof error === 'string' && error.length > 0;

  // Forward the loading state to the nested control (the `Input` wrapper) so it reports
  // `aria-busy`, becomes read-only, and shows a spinner. The control owns that behaviour.
  const control =
    loading === true && isValidElement(children)
      ? cloneElement(children as ReactElement<{ loading?: boolean }>, { loading: true })
      : children;

  return (
    <BaseField.Root className={rootClassName} invalid={hasError}>
      <BaseField.Label className={LABEL_CLASSES}>{label}</BaseField.Label>
      {control}
      {hint !== undefined && hint.length > 0 ? (
        <BaseField.Description className={HINT_CLASSES}>{hint}</BaseField.Description>
      ) : null}
      {hasError ? (
        <BaseField.Error className={ERROR_CLASSES} match>
          {error}
        </BaseField.Error>
      ) : null}
    </BaseField.Root>
  );
}
