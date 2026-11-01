/**
 * Write-only secret field (design-system "write-only secret field").
 *
 * A secret — the bearer token today, a project credential later (#142) — is a
 * password input that can *replace* a stored secret but never receives or displays
 * the stored value. The component is handed only `hasStoredValue`, never the secret
 * itself, so the stored secret cannot leak through props, the DOM, or an accessible
 * name.
 *
 * - `autocomplete="off"`, `type="password"`.
 * - Label is `Bearer token` with nothing stored, and
 *   `Bearer token (leave blank to keep existing)` once a secret exists.
 * - No mask, no "stored" badge, no reveal button, no clear/delete control.
 * - The value is controlled by the parent so it can be emptied after a save; the
 *   field is empty every time the form opens.
 */
import type { ReactNode } from 'react';

import { Field } from './field.js';
import { Input } from './input.js';

export interface WriteOnlySecretFieldProps {
  /** Whether a secret is already stored. Drives the label; never the secret itself. */
  readonly hasStoredValue: boolean;
  /** The typed (replacement) value. Empty keeps the stored secret. */
  readonly value: string;
  /** Called with the new typed value. */
  onValueChange(next: string): void;
  /** The secret's name, used to build the label. Defaults to `Bearer token`. */
  readonly secretName?: string;
  /** Optional hint rendered below the control. */
  readonly hint?: string;
  /** Whether the control is required (no stored value and nothing typed). */
  readonly required?: boolean;
  readonly id?: string;
  readonly name?: string;
}

/** Build the write-only label for a secret given whether one is already stored. */
export function secretFieldLabel(secretName: string, hasStoredValue: boolean): string {
  return hasStoredValue ? `${secretName} (leave blank to keep existing)` : secretName;
}

export function WriteOnlySecretField({
  hasStoredValue,
  value,
  onValueChange,
  secretName = 'Bearer token',
  hint,
  required,
  id,
  name
}: WriteOnlySecretFieldProps): ReactNode {
  const label = secretFieldLabel(secretName, hasStoredValue);

  return (
    <Field label={label} hint={hint}>
      <Input
        type="password"
        autoComplete="off"
        value={value}
        onValueChange={(next) => {
          onValueChange(next);
        }}
        {...(required === true && !hasStoredValue ? { required: true } : {})}
        {...(id !== undefined ? { id } : {})}
        {...(name !== undefined ? { name } : {})}
      />
    </Field>
  );
}
