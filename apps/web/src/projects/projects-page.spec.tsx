import type { CreateProjectRequest, Project, UpdateProjectRequest } from '@autocatalyst/api-contract';
import { ControlPlaneClientError, createControlPlaneClient, type ControlPlaneClient } from '@autocatalyst/sdk';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from '../app.js';
import { writeBearerToken } from '../auth/token-store.js';
import { ControlPlaneClientProvider } from '../client/client-provider.js';
import { makeProject } from '../runs/run-fixtures.js';
import { ThemeProvider } from '../theme/theme-provider.js';

vi.mock('@autocatalyst/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@autocatalyst/sdk')>(),
  createControlPlaneClient: vi.fn()
}));

const handle = (character: string): string => `sec_${character.repeat(32)}`;
const ISSUE = { provider: 'github', projectKey: 'DEMO', url: 'https://tracker.test', credentialRef: { id: handle('i'), purpose: 'issue_tracker' as const, label: 'Issue access' } };
const HOST = { provider: 'github', projectKey: 'preserve-me', url: 'https://host.test', credentialRef: { id: handle('h'), purpose: 'code_host' as const, label: 'Host access' } };
const PROJECT = makeProject();
const EDIT = `/settings/projects/${PROJECT.id}`;
const NEW = '/settings/projects/new';

function sdk(initial?: Project) {
  let current = initial;
  const methods = {
    getHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
    listRuns: vi.fn().mockResolvedValue({ runs: [] }),
    listProjects: vi.fn(async () => ({ projects: current === undefined ? [] : [current] })),
    getProject: vi.fn(async (_id: string) => current ?? Promise.reject(new Error('Missing project'))),
    createSecret: vi.fn<ControlPlaneClient['createSecret']>().mockResolvedValue({ handle: handle('a') }),
    createProject: vi.fn(async (request: CreateProjectRequest) => {
      current = {
        ...PROJECT, ...request,
        credentialRefs: request.credentialRefs ?? [],
        issueTrackerSetting: request.issueTrackerSetting ?? null,
        codeHostSetting: request.codeHostSetting ?? null
      };
      return current;
    }),
    updateProject: vi.fn(async (_id: string, patch: UpdateProjectRequest) => {
      current = {
        ...(current ?? PROJECT),
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.issueTrackerSetting !== undefined ? { issueTrackerSetting: patch.issueTrackerSetting } : {}),
        ...(patch.codeHostSetting !== undefined ? { codeHostSetting: patch.codeHostSetting } : {})
      };
      return current;
    })
  };
  vi.mocked(createControlPlaneClient).mockReturnValue(methods as unknown as ControlPlaneClient);
  return methods;
}

function Address(): ReactNode {
  return <span data-testid="address">{useLocation().pathname}</span>;
}

function open(path: string): ReturnType<typeof userEvent.setup> {
  render(
    <ThemeProvider>
      <ControlPlaneClientProvider>
        <MemoryRouter initialEntries={[path]}>
          <Address />
          <AppRoutes />
        </MemoryRouter>
      </ControlPlaneClientProvider>
    </ThemeProvider>
  );
  return userEvent.setup();
}

const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const displayName = () => screen.getByLabelText<HTMLInputElement>('Display name');
const section = (title: string) => within(screen.getByRole('group', { name: title }));
const credential = (title: string) => section(title).getByLabelText<HTMLInputElement>(/^Credential/);
const provider = (label: string) => screen.getByRole<HTMLButtonElement>('combobox', { name: label });
const feedback = () => within(screen.getByRole('main')).getByRole('status');

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, value: string): Promise<void> {
  await user.click(provider(label));
  await user.click(await screen.findByRole('option', { name: value }));
}

async function fillRepository(user: ReturnType<typeof userEvent.setup>, repoUrl = PROJECT.repoUrl): Promise<void> {
  fireEvent.change(displayName(), { target: { value: PROJECT.displayName } });
  fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: repoUrl } });
  fireEvent.change(screen.getByLabelText('Repository owner'), { target: { value: PROJECT.hostRepository.owner } });
  fireEvent.change(screen.getByLabelText('Repository name'), { target: { value: PROJECT.hostRepository.name } });
  await choose(user, 'Repository provider', 'GitHub');
}

