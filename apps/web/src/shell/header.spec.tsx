/**
 * Header rendering: title only on Runs, breadcrumb + title on the second-level
 * Connection route.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { ProjectBreadcrumb } from './navigation.js';
import { Header } from './header.js';

function renderAt(path: string, viewTitle = 'All runs', project?: ProjectBreadcrumb): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Header viewTitle={viewTitle} project={project} />
    </MemoryRouter>
  );
}

describe('Header', () => {
  it('shows the title and no breadcrumb on Runs', () => {
    renderAt('/runs');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { name: 'All runs' })).toBeDefined();
    expect(banner.textContent).not.toContain('/');
  });

  it.each([
    [{ phase: 'ready', name: 'Fixture app' }, 'Fixture app'],
    [{ phase: 'loading' }, 'Loading project…'],
    [{ phase: 'error' }, 'Project unavailable'],
    [{ phase: 'ready' }, 'Project unavailable']
  ] as const)('keeps the view heading with project state %j', (project, breadcrumb) => {
    renderAt('/runs/r1?project=p1', 'My review', project);
    const banner = within(screen.getByRole('banner'));
    expect(banner.getByRole('heading', { name: 'My review' })).toBeDefined();
    expect(banner.getByText(breadcrumb)).toBeDefined();
  });

  it('shows a breadcrumb and title on the second-level Connection route', () => {
    renderAt('/settings/connection');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { name: 'Connection' })).toBeDefined();
    expect(banner.textContent).toContain('Settings');
    expect(banner.textContent).toContain('/');
  });
});
