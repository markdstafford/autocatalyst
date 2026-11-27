import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { Menu } from './menu.js';

it('uses a named menu, displays a key cap, and lets a disabled item explain itself without activating', async () => {
  const user = userEvent.setup();
  const rename = vi.fn();
  const remove = vi.fn();
  render(
    <Menu label="Actions" trigger={<button type="button">Open</button>} items={[
      { label: 'Rename', keys: [[{ key: 'v', shift: true }]], onSelect: rename },
      { label: 'Delete', disabledReason: 'The last view cannot be deleted', onSelect: remove }
    ]} />
  );
  const trigger = screen.getByRole('button', { name: 'Open' });
  trigger.focus();
  await user.keyboard('{Enter}');
  const menu = within(await screen.findByRole('menu', { name: 'Actions' }));
  const first = menu.getByRole('menuitem', { name: 'Rename' });
  expect(first.querySelector('kbd')).not.toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(first));
  await user.keyboard('{ArrowDown}');
  const disabled = menu.getByRole('menuitem', { name: 'Delete' });
  expect(disabled.getAttribute('aria-disabled')).toBe('true');
  await waitFor(() => expect(document.activeElement).toBe(disabled));
  expect(screen.getByRole('tooltip').textContent).toBe('The last view cannot be deleted');
  await user.keyboard('{Enter}');
  expect(remove).not.toHaveBeenCalled();
  expect(rename).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
