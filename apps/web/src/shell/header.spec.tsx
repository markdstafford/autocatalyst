/**
 * Header rendering: title only on Runs, breadcrumb + title on the second-level
 * Connection route.
 */
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { Header } from './header.js';

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Header />
    </MemoryRouter>
  );
}

describe('Header', () => {
  it('shows the title and no breadcrumb on Runs', () => {
    renderAt('/runs');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { name: 'Runs' })).toBeDefined();
    expect(banner.textContent).not.toContain('/');
  });

  it('shows a breadcrumb and title on the second-level Connection route', () => {
    renderAt('/settings/connection');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { name: 'Connection' })).toBeDefined();
    expect(banner.textContent).toContain('Settings');
    expect(banner.textContent).toContain('/');
  });
});
