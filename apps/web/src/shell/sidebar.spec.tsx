/**
 * Sidebar tests: the primary entries (Runs current on /runs, Settings), the settings
 * variant (a Back button before the `Settings` title and the Connection row, no primary
 * rows), the soft-disabled Back while a Connection check is pending, and that closed
 * content leaves the accessibility tree and tab order via `inert`/`aria-hidden`.
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
  it('shows a Back button then the Connection row, and no stale close button or primary rows', () => {
    renderSidebar({ settings: true, path: '/settings/connection' });
    const connection = screen.getByRole('link', { name: 'Connection' });
    expect(connection.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
    // The old right-aligned close button is gone.
    expect(screen.queryByRole('button', { name: 'Close settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Runs' })).toBeNull();
    for (const absent of ['General', 'Appearance', 'Projects']) {
      expect(screen.queryByRole('link', { name: absent })).toBeNull();
    }
  });

  it('orders the Back button before the Connection row (tab order: Back, then Connection)', () => {
    renderSidebar({ settings: true, path: '/settings/connection' });
    const back = screen.getByRole('button', { name: 'Back' });
    const connection = screen.getByRole('link', { name: 'Connection' });
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(back.compareDocumentPosition(connection) & FOLLOWING).toBeTruthy();
  });

  it('calls onCloseSettings from the Back control when no check is pending', async () => {
    const onCloseSettings = vi.fn();
    renderSidebar({ settings: true, path: '/settings/connection', onCloseSettings });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onCloseSettings).toHaveBeenCalledTimes(1);
  });

  it('soft-disables Back (aria-disabled, still focusable) while a check is pending but still routes activation through the guarded close path', async () => {
    const onCloseSettings = vi.fn();
    renderSidebar({
      settings: true,
      path: '/settings/connection',
      onCloseSettings,
      settingsCheckPending: true
    });
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.getAttribute('aria-disabled')).toBe('true');
    // Soft-disabled, not hard-disabled: it stays focusable (no keyboard trap).
    expect((back as HTMLButtonElement).disabled).toBe(false);
    // Activation still reaches `onCloseSettings`. The button does not decide whether
    // to leave; the shared `closeSettings` guard does (covered in shell-layout tests),
    // so the guard stays the single behavior source.
    await userEvent.click(back);
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
