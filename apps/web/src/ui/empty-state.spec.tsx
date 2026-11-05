/**
 * EmptyState tests: the title and single message line, the optional primary action,
 * the title-only case, no illustration, and that a forwarded test id reaches the region.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from './empty-state.js';

describe('EmptyState', () => {
  it('renders a centered title and one message line', () => {
    render(<EmptyState data-testid="empty" title="No runs yet" message="A run starts from a tracked issue." />);
    const region = screen.getByTestId('empty');
    expect(region.textContent).toContain('No runs yet');
    expect(region.textContent).toContain('A run starts from a tracked issue.');
    // No illustration (no img/svg).
    expect(region.querySelector('img')).toBeNull();
    expect(region.querySelector('svg')).toBeNull();
  });

  it('renders without a message (title only)', () => {
    render(<EmptyState data-testid="empty" title="No run" />);
    const region = screen.getByTestId('empty');
    expect(region.textContent).toBe('No run');
    expect(region.querySelector('p')).toBeNull();
  });

  it('renders at most one optional action and fires it', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        data-testid="empty"
        title="Add a project to get started"
        message="Projects group runs."
        action={{ label: 'Add project', onClick }}
      />
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
