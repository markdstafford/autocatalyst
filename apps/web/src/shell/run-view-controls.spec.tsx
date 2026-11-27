import { createControlPlaneClient } from '@autocatalyst/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';

import { AppRoutes } from '../app.js';
import { writeBearerToken } from '../auth/token-store.js';
import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { makeProject, makeRun } from '../runs/run-fixtures.js';
import { createScriptedDetailClient } from '../runs/scripted-detail-client.js';
import { patchPreferences, readPreferenceRecord } from '../theme/preferences.js';
import { ThemeProvider } from '../theme/theme-provider.js';
import { actionTooltipKey } from './action-registry.js';
import { isMacPlatform } from './key-utils.js';

vi.mock('@autocatalyst/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@autocatalyst/sdk')>(),
  createControlPlaneClient: vi.fn()
}));

const project = makeProject({ id: 'fixture', displayName: 'Fixture app' });
const firstProject = makeProject({ id: 'first-project', displayName: 'First project' });
const runs = [makeRun({ id: 'first', projectId: project.id }), makeRun({ id: 'second', projectId: project.id })];
const listRuns = vi.fn(async () => ({ runs }));

beforeEach(() => {
  writeBearerToken('test-token');
  patchPreferences({ detailPaneVisible: false });
  listRuns.mockClear();
  vi.mocked(createControlPlaneClient).mockReturnValue({
    ...createScriptedDetailClient().client,
    listProjects: async () => ({ projects: [firstProject, project] }),
    listRuns
  });
});

function Address(): ReactNode {
  const location = useLocation();
  return <span data-testid="address">{location.pathname + location.search}</span>;
}

function LeaveShell(): ReactNode {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/outside-shell')}>Leave shell</button>;
}

