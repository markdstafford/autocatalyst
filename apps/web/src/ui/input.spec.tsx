/**
 * Input wrapper tests: renders an accessible `<input>`, accepts a password type,
 * carries the token-based classes, and forwards controlled value/onValueChange.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from './input.js';

describe('Input', () => {
  it('renders an accessible input', () => {
    render(<Input aria-label="Name" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.tagName).toBe('INPUT');
  });

  it('accepts a password type', () => {
    render(<Input aria-label="Secret" type="password" />);
    const input = screen.getByLabelText('Secret') as HTMLInputElement;
    expect(input.type).toBe('password');
  });

  it('applies the token-based classes', () => {
    render(<Input aria-label="Name" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.className).toContain('border-border');
    expect(input.className).toContain('bg-background');
    expect(input.className).toContain('h-control-base');
    expect(input.className).toContain('rounded-sm');
  });

  it('marks the control invalid and red-bordered in the error state', () => {
    render(<Input aria-label="Name" error />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.className).toContain('border-red');
    expect(input.className).not.toContain('border-border');
  });

  it('is busy and read-only (not disabled) with a spinner when loading', () => {
    render(<Input aria-label="Name" loading />);
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(false);
    expect(screen.getByTestId('input-spinner')).toBeDefined();
  });

  it('has no aria-invalid, aria-busy, or spinner in the default state', () => {
    render(<Input aria-label="Name" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByTestId('input-spinner')).toBeNull();
  });

  it('forwards controlled value and onValueChange', async () => {
    const onValueChange = vi.fn();
    function Harness(): React.ReactNode {
      const [value, setValue] = useState('');
      return (
        <Input
          aria-label="Name"
          value={value}
          onValueChange={(next) => {
            setValue(next);
            onValueChange(next);
          }}
        />
      );
    }
    render(<Harness />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'ab');
    expect(onValueChange).toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('ab');
  });
});
