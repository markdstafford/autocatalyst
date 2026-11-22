import { issueWorkKindSchema, type IssueWorkKind, type ProjectIssueLookupResponse, type Run } from '@autocatalyst/api-contract';
import type { ControlPlaneClient } from '@autocatalyst/sdk';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { hasBearerToken } from '../auth/token-store.js';
import { useControlPlaneConnection } from '../client/client-provider.js';
import { useProjectDirectory } from '../projects/project-directory.js';
import { CONNECTION_PATH, NEW_PROJECT_PATH, projectPath } from '../shell/navigation.js';
import { Button } from '../ui/button.js';
import { Chip } from '../ui/chip.js';
import { Dialog } from '../ui/dialog.js';
import { Field } from '../ui/field.js';
import { Input } from '../ui/input.js';
import { Select } from '../ui/select.js';
import { extractIssueReference, ISSUE_LOOKUP_DEBOUNCE_MS } from './issue-reference.js';
import { isRejectedBearer, lookupFailure, startRunFailure, type LookupFailure } from './start-run-errors.js';

const WORK_KINDS = issueWorkKindSchema.options.map((value) => ({ value, label: value }));

interface StartRunDialogProps {
  readonly open: boolean;
  onClose(): void;
  onNavigate(path: string, fromRuns?: boolean): void;
  onCreated(run: Run): void;
  returnFocus(): HTMLElement | false;
}

export function StartRunDialog({ open, onClose, onNavigate, onCreated, returnFocus }: StartRunDialogProps): ReactNode {
  const { client, authorization } = useControlPlaneConnection();
  const connected = hasBearerToken() && authorization !== 'unauthorized';
  const [scope, setScope] = useState({ client, key: 0 });
  if (scope.client !== client) setScope({ client, key: scope.key + 1 });

  const inFlight = useRef(false);
  const [creating, setCreating] = useState(false);
  const dismiss = (): void => { if (!inFlight.current) onClose(); };
  const go = (path: string, fromRuns?: boolean): void => {
    if (!inFlight.current) onNavigate(path, fromRuns);
  };
  const create: ControlPlaneClient['createConversationWithFirstRun'] = async (request) => {
    inFlight.current = true;
    setCreating(true);
    try {
      return await client.createConversationWithFirstRun(request);
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) dismiss(); }}
      title="Start a run" description="Choose a project and enter a tracked issue."
      data-testid="start-run-dialog" finalFocus={returnFocus}>
      {!open ? null : connected ? (
        <IssueForm key={scope.key} client={client} creating={creating} inFlight={inFlight} create={create}
          onCancel={dismiss} onNavigate={go} onCreated={onCreated} />
      ) : (
        <>
          <div role="status" className="space-y-2">
            <h3 className="text-md font-medium text-text">Connect to the control plane</h3>
            <Button disabled={creating} onClick={() => go(CONNECTION_PATH)}>Open connection settings</Button>
          </div>
          <Actions cancel={dismiss} creating={creating} />
        </>
      )}
    </Dialog>
  );
}

interface IssueFormProps {
  readonly client: Pick<ControlPlaneClient, 'lookupProjectIssue'>;
  readonly creating: boolean;
  readonly inFlight: { readonly current: boolean };
  create: ControlPlaneClient['createConversationWithFirstRun'];
  onCancel(): void;
  onNavigate(path: string, fromRuns?: boolean): void;
  onCreated(run: Run): void;
}

