import type { CreateConversationWithFirstRunResponse, ProjectIssueLookupResponse } from '@autocatalyst/api-contract';
import { ControlPlaneClientError, type ControlPlaneClient } from '@autocatalyst/sdk';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearBearerToken, writeBearerToken } from '../auth/token-store.js';
import { useControlPlaneConnection } from '../client/client-provider.js';
import { ProjectDirectoryProvider } from '../projects/project-directory.js';
import { CONNECTION_PATH, NEW_PROJECT_PATH, projectPath } from '../shell/navigation.js';
import { ISSUE_LOOKUP_DEBOUNCE_MS } from './issue-reference.js';
import { makeCreateRunResponse, makeProject, makeRun } from './run-fixtures.js';
import { createScriptedDetailClient } from './scripted-detail-client.js';
import { StartRunDialog } from './start-run-dialog.js';

vi.mock('../client/client-provider.js', () => ({ useControlPlaneConnection: vi.fn() }));

const project = makeProject({ id: 'alpha', displayName: 'Alpha' });
const alternate = { ...makeProject({ id: 'beta', displayName: 'Beta' }), hostRepository: { ...project.hostRepository, name: 'beta' } };
const closedIssue: ProjectIssueLookupResponse = {
  issue: { number: 5, title: 'A closed issue', url: 'https://example.test/issues/5', labels: ['enhancement', 'backend'], state: 'closed' },
  workKind: { kind: 'enhancement', source: 'label' }
};
const listProjects = vi.fn<ControlPlaneClient['listProjects']>();
const lookup = vi.fn<ControlPlaneClient['lookupProjectIssue']>();
const create = vi.fn<ControlPlaneClient['createConversationWithFirstRun']>();
const onNavigate = vi.fn();
const onCreated = vi.fn();
const onClose = vi.fn();
const mockConnection = vi.mocked(useControlPlaneConnection);
const client: ControlPlaneClient = { ...createScriptedDetailClient().client, listProjects, lookupProjectIssue: lookup,
  createConversationWithFirstRun: create };

function setConnection(authorization: 'unknown' | 'unauthorized', next = client): void {
  mockConnection.mockReturnValue({ client: next, authorization, reportListUnauthorized: vi.fn(), setToken: vi.fn(), clearToken: vi.fn(), createTestClient: () => next });
}

function Harness(): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <ProjectDirectoryProvider>
      <StartRunDialog open={open} onClose={() => { onClose(); setOpen(false); }} onNavigate={onNavigate}
        onCreated={onCreated} returnFocus={() => false} />
    </ProjectDirectoryProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function typedError(status: number, code: string, details: object, message = 'private upstream detail'): ControlPlaneClientError {
  return new ControlPlaneClientError(status, { error: { code, message, details } });
}

function reference(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Issue reference' });
}

function start(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Start run' });
}

