/**
 * Dialog wrapper tests: it renders its title/content as a role="dialog" when open,
 * stays out of the tree when closed, and reports close through onOpenChange.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from './dialog.js';

describe('Dialog', () => {
  it('renders title and content when open', () => {
    render(
      <Dialog open onOpenChange={vi.fn()} title="Example">
        <p>Body content</p>
      </Dialog>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeDefined();
    expect(screen.getByText('Example')).toBeDefined();
    expect(screen.getByText('Body content')).toBeDefined();
  });

  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} onOpenChange={vi.fn()} title="Example">
        <p>Body content</p>
      </Dialog>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports close on Escape', async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange} title="Example">
        <p>Body content</p>
      </Dialog>
    );
    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
