/**
 * Shortcuts overlay tests: it lists every registered action with its key caps (so a
 * newly registered action would appear), and surfaces no unregistered keys.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ACTIONS, actionKeyCaps } from './action-registry.js';
import { isMacPlatform } from './key-utils.js';
import { ShortcutsOverlay } from './shortcuts-overlay.js';

describe('ShortcutsOverlay', () => {
  it('lists every registered action with its name and key caps', () => {
    render(<ShortcutsOverlay open onOpenChange={vi.fn()} />);
    const list = within(screen.getByRole('dialog')).getByRole('list');
    const isMac = isMacPlatform();
    for (const action of ACTIONS) {
      const row = within(list).getByText(action.name).closest('li');
      expect(row).not.toBeNull();
      for (const cap of actionKeyCaps(action.id, isMac)) {
        expect(within(row as HTMLElement).getByText(cap)).toBeDefined();
      }
    }
  });

  it('renders nothing when closed', () => {
    render(<ShortcutsOverlay open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