function enter(raw: string): void {
  const input = reference();
  fireEvent.change(input, { target: { value: raw } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

async function choose(label: string, option: string): Promise<void> {
  await userEvent.click(screen.getByRole('combobox', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  vi.resetAllMocks();
  writeBearerToken('configured');
  setConnection('unknown');
  listProjects.mockResolvedValue({ projects: [project] });
  lookup.mockResolvedValue(closedIssue);
});

afterEach(() => {
  clearBearerToken();
  vi.useRealTimers();
});

describe('StartRunDialog prerequisites', () => {
  it.each(['absent', 'rejected'])('prioritizes connection recovery when the token is %s', (state) => {
    if (state === 'absent') clearBearerToken();
    else setConnection('unauthorized');
    render(<Harness />);
    expect(screen.getByText('Connect to the control plane')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Issue reference' })).toBeNull();
    expect(screen.queryByRole('button', { name: /retry|start run/iu })).toBeNull();
    expect(listProjects).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open connection settings' }));
    expect(onNavigate).toHaveBeenCalledWith(CONNECTION_PATH, undefined);
  });

  it('shows directory loading, retry, and the add-project destination', async () => {
    const pending = deferred<Awaited<ReturnType<typeof listProjects>>>();
    listProjects.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ projects: [] });
    render(<Harness />);
    expect(screen.getByText('Loading projects…')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    await act(async () => { pending.reject(new Error('unavailable')); });
    fireEvent.click(screen.getByRole('button', { name: 'Retry projects' }));
    await screen.findByText('Add a project to get started');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }));
    expect(onNavigate).toHaveBeenCalledWith(NEW_PROJECT_PATH, true);
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('StartRunDialog lookup lifecycle', () => {
  it('debounces typing; Enter is immediate and does not start a duplicate', async () => {
    vi.useFakeTimers();
    const first = deferred<ProjectIssueLookupResponse>();
    lookup.mockReturnValueOnce(first.promise);
    render(<Harness />);
    await act(async () => {});
    const input = reference();
    expect(input.hasAttribute('disabled')).toBe(false);
    fireEvent.change(input, { target: { value: '5' } });
    await act(async () => { vi.advanceTimersByTime(ISSUE_LOOKUP_DEBOUNCE_MS - 1); });
    expect(lookup).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(lookup).toHaveBeenNthCalledWith(1, project.id, 5);
    expect(screen.getByText('Reading issue…')).toBeDefined();
    expect(start().disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lookup).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: '#6' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(lookup).toHaveBeenNthCalledWith(2, project.id, 6);
    await act(async () => { vi.advanceTimersByTime(ISSUE_LOOKUP_DEBOUNCE_MS); });
    expect(lookup).toHaveBeenCalledTimes(2);
    await act(async () => { first.resolve({ ...closedIssue, issue: { ...closedIssue.issue, title: 'Stale title' } }); });
    expect(screen.queryByText('Stale title')).toBeNull();
    expect(screen.getByText(closedIssue.issue.title)).toBeDefined();
  });

  it('validates blank Enter and rejects a mismatched URL without a lookup', async () => {
    render(<Harness />);
    await screen.findByText(project.displayName);
    expect(screen.queryByText('Enter an issue number, #number or an issue URL.')).toBeNull();
    enter('');
    expect(screen.getByText('Enter an issue number, #number or an issue URL.')).toBeDefined();
    enter('https://github.com/other/repo/issues/5');
    expect(screen.getByText('This issue belongs to a different repository')).toBeDefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('revalidates a retained reference on project change and ignores a late project 404', async () => {
    const first = deferred<ProjectIssueLookupResponse>();
    listProjects.mockResolvedValue({ projects: [project, alternate] });
    lookup.mockReturnValueOnce(first.promise);
    render(<Harness />);
    await screen.findByRole('combobox', { name: 'Project' });
    expect(reference().hasAttribute('disabled')).toBe(true);
    await choose('Project', 'Alpha');
    const { owner, name } = project.hostRepository;
    enter('https://github.com/' + owner + '/' + name + '/issues/5');
    expect(lookup).toHaveBeenCalledWith(project.id, 5);
    await choose('Project', 'Beta');
    expect(screen.getByText('This issue belongs to a different repository')).toBeDefined();
    await act(async () => { first.reject(typedError(404, 'not_found', { resource: 'project' })); });
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('This project is no longer available.')).toBeNull();
    enter('5');
    await screen.findByText(closedIssue.issue.title);
    await choose('Project', 'Alpha');
    expect(screen.queryByText(closedIssue.issue.title)).toBeNull();
    await waitFor(() => expect(lookup).toHaveBeenNthCalledWith(3, project.id, 5));
  });

  it('invalidates a read on client change and resets the form', async () => {
    const pending = deferred<ProjectIssueLookupResponse>();
    lookup.mockReturnValueOnce(pending.promise);
    const { rerender } = render(<Harness />);
    await screen.findByText(project.displayName);
    enter('5');
    setConnection('unknown', { ...client });
    rerender(<Harness />);
    await screen.findByText(project.displayName);
    await act(async () => { pending.resolve(closedIssue); });
    expect(screen.queryByRole('region', { name: 'Issue preview' })).toBeNull();
    expect((reference() as HTMLInputElement).value).toBe('');
  });

  it('never reconciles a late project 404 after closing the dialog', async () => {
    const pending = deferred<ProjectIssueLookupResponse>();
    lookup.mockReturnValueOnce(pending.promise);
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('5');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => { pending.reject(typedError(404, 'not_found', { resource: 'project' })); });
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps project selection on issue 404 and Back clears and focuses the issue box', async () => {
    lookup.mockRejectedValueOnce(typedError(404, 'not_found', { resource: 'issue' }));
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('5');
    const message = await screen.findByText('That issue was not found in this repository');
    expect(reference().getAttribute('aria-describedby')).toContain(message.parentElement?.id);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(start().disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByText('That issue was not found in this repository')).toBeNull();
    expect((reference() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(reference());
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('clears an unavailable project, reconciles, and requires deliberate reselection', async () => {
    const pending = deferred<Awaited<ReturnType<typeof listProjects>>>();
    listProjects.mockResolvedValueOnce({ projects: [project] }).mockReturnValueOnce(pending.promise);
    lookup.mockRejectedValueOnce(typedError(404, 'not_found', { resource: 'project' }));
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('5');
    await screen.findByText('This project is no longer available.');
    expect(screen.queryByText(project.displayName)).toBeNull();
    expect(screen.getByText('Loading projects…')).toBeDefined();
    await act(async () => { pending.resolve({ projects: [alternate] }); });
    expect(reference().hasAttribute('disabled')).toBe(true);
    expect((reference() as HTMLInputElement).value).toBe('5');
    await choose('Project', 'Beta');
    await screen.findByText(closedIssue.issue.title);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenLastCalledWith(alternate.id, 5);
  });

  it.each(['empty', 'available'])('restores focus after Back with an %s reconciled directory', async (directory) => {
    const empty = directory === 'empty';
    listProjects.mockResolvedValueOnce({ projects: [project] }).mockResolvedValueOnce({ projects: empty ? [] : [alternate] });
    lookup.mockRejectedValueOnce(typedError(404, 'not_found', { resource: 'project' }));
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('5');
    await screen.findByText('This project is no longer available.');
    const target = await (empty ?
      screen.findByRole('button', { name: 'Add project' }) :
      screen.findByRole('combobox', { name: 'Project' }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(document.activeElement).toBe(target);
    if (!empty) expect((reference() as HTMLInputElement).value).toBe('');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['tracker_auth_failed', "This project's issue tracker credential was rejected."],
    ['tracker_credential_missing', 'This project is missing an issue tracker credential.'],
    ['tracker_not_configured', 'This project has no issue tracker.']
  ])('offers project settings for %s and hides the upstream envelope', async (trackerCode, message) => {
    lookup.mockRejectedValueOnce(typedError(400, 'intake_routing_error', { trackerCode, other: 'private value' }));
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('#5');
    await screen.findByText(message);
    expect(screen.queryByText(/private/iu)).toBeNull();
    expect(start().disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Open project settings' }));
    expect(onNavigate).toHaveBeenCalledWith(projectPath(project.id), undefined);
  });

  it.each(['tracker_not_configured', 'tracker_credential_missing'])(
    'recognizes the public resolver-only setup failure %s', async (code) => {
      lookup.mockRejectedValueOnce(typedError(400, 'intake_routing_error', { code }));
      render(<Harness />);
      await screen.findByText(project.displayName);
      enter('5');
      await screen.findByRole('button', { name: 'Open project settings' });
      expect(screen.queryByText(/private upstream/iu)).toBeNull();
    }
  );

  it.each([
    new Error('network'),
    typedError(400, 'intake_routing_error', { trackerCode: 'tracker_provider_unavailable' }),
    typedError(400, 'intake_routing_error', { trackerCode: 'future_error' }),
    typedError(404, 'other_code', { resource: 'project' }),
    typedError(404, 'not_found', { resource: 'other' }),
    typedError(500, 'intake_routing_error', { trackerCode: 'tracker_not_configured' })
  ])('retries an ordinary or unrecognized read failure: %s', async (error) => {
    lookup.mockRejectedValueOnce(error);
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('5');
    await screen.findByText('The issue could not be read.');
    expect(screen.queryByText(/private/iu)).toBeNull();
    expect(start().disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(closedIssue.issue.title);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(listProjects).toHaveBeenCalledTimes(1);
  });
});

describe('StartRunDialog confirmation', () => {
  it.each([
    ['no_match', 'No work-kind label matched.'],
    ['ambiguous_labels', 'More than one work-kind label matched.']
  ] as const)('requires a kind for %s', async (reason, message) => {
    lookup.mockResolvedValueOnce({ ...closedIssue, workKind: { kind: null, source: 'none', reason } });
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('  #5  ');
    await screen.findByText('Needs a work kind');
    expect(screen.getByText(message)).toBeDefined();
    expect(start().disabled).toBe(true);
    await choose('Work kind', 'feature');
    expect(start().disabled).toBe(false);
  });

  it('shows a closed issue, guards duplicate create, and retries with the explicit chosen kind and raw body', async () => {
    const pending = deferred<CreateConversationWithFirstRunResponse>();
    const run = makeRun({ projectId: project.id });
    create.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(makeCreateRunResponse(run));
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('  #5  ');
    const preview = await screen.findByRole('region', { name: 'Issue preview' });
    expect(within(preview).getByText('Closed')).toBeDefined();
    expect(within(preview).getByText('backend')).toBeDefined();
    expect(screen.getByRole('combobox', { name: 'Work kind' }).textContent).toBe('enhancement');
    await choose('Work kind', 'chore');
    act(() => { start().click(); start().click(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      projectId: project.id, identity: 'web', topic: { title: closedIssue.issue.title },
      submission: { kind: 'issue_reference', issue: { number: 5 }, workKind: 'chore', body: '  #5  ' }
    });
    expect(start().disabled).toBe(true);
    expect(reference().hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      pending.reject(typedError(409, 'active_run_conflict', { hidden: 'private value' }, 'A run already exists.'));
    });
    expect(screen.getByRole('alert').textContent).toBe('A run already exists.');
    expect(screen.getByRole('region', { name: 'Issue preview' })).toBe(preview);
    expect(screen.getByRole('combobox', { name: 'Work kind' }).textContent).toBe('chore');
    expect(screen.queryByText('private value')).toBeNull();
    await userEvent.click(start());
    expect(create).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith(run);
  });

  it.each([
    new Error('private provider failure'),
    typedError(400, 'intake_routing_error', { code: 'work_kind_unresolved' }),
    typedError(400, 'intake_routing_error', { trackerCode: 'tracker_auth_failed' }),
    typedError(400, 'intake_routing_error', { code: 'tracker_read_failed' })
  ])('uses generic create feedback and sends the unchanged suggestion: %s', async (error) => {
    create.mockRejectedValueOnce(error);
    render(<Harness />);
    await screen.findByText(project.displayName);
    enter('5');
    await screen.findByRole('region', { name: 'Issue preview' });
    fireEvent.click(start());
    expect((await screen.findByRole('alert')).textContent).toBe('The run could not be started.');
    expect(create.mock.calls[0]?.[0].submission).toMatchObject({ workKind: 'enhancement' });
    expect(start().disabled).toBe(false);
  });
});