function IssueForm({ client, creating, inFlight, create, onCancel, onNavigate, onCreated }: IssueFormProps): ReactNode {
  const { phase, projects, refresh, reconcileUnavailable } = useProjectDirectory();
  const [projectId, setProjectId] = useState('');
  const [raw, setRaw] = useState('');
  const [kind, setKind] = useState<IssueWorkKind | ''>('');
  const [issue, setIssue] = useState<ProjectIssueLookupResponse>();
  const [failure, setFailure] = useState<LookupFailure>();
  const [validation, setValidation] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const [reading, setReading] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const autoSelect = useRef(true);
  const attempt = useRef({ generation: 0, dispatched: false, active: false, stopped: false });
  const project = projects.find((candidate) => candidate.id === projectId);
  const availableProjectId = project?.id;
  const projectTrigger = useRef<HTMLButtonElement>(null);
  const issueInput = useRef<HTMLInputElement>(null);
  const addProject = useRef<HTMLElement>(null);
  const retryProjects = useRef<HTMLElement>(null);
  const focusAfterBack = useRef(false);
  const issueFeedbackId = useId();
  const kindFeedbackId = useId();

  function ready(): boolean {
    return attempt.current.active && !attempt.current.stopped && hasBearerToken() && !inFlight.current;
  }

  function resetAttempt(): void {
    window.clearTimeout(timer.current);
    attempt.current.generation++;
    attempt.current.dispatched = false;
    setIssue(undefined);
    setKind('');
    setFailure(undefined);
    setValidation(undefined);
    setCreateError(undefined);
    setReading(false);
  }

  useLayoutEffect(() => {
    const session = attempt.current;
    session.active = true;
    return () => {
      session.active = false;
      session.generation++;
      session.dispatched = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (phase !== 'ready') return;
    if (autoSelect.current) {
      autoSelect.current = false;
      if (projects.length === 1) setProjectId(projects[0]?.id ?? '');
    }
    if (projectId !== '' && project === undefined) {
      resetAttempt();
      setProjectId('');
    }
  }, [phase, projectId, project, projects]);

  useLayoutEffect(() => {
    if (!focusAfterBack.current) return;
    const target = project === undefined
      ? projectTrigger.current ?? addProject.current ?? retryProjects.current
      : issueInput.current;
    if (target !== null) {
      focusAfterBack.current = false;
      target.focus();
    }
  });

  useEffect(() => {
    if (project === undefined || !ready()) return;
    const reference = extractIssueReference(raw, project.hostRepository);
    setValidation(raw.trim() === '' || 'number' in reference ? undefined : reference.error);
    if (!('number' in reference)) return;
    const generation = attempt.current.generation;
    const scheduled = window.setTimeout(() => {
      if (generation === attempt.current.generation) void lookup(reference.number);
    }, ISSUE_LOOKUP_DEBOUNCE_MS);
    timer.current = scheduled;
    return () => { window.clearTimeout(scheduled); };
    // Repository identity is immutable for a project; a directory refresh alone is not a new input revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, availableProjectId, raw]);

  async function lookup(number: number): Promise<void> {
    if (!ready() || project === undefined || attempt.current.dispatched) return;
    attempt.current.dispatched = true;
    const generation = attempt.current.generation;
    const current = (): boolean => ready() && generation === attempt.current.generation;
    setReading(true);
    try {
      const result = await client.lookupProjectIssue(project.id, number);
      if (!current()) return;
      setIssue(result);
      setKind(result.workKind.kind ?? '');
    } catch (error) {
      if (!current()) return;
      if (isRejectedBearer(error)) {
        attempt.current.stopped = true;
        return;
      }
      const next = lookupFailure(error);
      if (next.action === 'reconcile') {
        resetAttempt();
        autoSelect.current = false;
        setProjectId('');
        reconcileUnavailable(project.id);
      }
      setFailure(next);
    } finally {
      if (current()) setReading(false);
    }
  }

  function lookupNow(): void {
    window.clearTimeout(timer.current);
    if (!ready() || project === undefined) return;
    const reference = extractIssueReference(raw, project.hostRepository);
    if ('error' in reference) setValidation(reference.error);
    else void lookup(reference.number);
  }

  function back(): void {
    if (!ready()) return;
    focusAfterBack.current = true;
    resetAttempt();
    setRaw('');
  }

  async function start(): Promise<void> {
    if (!ready() || project === undefined || issue === undefined || kind === '') return;
    setCreateError(undefined);
    let run: Run;
    try {
      ({ run } = await create({
        projectId: project.id,
        identity: 'web',
        topic: { title: issue.issue.title },
        submission: { kind: 'issue_reference', issue: { number: issue.issue.number }, workKind: kind, body: raw }
      }));
    } catch (error) {
      if (ready()) {
        if (isRejectedBearer(error)) attempt.current.stopped = true;
        else setCreateError(startRunFailure(error));
      }
      return;
    }
    if (ready()) {
      attempt.current.stopped = true;
      onCreated(run);
    }
  }

  const feedback = validation ?? failure?.message;
  const missing = kind === '' && issue?.workKind.kind === null ? issue.workKind.reason : undefined;
  // Keep project-unavailable feedback mounted even when the directory is reloading or empty.
  const showFields = projects.length > 0 && (phase === 'ready' || project !== undefined);
  return (
    <div className="space-y-3">
      {phase === 'loading' ? <p role="status" className="text-sm text-subtext">Loading projects…</p> : null}
      {phase === 'error' ? (
        <div className="space-y-2">
          <p role="status" className="text-sm text-red">Projects could not be loaded.</p>
          <Button ref={retryProjects} disabled={creating} onClick={() => { if (ready()) void refresh(); }}>Retry projects</Button>
        </div>
      ) : null}
      {phase === 'ready' && projects.length === 0 ? (
        <div className="space-y-2">
          <h3 className="text-md font-medium text-text">Add a project to get started</h3>
          <Button ref={addProject} disabled={creating} onClick={() => onNavigate(NEW_PROJECT_PATH, true)}>Add project</Button>
        </div>
      ) : null}
      {showFields ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Select label="Project" placeholder="Choose a project" value={project?.id ?? ''}
              triggerRef={projectTrigger} describedBy={failure?.action === 'reconcile' ? issueFeedbackId : undefined}
              options={projects.map((candidate) => ({ value: candidate.id, label: candidate.displayName }))}
              disabled={creating} onValueChange={(next) => {
                if (!ready() || next === projectId) return;
                resetAttempt();
                setProjectId(next);
              }} />
            <Select label="Work kind" placeholder="Choose a work kind" value={kind} options={WORK_KINDS}
              describedBy={missing !== undefined ? kindFeedbackId : undefined}
              disabled={creating || issue === undefined} onValueChange={(next) => {
                const parsed = issueWorkKindSchema.safeParse(next);
                if (ready() && parsed.success) { setKind(parsed.data); setCreateError(undefined); }
              }} />
          </div>
          <Field label="Issue reference">
            <Input ref={issueInput} value={raw} disabled={creating || project === undefined}
              error={feedback !== undefined} aria-describedby={issueFeedbackId} aria-busy={reading || undefined}
              onChange={(event) => {
                if (!ready()) return;
                resetAttempt();
                setRaw(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                event.preventDefault();
                lookupNow();
              }} />
          </Field>
        </>
      ) : null}
      <div id={issueFeedbackId} role="status" aria-live="polite" className="empty:sr-only">
        {reading ? <p className="text-sm text-subtext">Reading issue…</p> : null}
        {feedback !== undefined ? <p className="text-sm text-red">{feedback}</p> : null}
        {issue !== undefined ? <p className="sr-only">Issue #{issue.issue.number}: {issue.issue.title}</p> : null}
      </div>
      {issue !== undefined ? <IssuePreview result={issue} /> : null}
      {missing !== undefined ? (
        <div id={kindFeedbackId} role="status" className="space-y-1">
          <p className="text-sm font-medium text-text">Needs a work kind</p>
          <p className="text-sm text-subtext">
            {missing === 'no_match' ? 'No work-kind label matched.' : 'More than one work-kind label matched.'}
          </p>
        </div>
      ) : null}
      {issue !== undefined || failure !== undefined ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={creating} onClick={back}>Back</Button>
          {failure?.action === 'retry' ? (
            <Button disabled={creating} onClick={() => {
              if (!ready()) return;
              resetAttempt();
              lookupNow();
            }}>Try again</Button>
          ) : null}
          {failure?.action === 'settings' && project !== undefined ? (
            <Button disabled={creating} onClick={() => onNavigate(projectPath(project.id))}>Open project settings</Button>
          ) : null}
        </div>
      ) : null}
      {createError !== undefined ? <p role="alert" className="text-sm text-red">{createError}</p> : null}
      <Actions cancel={onCancel} creating={creating}
        {...(showFields ? { start: () => { void start(); }, canStart: project !== undefined && issue !== undefined && kind !== '' } : {})} />
    </div>
  );
}

function IssuePreview({ result: { issue } }: { readonly result: ProjectIssueLookupResponse }): ReactNode {
  return (
    <section aria-label="Issue preview" className="space-y-2 rounded-sm border border-border p-3">
      <div className="flex items-center gap-2 text-sm text-subtext">
        #{issue.number}
        <Chip tone="neutral">{issue.state[0]?.toUpperCase()}{issue.state.slice(1)}</Chip>
      </div>
      <p className="break-words text-md font-medium text-text">{issue.title}</p>
      {issue.labels.length > 0 ? (
        <ul aria-label="Issue labels" className="flex flex-wrap gap-1">
          {issue.labels.map((label, index) => <li key={index}><Chip tone="neutral">{label}</Chip></li>)}
        </ul>
      ) : <p className="text-xs text-subtext">No labels</p>}
    </section>
  );
}

function Actions({ cancel, creating, start, canStart }: {
  cancel(): void;
  readonly creating: boolean;
  start?(): void;
  readonly canStart?: boolean;
}): ReactNode {
  return (
    <div className="mt-3 flex justify-end gap-2" data-testid="start-run-actions">
      <Button disabled={creating} onClick={cancel}>Cancel</Button>
      {start !== undefined ? (
        <Button variant="primary" disabled={!canStart || creating} aria-busy={creating || undefined} onClick={start}>Start run</Button>
      ) : null}
    </div>
  );
}