function failure(status: number, code: string, details?: unknown): ControlPlaneClientError {
  return new ControlPlaneClientError(status, { error: { code, message: 'never render raw error information', details } });
}

beforeEach(() => { writeBearerToken('test-token'); });

describe('Projects page and editor', () => {
  it('validates HTTPS before writing; creates with both settings explicitly null and preserves Saved at the edit address', async () => {
    const client = sdk();
    const user = open(NEW);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Add project' }));
    for (const title of ['Issue tracker', 'Code host']) {
      expect(provider(`${title} provider`).textContent).toBe('Not configured');
      expect(credential(title).disabled).toBe(true);
      expect(screen.getByLabelText<HTMLInputElement>(`${title} URL`).disabled).toBe(true);
    }
    expect(screen.getByLabelText<HTMLInputElement>('Project key').disabled).toBe(true);
    await fillRepository(user, 'http://github.com/demo/test');
    const url = screen.getByLabelText('Repository URL');
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(url.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Enter a valid HTTPS URL.');
    expect(button('Save').disabled).toBe(true);
    expect(client.createProject).not.toHaveBeenCalled();
    fireEvent.change(url, { target: { value: PROJECT.repoUrl } });
    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toBe('Saved'));
    expect(screen.getByTestId('address').textContent).toBe(EDIT);
    expect(client.getProject).not.toHaveBeenCalled();
    expect(client.createProject).toHaveBeenCalledExactlyOnceWith({
      displayName: PROJECT.displayName, repoUrl: PROJECT.repoUrl, hostRepository: PROJECT.hostRepository,
      issueTrackerSetting: null, codeHostSetting: null
    });
    expect(client.createSecret).not.toHaveBeenCalled();
    await user.click(button('Done'));
    const row = await screen.findByRole('link', { name: /Fixture app.*demo-app/ });
    expect(row.textContent).toContain('Issue tracker: — · Code host: —');
  });

  it('returns to no runs after first-project setup even if directory reconciliation fails', async () => {
    const client = sdk();
    client.listProjects.mockResolvedValueOnce({ projects: [] }).mockRejectedValueOnce(new Error('read failed'));
    const user = open('/runs');
    await screen.findByText('Add a project to get started');
    await user.click(button('Add project'));
    await fillRepository(user);

    const trackerProvider = provider('Issue tracker provider');
    trackerProvider.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('option', { name: 'Not configured' })).toBeDefined();
    await user.keyboard('{Escape}');
    expect(screen.getByTestId('address').textContent).toBe(NEW);
    expect(document.activeElement).toBe(trackerProvider);

    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toBe('Saved'));
    await user.click(button('Back to runs'));
    expect(await screen.findByText('No runs yet')).toBeDefined();
    const project = screen.getByRole('link', { name: PROJECT.displayName });
    await user.click(project);
    expect(screen.getByRole('banner').textContent).toBe(PROJECT.displayName);
    await waitFor(() => expect(client.listRuns).toHaveBeenLastCalledWith({ limit: 50, projectId: PROJECT.id }));
  });

  it('reads a direct edit, handles unavailable records, and never offers a create form in their place', async () => {
    const client = sdk();
    let reject!: (error: unknown) => void;
    client.getProject.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    open(EDIT);
    expect(screen.getByText('Loading project…')).toBeDefined();
    expect(client.getProject).toHaveBeenCalledExactlyOnceWith(PROJECT.id);
    await act(async () => { reject(failure(404, 'not_found')); });
    expect(screen.getByText('Project could not be loaded')).toBeDefined();
    expect(screen.queryByLabelText('Display name')).toBeNull();
  });

  it('renames without rewriting settings; saves a changed setting whole and preserves saved reference labels and the code-host project key', async () => {
    const client = sdk({ ...PROJECT, issueTrackerSetting: ISSUE, codeHostSetting: { ...HOST, provider: 'legacy' } });
    const user = open(EDIT);
    await screen.findByLabelText('Display name');
    expect(button('Save').disabled).toBe(true);
    expect(screen.getByText(PROJECT.repoUrl)).toBeDefined();
    expect(screen.queryByLabelText('Repository URL')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Repository provider' })).toBeNull();
    expect(provider('Code host provider').textContent).toBe('legacy');
    expect(credential('Code host').value).toBe('');
    expect(screen.getByRole('main').textContent?.includes(HOST.credentialRef.id)).toBe(false);
    fireEvent.change(displayName(), { target: { value: 'Renamed' } });
    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toBe('Saved'));
    expect(client.updateProject).toHaveBeenNthCalledWith(1, PROJECT.id, { displayName: 'Renamed' });
    fireEvent.change(screen.getByLabelText('Code host URL'), { target: { value: 'https://new-host.test' } });
    await user.click(button('Save'));
    expect(client.updateProject).toHaveBeenNthCalledWith(2, PROJECT.id, {
      codeHostSetting: { ...HOST, provider: 'legacy', url: 'https://new-host.test' }
    });
    expect(client.createSecret).not.toHaveBeenCalled();
  });

  it.each([
    ['Issue tracker', 'issueTrackerSetting', ISSUE],
    ['Code host', 'codeHostSetting', HOST]
  ] as const)('stages removal of %s only, clears typed values, and restores saved fields on reselect and Cancel', async (title, key, setting) => {
    const client = sdk({ ...PROJECT, [key]: setting });
    const user = open('/settings/projects');
    const row = await screen.findByRole('link', { name: /Fixture app.*demo-app/ });
    await user.click(row);
    await screen.findByLabelText('Display name');
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Edit project' }));
    fireEvent.change(credential(title), { target: { value: 'discard-on-unconfigure' } });

    await choose(user, `${title} provider`, 'Not configured');
    expect(credential(title).disabled && credential(title).value === '').toBe(true);
    const url = screen.getByLabelText<HTMLInputElement>(`${title} URL`);
    expect(url.disabled && url.value === '').toBe(true);
    expect(screen.getByText('Runs cannot read issues or open pull requests for this project.')).toBeDefined();

    await choose(user, `${title} provider`, 'GitHub');
    expect(url.value).toBe(setting.url);
    expect(credential(title).value).toBe('');
    expect(button('Save').disabled).toBe(true);
    await choose(user, `${title} provider`, 'Not configured');

    await user.click(button('Cancel'));
    expect(document.activeElement).toBe(await screen.findByRole('link', { name: /Fixture app.*demo-app/ }));
    await user.click(screen.getByRole('link', { name: /Fixture app.*demo-app/ }));
    await screen.findByLabelText('Display name');
    expect(provider(`${title} provider`).textContent).toBe('GitHub');
    expect(credential(title).value).toBe('');
    fireEvent.change(credential(title), { target: { value: 'not-uploaded' } });
    await choose(user, `${title} provider`, 'Not configured');
    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toBe('Saved'));
    expect(client.updateProject).toHaveBeenCalledExactlyOnceWith(PROJECT.id, { [key]: null });
    expect(client.createSecret).not.toHaveBeenCalled();
  });

  it('serializes uploads and a single write, reusing success across a partial upload failure and selectively retrying a rejected handle', async () => {
    const client = sdk({ ...PROJECT, issueTrackerSetting: ISSUE, codeHostSetting: HOST });
    let confirm!: (response: { handle: string }) => void;
    client.createSecret
      .mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }))
      .mockRejectedValueOnce(new TypeError('transport'))
      .mockResolvedValueOnce({ handle: handle('b') })
      .mockResolvedValueOnce({ handle: handle('c') });
    client.updateProject.mockRejectedValueOnce(failure(422, 'unknown_credential_reference', {
      fields: ['issueTrackerSetting.credentialRef', 'hostRepository.owner', 'credentialRefs[0]']
    }));
    const user = open(EDIT);
    await screen.findByLabelText('Display name');
    const issue = credential('Issue tracker');
    const host = credential('Code host');
    fireEvent.change(issue, { target: { value: ' opaque issue value ' } });
    fireEvent.change(host, { target: { value: 'test code value' } });
    await user.click(button('Save'));
    expect(feedback().textContent).toBe('Saving');
    expect(issue.disabled && host.disabled && button('Cancel').disabled && button('Save').disabled).toBe(true);
    fireEvent.submit(button('Save').closest('form')!);
    expect(client.createSecret).toHaveBeenCalledTimes(1);
    await act(async () => { confirm({ handle: handle('a') }); });
    await waitFor(() => expect(feedback().textContent).toContain('Connection lost'));
    expect(client.updateProject).not.toHaveBeenCalled();
    expect(issue.value).toBe(' opaque issue value ');

    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toContain('a credential was not found'));
    expect(issue.getAttribute('aria-invalid')).toBe('true');
    expect(host.getAttribute('aria-invalid')).not.toBe('true');
    expect(client.createSecret).toHaveBeenCalledTimes(3);
    expect(client.updateProject).toHaveBeenCalledTimes(1);
    expect(client.updateProject).toHaveBeenNthCalledWith(1, PROJECT.id, {
      issueTrackerSetting: { ...ISSUE, credentialRef: { ...ISSUE.credentialRef, id: handle('a'), purpose: 'issue_tracker' } },
      codeHostSetting: { ...HOST, credentialRef: { ...HOST.credentialRef, id: handle('b'), purpose: 'code_host' } }
    });

    fireEvent.change(displayName(), { target: { value: 'A new name' } });
    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toBe('Saved'));
    expect(client.createSecret.mock.calls.map(([request]) => request.value === ' opaque issue value ' ? 'issue' : 'code')).toEqual(['issue', 'code', 'code', 'issue']);
    expect(client.updateProject).toHaveBeenNthCalledWith(2, PROJECT.id, {
      displayName: 'A new name',
      issueTrackerSetting: { ...ISSUE, credentialRef: { ...ISSUE.credentialRef, id: handle('c'), purpose: 'issue_tracker' } },
      codeHostSetting: { ...HOST, credentialRef: { ...HOST.credentialRef, id: handle('b'), purpose: 'code_host' } }
    });
    expect(issue.type === 'password' && issue.autocomplete === 'off' && issue.value === '' && host.value === '').toBe(true);
  });

  it('discards a confirmed upload on input change, while keeping a different section staged', async () => {
    const client = sdk({ ...PROJECT, issueTrackerSetting: ISSUE, codeHostSetting: HOST });
    client.createSecret
      .mockResolvedValueOnce({ handle: handle('a') })
      .mockResolvedValueOnce({ handle: handle('b') })
      .mockResolvedValueOnce({ handle: handle('c') });
    client.updateProject.mockRejectedValueOnce(failure(500, 'unknown'));
    const user = open(EDIT);
    await screen.findByLabelText('Display name');
    fireEvent.change(credential('Issue tracker'), { target: { value: 'first issue draft' } });
    fireEvent.change(credential('Code host'), { target: { value: 'host draft' } });
    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toContain('Failed'));
    fireEvent.change(credential('Issue tracker'), { target: { value: 'changed issue draft' } });
    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toBe('Saved'));
    expect(client.createSecret).toHaveBeenCalledTimes(3);
    expect(client.updateProject).toHaveBeenNthCalledWith(2, PROJECT.id, {
      issueTrackerSetting: { ...ISSUE, credentialRef: { ...ISSUE.credentialRef, id: handle('c'), purpose: 'issue_tracker' } },
      codeHostSetting: { ...HOST, credentialRef: { ...HOST.credentialRef, id: handle('b'), purpose: 'code_host' } }
    });
  });

  it.each([
    [400, 'validation_error', 'Correct the marked fields', 'Display name'],
    [409, 'conflict', 'a project for this repository already exists', 'Repository owner'],
    [400, 'secret_store_locked', 'secret store is locked', undefined],
    [403, 'forbidden', 'access denied', undefined],
    [500, 'unexpected', 'Try saving again', undefined]
  ] as const)('maps %s %s to safe feedback and allows retry', async (status, code, copy, marked) => {
    const client = sdk();
    client.createProject.mockRejectedValueOnce(failure(status, code, {
      issues: [{ path: ['displayName'], message: 'unsafe' }, { path: ['unknown'], message: 'unsafe' }]
    }));
    const user = open(NEW);
    await fillRepository(user);
    await user.click(button('Save'));
    await waitFor(() => expect(feedback().textContent).toContain(copy));
    expect(feedback().textContent?.includes('never render raw')).toBe(false);
    if (marked !== undefined) expect(screen.getByLabelText(marked).getAttribute('aria-invalid')).toBe('true');
    expect(displayName().value).toBe(PROJECT.displayName);
    expect(button('Save').disabled).toBe(false);
  });
});
