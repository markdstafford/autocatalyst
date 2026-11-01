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