function open(path = '/runs/second') {
  const app = render(
    <ThemeProvider>
      <ControlPlaneClientProvider>
        <MemoryRouter initialEntries={[path]}>
          <Address />
          <LeaveShell />
          <AppRoutes />
        </MemoryRouter>
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
  return { ...app, user: userEvent.setup() };
}

const chipStrip = () => screen.getByRole('region', { name: 'Collection views' });
const chip = (name: string) => within(chipStrip()).getByRole('button', { name });
const sidebar = () => screen.getByRole('navigation', { name: 'Primary' });
const viewLink = (name: string) => within(sidebar()).getByRole('link', { name });
const heading = (name: string) => screen.getByRole('heading', { level: 1, name });
const settings = () => screen.getByRole('button', { name: 'View settings' });
const address = () => screen.getByTestId('address').textContent;
const input = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' });

function expectCurrent(name: string, path: string): void {
  expect(heading(name)).toBeDefined();
  expect([...chipStrip().querySelectorAll('[aria-current="true"]')]).toEqual([chip(name)]);
  expect([...sidebar().querySelectorAll('[aria-current="page"]')]).toEqual([viewLink(name)]);
  expect(address()).toBe(path);
  const grid = screen.getByRole('grid', { name: 'Runs' });
  expect(grid.querySelector('[aria-selected="true"]')?.getAttribute('data-run-id')).toBe('second');
  expect([...grid.querySelectorAll('[data-run-id]')].map((row) => row.getAttribute('data-run-id'))).toEqual(['first', 'second']);
}

it('creates, renames, switches and restores ordered views without changing the scoped selection', async () => {
  const path = '/runs/second?project=fixture';
  const app = open(path);
  const { user } = app;
  await screen.findByTestId('run-row-second');
  expectCurrent('All runs', path);
  expect(within(screen.getByRole('banner')).getByText('Fixture app')).toBeDefined();
  await user.click(chip('Create named view'));
  expect(await screen.findByRole('dialog', { name: 'New view' })).toBeDefined();
  await waitFor(() => expect(document.activeElement).toBe(input()));
  expect(input().value).toBe('');
  await user.keyboard('{Enter}');
  expect(input().getAttribute('aria-invalid')).toBe('true');
  expect(input().getAttribute('aria-describedby')).toContain(screen.getByText('Enter a name.').id);

  await user.type(input(), ' ALL RUNS ');
  await user.keyboard('{Enter}');
  expect(input().value).toBe(' ALL RUNS ');
  expect(screen.getByText('A view with this name already exists.')).toBeDefined();
  await user.clear(input());
  await user.type(input(), ' Review {Enter}');
  await waitFor(() => expectCurrent('Review', path));

  await user.click(settings());
  const item = await screen.findByRole('menuitem', { name: 'Rename view' });
  expect(item.querySelector('kbd')?.textContent).toBe(actionTooltipKey('rename-view', isMacPlatform()));
  await user.click(item);
  await waitFor(() => expect(document.activeElement).toBe(input()));
  expect(input().value).toBe('Review');
  expect([input().selectionStart, input().selectionEnd]).toEqual([0, 6]);
  await user.keyboard('My review{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(settings()));
  expectCurrent('My review', path);
  expect(within(chipStrip()).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent))
    .toEqual(['All runs', 'My review', 'Create named view']);

  await user.click(chip('All runs'));
  expectCurrent('All runs', path);
  await user.click(viewLink('My review'));
  expectCurrent('My review', path);
  await user.keyboard(',');
  expectCurrent('All runs', path);
  await user.keyboard('.');
  expectCurrent('My review', path);
  expect(listRuns).toHaveBeenLastCalledWith({ projectId: project.id, limit: 50 });

  app.unmount();
  open(path);
  await screen.findByTestId('run-row-second');
  expectCurrent('My review', path);
  expect(within(sidebar()).getByRole('group', { name: 'Run views' }).textContent).toBe('All runsMy review');
});

it('targets the context chip, protects the last view, and restores focus for Escape and deletion', async () => {
  const { user } = open();
  const plus = chip('Create named view');
  await screen.findByTestId('run-row-second');
  await user.keyboard('{Shift>}n{/Shift}');
  await screen.findByRole('dialog', { name: 'New view' });
  await user.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(plus));

  await user.click(settings());
  const disabled = await screen.findByRole('menuitem', { name: 'Delete view' });
  expect(disabled.getAttribute('aria-disabled')).toBe('true');
  await user.hover(disabled);
  expect((await screen.findByRole('tooltip')).textContent).toBe('The last view cannot be deleted');
  await user.click(disabled);
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.unhover(disabled);
  await user.keyboard('{ArrowUp}{ArrowDown}');
  await waitFor(() => expect(document.activeElement).toBe(disabled));
  expect((await screen.findByRole('tooltip')).textContent).toBe('The last view cannot be deleted');
  expect(document.activeElement).toBe(disabled);
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.keyboard('{Escape}');
  await user.keyboard('{Shift>}d{/Shift}');
  expect(screen.queryByRole('dialog')).toBeNull();

  await user.keyboard('{Shift>}n{/Shift}');
  await screen.findByRole('dialog', { name: 'New view' });
  await waitFor(() => expect(document.activeElement).toBe(input()));
  await user.keyboard('Review{Enter}');
  await waitFor(() => expectCurrent('Review', '/runs/second'));
  await user.click(chip('All runs'));
  expectCurrent('All runs', '/runs/second');
  const review = chip('Review');
  fireEvent.contextMenu(review);
  const rename = await screen.findByRole('menuitem', { name: 'Rename view' });
  await user.click(rename);
  expect(input().value).toBe('Review');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(review));

  await user.keyboard('{Shift>}{F10}{/Shift}');
  await user.click(await screen.findByRole('menuitem', { name: 'Delete view' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete view' });
  expect(within(dialog).getByText('Delete “Review”?')).toBeDefined();
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
  await user.keyboard('{Escape}');
  await waitFor(() => expect(document.activeElement).toBe(review));

  await user.keyboard('{ContextMenu}');
  await user.click(await screen.findByRole('menuitem', { name: 'Delete view' }));
  const confirm = within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete view' });
  expect(confirm.classList.contains('bg-red')).toBe(true);
  await user.click(confirm);
  await waitFor(() => expect(document.activeElement).toBe(chip('All runs')));
  expectCurrent('All runs', '/runs/second');
  expect(within(chipStrip()).queryByRole('button', { name: 'Review' })).toBeNull();
});

it('renames and deletes by shortcut, keeps Settings free of view controls, and lists all view keys', async () => {
  const { user } = open();
  await screen.findByTestId('run-row-second');
  await user.keyboard('{Shift>}v{/Shift}');
  await waitFor(() => expect(document.activeElement).toBe(input()));
  await user.keyboard('Everything{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(chip('Everything')));
  await user.click(chip('Create named view'));
  await waitFor(() => expect(document.activeElement).toBe(input()));
  await user.keyboard('Review{Enter}');
  await waitFor(() => expectCurrent('Review', '/runs/second'));
  await user.keyboard('{Shift>}d{/Shift}');
  const remove = within(await screen.findByRole('dialog', { name: 'Delete view' }));
  await user.click(remove.getByRole('button', { name: 'Delete view' }));
  await waitFor(() => expectCurrent('Everything', '/runs/second'));
  await user.keyboard('?');
  const help = within(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' }));
  for (const action of ['Create view', 'Rename view', 'Delete view', 'Previous view', 'Next view']) {
    expect(help.getByText(action)).toBeDefined();
  }
  await user.keyboard('{Escape}');
  await user.keyboard(isMacPlatform() ? '{Meta>},{/Meta}' : '{Control>},{/Control}');
  await screen.findByRole('heading', { name: 'Connection', level: 1 });
  expect(screen.queryByRole('region', { name: 'Collection views' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'View settings' })).toBeNull();
  await user.keyboard('{Shift>}n{/Shift}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([
  ['/runs/second?project=fixture', 'Fixture app'],
  ['/runs/second', 'First project']
])('focuses the scoped project or the first link when expanding Projects from %s', async (path, name) => {
  const { user } = open(path);
  const projectLink = await screen.findByRole('link', { name });
  expect(projectLink.getAttribute('aria-current')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
  const projects = screen.getByRole('button', { name: /projects/i });
  projects.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(document.activeElement).toBe(projectLink));
});

it('keeps memory-only view edits across unshelled routes until reload', async () => {
  const unsupported = { version: 7, layers: ['later'] };
  patchPreferences({ runViews: unsupported });
  const { user } = open();
  await screen.findByTestId('run-row-second');
  await user.click(chip('Create named view'));
  await waitFor(() => expect(document.activeElement).toBe(input()));
  await user.keyboard('Temporary{Enter}');
  await waitFor(() => expectCurrent('Temporary', '/runs/second'));
  await user.click(screen.getByRole('button', { name: 'Leave shell' }));
  await user.click(screen.getByRole('link', { name: 'Back to runs' }));
  await screen.findByRole('heading', { level: 1, name: 'Temporary' });
  expect(readPreferenceRecord()['runViews']).toEqual(unsupported);
});

it('keeps modified comma available during text entry without switching views', async () => {
  const { user } = open('/runs/second?project=fixture');
  await screen.findByTestId('run-row-second');
  await user.click(chip('Create named view'));
  await waitFor(() => expect(document.activeElement).toBe(input()));
  await user.keyboard('In progress,.');
  expect(input().value).toBe('In progress,.');
  await user.keyboard(isMacPlatform() ? '{Meta>},{/Meta}' : '{Control>},{/Control}');
  await screen.findByRole('heading', { name: 'Connection', level: 1 });
  await user.keyboard('{Escape}');
  await screen.findByTestId('run-row-second');
  expectCurrent('All runs', '/runs/second?project=fixture');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(readPreferenceRecord()['runViews']).toBeUndefined();
});
