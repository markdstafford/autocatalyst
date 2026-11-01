/**
 * Footer tests: the five named zones, control placement (sidebar toggle in Left
 * control, disabled detail pane toggle in Right control), toggle activation, and that
 * tooltip key text is sourced from `shell-keys.ts`.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { formatTooltipLabel } from '../ui/tooltip.js';
import { Footer } from './footer.js';
import { isMacPlatform, keyHintFor } from './shell-keys.js';

// A fetch that never resolves keeps the health indicator from updating state during
// these structural tests.
const pendingFetch: typeof globalThis.fetch = () => new Promise(() => {});

function renderFooter(onToggle = vi.fn()): { onToggle: ReturnType<typeof vi.fn> } {
  render(
    <ControlPlaneClientProvider fetch={pendingFetch}>
      <Footer sidebarOpen onToggleSidebar={onToggle} />
    </ControlPlaneClientProvider>
  );
  return { onToggle };
}

const ZONE_NAMES = ['Left control', 'Sidebar', 'List', 'Detail pane', 'Right control'];

describe('Footer', () => {
  it('renders the five named zones as groups', () => {
    renderFooter();
    for (const name of ZONE_NAMES) {
      expect(screen.getByRole('group', { name })).toBeDefined();
    }
  });

  it('places the sidebar toggle in the Left control zone', () => {
    renderFooter();
    const left = screen.getByRole('group', { name: 'Left control' });
    expect(within(left).getByRole('button', { name: 'Toggle sidebar' })).toBeDefined();
  });

  it('places the disabled detail pane toggle in the Right control zone', () => {
    renderFooter();
    const right = screen.getByRole('group', { name: 'Right control' });
    const pane = within(right).getByRole('button', { name: 'Toggle detail pane' });
    expect(pane.getAttribute('aria-disabled')).toBe('true');
  });

  it('activates the sidebar toggle but not the disabled pane toggle', async () => {
    const { onToggle } = renderFooter();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Toggle detail pane' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('sources tooltip key text from shell-keys.ts', async () => {
    renderFooter();
    const isMac = isMacPlatform();
    await userEvent.hover(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(
      await screen.findByText(formatTooltipLabel('Sidebar', keyHintFor('sidebar-toggle', isMac)))
    ).toBeDefined();

    await userEvent.hover(screen.getByRole('button', { name: 'Toggle detail pane' }));
    expect(
      await screen.findByText(formatTooltipLabel('Detail pane', keyHintFor('pane-toggle', isMac)))
    ).toBeDefined();
  });
});
