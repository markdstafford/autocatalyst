/**
 * Button wrapper tests: role, accessible name, variant/size/focus-ring classes,
 * and the icon-button soft-disable (`aria-disabled`) that keeps the control
 * focusable and hoverable so an attached tooltip stays available while blocking
 * activation.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './button.js';

describe('Button', () => {
  it('renders a button with its accessible name and children', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.tagName).toBe('BUTTON');
  });

  it('exposes an icon-only accessible name through aria-label', () => {
    render(<Button aria-label="Check connection">icon</Button>);
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeDefined();
  });

  it('applies variant, size, and the focus-visible ring token classes', () => {
    render(
      <Button variant="destructive" size="control-lg">
        Delete
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button.className).toContain('bg-red');
    expect(button.className).toContain('text-on-destructive');
    expect(button.className).toContain('h-control-lg');
    expect(button.className).toContain('ring-focus');
  });

  it('defaults to the primary variant and control-base size', () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button.className).toContain('bg-primary');
    expect(button.className).toContain('h-control-base');
  });

  it('fires onClick when enabled', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('soft-disables with aria-disabled: focusable, not natively disabled, no activation', async () => {
    const onClick = vi.fn();
    render(
      <Button aria-label="Check connection" aria-disabled onClick={onClick}>
        icon
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Check connection' });

    // aria-disabled is set, but the native disabled attribute is not, so the
    // element remains focusable and hoverable (keeping any tooltip available).
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(false);

    button.focus();
    expect(document.activeElement).toBe(button);

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('with activateWhenAriaDisabled, still fires onClick while aria-disabled (handler is the guard)', async () => {
    const onClick = vi.fn();
    render(
      <Button aria-label="Back" aria-disabled activateWhenAriaDisabled onClick={onClick}>
        icon
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Back' });
    // Still soft-disabled in appearance and ARIA, not natively disabled.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(false);
    // ...but activation flows through so the handler can decide.
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when natively disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Run
      </Button>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
