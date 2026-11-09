/**
 * Textarea wrapper tests: renders an accessible `<textarea>`, carries the shared form-input tokens
 * (so it matches `Input` rather than a low-contrast grey), and supports the error state.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Textarea } from './textarea.js';

describe('Textarea', () => {
  it('renders an accessible textarea', () => {
    render(<Textarea aria-label="Comment" />);
    const el = screen.getByRole('textbox', { name: 'Comment' });
    expect(el.tagName).toBe('TEXTAREA');
  });

  it('applies the shared form-input tokens (background fill, border, text, radius)', () => {
    render(<Textarea aria-label="Comment" />);
    const el = screen.getByRole('textbox', { name: 'Comment' });
    // Same tokens as Input so the control is near-white in light themes, not grey.
    expect(el.className).toContain('bg-background');
    expect(el.className).toContain('border-border');
    expect(el.className).toContain('text-text');
    expect(el.className).toContain('rounded-sm');
    expect(el.className).toContain('focus:ring-focus');
    // It must not fall back to the old surface fill.
    expect(el.className).not.toContain('bg-surface');
  });

  it('marks the control invalid and red-bordered in the error state', () => {
    render(<Textarea aria-label="Comment" error />);
    const el = screen.getByRole('textbox', { name: 'Comment' });
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(el.className).toContain('border-red');
    expect(el.className).not.toContain('border-border');
  });

  it('forwards controlled value and onChange', async () => {
    const onChange = vi.fn();
    function Harness(): React.ReactNode {
      const [value, setValue] = useState('');
      return (
        <Textarea
          aria-label="Comment"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onChange(event.target.value);
          }}
        />
      );
    }
    render(<Harness />);
    await userEvent.type(screen.getByRole('textbox', { name: 'Comment' }), 'hi');
    expect(onChange).toHaveBeenCalled();
    expect((screen.getByRole('textbox', { name: 'Comment' }) as HTMLTextAreaElement).value).toBe('hi');
  });
});
