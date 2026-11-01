/**
 * useShellKeys hook: the settings toggle fires from inside a form field, single-key
 * shortcuts do not, and Escape routes to the close handler.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { useShellKeys, type ShellKeyHandlers } from './use-shell-keys.js';

function Harness(handlers: ShellKeyHandlers): ReactNode {
  useShellKeys(handlers);
  return <input aria-label="field" />;
}

function setup(): ShellKeyHandlers & { input: HTMLElement } {
  const handlers = {
    toggleSidebar: vi.fn(),
    toggleSettings: vi.fn(),
    closeLayer: vi.fn()
  };
  render(<Harness {...handlers} />);
  const input = screen.getByRole('textbox', { name: 'field' });
  input.focus();
  return { ...handlers, input };
}

describe('useShellKeys', () => {
  it('fires the settings toggle from inside a form field', () => {
    const { toggleSettings, input } = setup();
    fireEvent.keyDown(input, { key: ',', ctrlKey: true });
    expect(toggleSettings).toHaveBeenCalledTimes(1);
  });

  it('does not fire the sidebar toggle from inside a form field', () => {
    const { toggleSidebar, input } = setup();
    fireEvent.keyDown(input, { key: '[' });
    expect(toggleSidebar).not.toHaveBeenCalled();
  });

  it('routes Escape to the close handler', () => {
    const { closeLayer, input } = setup();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(closeLayer).toHaveBeenCalledTimes(1);
  });

  it('fires the sidebar toggle for "[" outside text entry', () => {
    const handlers = {
      toggleSidebar: vi.fn(),
      toggleSettings: vi.fn(),
      closeLayer: vi.fn()
    };
    render(<Harness {...handlers} />);
    fireEvent.keyDown(document.body, { key: '[' });
    expect(handlers.toggleSidebar).toHaveBeenCalledTimes(1);
  });
});
