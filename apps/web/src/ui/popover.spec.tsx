/**
 * Popover wrapper tests: when open it mounts a role="dialog" popup anchored to its
 * trigger, stays out of the tree when closed, reports close through onOpenChange on
 * Escape, and renders its trigger as a real button. Base UI mounts the popup when
 * `open` is controlled without needing a click, so these assert via `screen`.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Popover } from './popover.js';

describe('Popover', () => {
  it('renders the popup content with role dialog and the label as its accessible name when open', async () => {
    render(
      <Popover
        open
        onOpenChange={vi.fn()}
        trigger={<button>Open</button>}
        label="My popover"
        data-testid="pop"
      >
        <p>Body content</p>
      </Popover>
    );
    const popup = await screen.findByTestId('pop');
    expect(popup).toBeDefined();
    expect(popup.getAttribute('role')).toBe('dialog');
    expect(popup.getAttribute('aria-label')).toBe('My popover');
    expect(screen.getByText('Body content')).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'My popover' })).toBeDefined();
  });

  it('renders nothing when closed', () => {
    render(
      <Popover open={false} onOpenChange={vi.fn()} trigger={<button>Open</button>} label="My popover">
        <p>Body content</p>
      </Popover>
    );
    expect(screen.queryByText('Body content')).toBeNull();
    expect(screen.queryByTestId('pop')).toBeNull();
  });

  it('reports close on Escape', async () => {
    const onOpenChange = vi.fn();
    render(
      <Popover open onOpenChange={onOpenChange} trigger={<button>Open</button>} label="My popover">
        <p>Body content</p>
      </Popover>
    );
    await screen.findByText('Body content');
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders the trigger as a real button', () => {
    render(
      <Popover open={false} onOpenChange={vi.fn()} trigger={<button>Open</button>} label="My popover">
        <p>Body content</p>
      </Popover>
    );
    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toBeDefined();
  });
});
