/**
 * Write-only secret field tests: the two label states, `autocomplete="off"`, the
 * password type, the absence of reveal/mask/clear controls, that the field is empty
 * when opened with a stored secret (it never receives the stored value), and that the
 * additive optional `onBlur`/`onKeyDown`/`loading` wiring is forwarded to the input
 * while existing callers can omit it.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { WriteOnlySecretField, secretFieldLabel } from './write-only-secret-field.js';

const STORED_LABEL = 'Bearer token (leave blank to keep existing)';

function Harness({ hasStoredValue }: { hasStoredValue: boolean }): React.ReactNode {
  const [value, setValue] = useState('');
  return (
    <WriteOnlySecretField
      hasStoredValue={hasStoredValue}
      value={value}
      onValueChange={setValue}
    />
  );
}

describe('secretFieldLabel', () => {
  it('uses the plain label with nothing stored', () => {
    expect(secretFieldLabel('Bearer token', false)).toBe('Bearer token');
  });
  it('uses the leave-blank label when a secret is stored', () => {
    expect(secretFieldLabel('Bearer token', true)).toBe(STORED_LABEL);
  });
});

describe('WriteOnlySecretField', () => {
  it('labels "Bearer token" when nothing is stored', () => {
    render(<Harness hasStoredValue={false} />);
    expect(screen.getByLabelText('Bearer token')).toBeDefined();
  });

  it('labels "leave blank to keep existing" when a secret is stored', () => {
    render(<Harness hasStoredValue />);
    expect(screen.getByLabelText(STORED_LABEL)).toBeDefined();
  });

  it('is a password input with autocomplete off and no reveal/mask/clear control', () => {
    const { container } = render(<Harness hasStoredValue />);
    const input = screen.getByLabelText(STORED_LABEL) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    // No extra buttons (reveal, clear, delete) exist in the field.
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('is empty when opened with a stored secret (never receives the stored value)', () => {
    render(<Harness hasStoredValue />);
    const input = screen.getByLabelText(STORED_LABEL) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('forwards optional onKeyDown and onBlur handlers to the input', async () => {
    const onKeyDown = vi.fn();
    const onBlur = vi.fn();
    render(
      <>
        <WriteOnlySecretField
          hasStoredValue={false}
          value=""
          onValueChange={() => {}}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        <button type="button">elsewhere</button>
      </>
    );
    const input = screen.getByLabelText('Bearer token');
    input.focus();
    await userEvent.keyboard('{Enter}');
    expect(onKeyDown).toHaveBeenCalled();
    // Move focus away so the field blurs.
    await userEvent.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(onBlur).toHaveBeenCalled();
  });

  it('forwards optional loading, putting the input in the read-only busy state', () => {
    render(
      <WriteOnlySecretField hasStoredValue={false} value="x" onValueChange={() => {}} loading />
    );
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(input.readOnly).toBe(true);
  });

  it('omits the new wiring without behavior change for existing callers', () => {
    const { container } = render(<Harness hasStoredValue={false} />);
    const input = screen.getByLabelText('Bearer token') as HTMLInputElement;
    expect(input.getAttribute('aria-busy')).toBeNull();
    expect(input.readOnly).toBe(false);
    // Still no extra controls.
    expect(container.querySelectorAll('button').length).toBe(0);
  });
});
