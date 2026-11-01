/**
 * Sidebar tests: the primary entries (Runs current on /runs, Settings), the settings
 * variant (Connection + close, no primary rows), and that closed content leaves the
 * accessibility tree and tab order via `inert`/`aria-hidden`.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { Sidebar } from './sidebar.js';

function renderSidebar(
  props: Partial<React.ComponentProps<typeof Sidebar>> & { path?: string } = {}
): void {
  const { path = '/runs', ...rest } = props;
  render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar mode="docked" settings={false} onCloseSettings={vi.fn()} {...rest} />
    </MemoryRouter>
  );
}

describe('Sidebar (primary)', () => {
  it('lists Runs (current on /runs) and Settings, and omits later rows', () => {
    renderSidebar({ path: '/runs' });
    const runs = screen.getByRole('link', { name: 'Runs' });
    expect(runs.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Settings' })).toBeDefined();
    for (const absent of ['To do', 'Pinned', 'Projects', 'General', 'Appearance']) {
      expect(screen.queryByRole('link', { name: absent })).toBeNull();
    }
  });
});

describe('Sidebar (settings)', () => {
  it('shows the Connection row and a close control, and no primary rows', () => {
    renderSidebar({ settings: true, path: '/settings/connection' });
    const connection = screen.getByRole('link', { name: 'Connection' });
    expect(connection.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Close settings' })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Runs' })).toBeNull();
    for (const absent of ['General', 'Appearance', 'Projects']) {
      expect(screen.queryByRole('link', { name: absent })).toBeNull();
    }
  });

  it('calls onCloseSettings from the close control', async () => {
    const onCloseSettings = vi.fn();
    renderSidebar({ settings: true, path: '/settings/connection', onCloseSettings });
    await userEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onCloseSettings).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar (closed)', () => {
  it('removes closed content from the accessibility tree and tab order', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/runs']}>
        <Sidebar mode="hidden" settings={false} onCloseSettings={vi.fn()} />
      </MemoryRouter>
    );
    const nav = container.querySelector('nav[aria-label="Primary"]');
    expect(nav).not.toBeNull();
    expect(nav?.hasAttribute('inert')).toBe(true);
    expect(nav?.getAttribute('aria-hidden')).toBe('true');
    // aria-hidden content is excluded from role queries.
    expect(screen.queryByRole('link', { name: 'Runs' })).toBeNull();
  });
});
