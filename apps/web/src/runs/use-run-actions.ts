import type { Run, RunStep } from '@autocatalyst/api-contract';
import { ControlPlaneClientError, type ControlPlaneClient } from '@autocatalyst/sdk';
import { useLayoutEffect, useMemo, useReducer, useRef } from 'react';

import { actionApplies, getAction, RUN_ACTIONS, type RunActionId } from '../shell/action-registry.js';
import { useActionKeys, type ActionHandlers } from '../shell/use-action-keys.js';
import type { MenuItem } from '../ui/menu.js';
import { runStepCandidates } from './run-action-history.js';
import { runDisplayTitle } from './run-fields.js';
import type { RunListState } from './use-run-list.js';

interface Invocation {
  readonly action: RunActionId;
  readonly runId: string;
  readonly selectionVersion: number;
  readonly opener: HTMLElement | null;
  readonly history?: readonly RunStep[] | undefined;
}

interface Presentation {
  readonly invocation: Invocation;
  readonly surface?: 'cancel' | 'set-step' | 'rename';
  readonly error?: string;
  readonly outcome?: RunActionOutcome;
}

export interface RunActionOutcome {
  readonly message: string;
  readonly error?: boolean;
  readonly undo?: Run;
}

interface MenuHistory {
  readonly id: string;
  open: boolean;
  steps?: readonly RunStep[];
}

interface Owner {
  readonly scope: object;
  active: boolean;
  readonly pending: Set<string>;
  history?: MenuHistory;
  presentation?: Presentation;
  focus?: { readonly invocation: Invocation; readonly onlyIfLost: boolean };
}

interface Options {
  readonly client: ControlPlaneClient;
  readonly list: RunListState;
  readonly selectedRun: Run | undefined;
  readonly selectedSteps: readonly RunStep[] | undefined;
  readonly startRunOpen: boolean;
  revealPane(): void;
  refreshDetail(): void;
  fallbackFocus(): HTMLElement | null;
}

const titleError = (title: string): string | undefined => title.length === 0
  ? 'Enter a run title.'
  : title.length > 200 ? 'Enter a title of 200 characters or fewer.' : undefined;

function failure(error: unknown, action: RunActionId): string {
  if (!(error instanceof ControlPlaneClientError)) return 'The run action could not be completed.';
  const { message, details } = error.response.error;
  const reason = action === 'set-run-step' && details !== null && typeof details === 'object' &&
    'reason' in details && typeof details.reason === 'string' ? details.reason.trim() : '';
  return reason && reason !== message.trim() ? `${message} ${reason}` : message;
}

/** Owns action UI and async lifetimes; list state stays the source of displayed runs. */
export function useRunActions(options: Options) {
  const { client, list } = options;
  const owner = useMemo<Owner>(() => ({
    scope: list.actionScope, active: false, pending: new Set()
  }), [list.actionScope]);
  const latest = useRef(options);
  latest.current = options;
  const [, render] = useReducer((revision: number) => revision + 1, 0);
  useLayoutEffect(() => {
    owner.active = true;
    return () => { owner.active = false; };
  }, [owner]);

  const present = owner.presentation;
  const current = present?.invocation.selectionVersion === list.selectionVersion ? present : undefined;
  const invocation = current?.invocation;
  const outcome = current?.outcome;
  const pending = invocation !== undefined && owner.pending.has(invocation.runId);

  function focusTarget(opener: HTMLElement | null): HTMLElement | null {
    return opener?.isConnected ? opener : latest.current.fallbackFocus();
  }

  useLayoutEffect(() => {
    const ticket = owner.focus;
    if (ticket === undefined) return;
    delete owner.focus;
    const active = document.activeElement;
    const openerLost = ticket.invocation.opener?.isConnected !== true;
    if (isCurrent(ticket.invocation) && (!ticket.onlyIfLost || active === document.body ||
      active === null || (openerLost && active.closest('[role="menu"]') !== null))) {
      focusTarget(ticket.invocation.opener)?.focus({ preventScroll: true });
    }
  });

  function isOwned(): boolean {
    return owner.active && latest.current.list.actionScope === owner.scope;
  }

  function isCurrent(target: Invocation): boolean {
    return isOwned() && owner.presentation?.invocation === target &&
      target.selectionVersion === list.getSelectionVersion();
  }

  function stepsFor(id: string): readonly RunStep[] | undefined {
    if (latest.current.selectedRun?.id === id) return latest.current.selectedSteps;
    return owner.history?.id === id ? owner.history.steps : undefined;
  }

  function context(run: Run, steps = stepsFor(run.id)) {
    return {
      run,
      startRunOpen: latest.current.startRunOpen,
      runActionsBusy: owner.pending.has(run.id),
      hasStepCandidates: runStepCandidates(run, steps).length > 0
    };
  }

  function openMenu(run: Run, open: boolean): void {
    if (!open) {
      if (owner.history?.id === run.id) owner.history.open = false;
      return;
    }
    if (!isOwned()) return;
    const hadHistory = owner.history?.steps !== undefined;
    delete owner.history;
    if (hadHistory) render();
    if (run.status !== 'in_progress' || latest.current.selectedRun?.id === run.id) return;
    const history: MenuHistory = { id: run.id, open: true };
    owner.history = history;
    void client.listRunSteps(run.id).then(({ steps }) => {
      if (isOwned() && owner.history === history && history.open) {
        history.steps = steps;
        render();
      }
    }).catch(() => {
      // Unreadable history leaves the other actions available.
    });
  }

  function start(action: RunActionId, id: string, opener: HTMLElement | null, undo?: Run): void {
    const run = list.findRun(id) ?? undo;
    if (!isOwned() || run === undefined || !actionApplies(getAction(action), context(run))) return;

    if (action === 'rename-run') {
      list.select(id);
      latest.current.revealPane();
    }
    const target: Invocation = {
      action, runId: id, opener, selectionVersion: list.getSelectionVersion(),
      // Keep the confirmed surface stable while a menu closes or history refreshes.
      history: action === 'set-run-step' ? stepsFor(id) : undefined
    };
    const surface = action === 'rename-run' ? 'rename' : action === 'cancel-run' ? 'cancel' :
      action === 'set-run-step' ? 'set-step' : undefined;
    owner.presentation = surface === undefined ? { invocation: target } : { invocation: target, surface };
    render();
    if (surface === undefined) void submit(target, undefined, undo);
  }

  function finish(target: Invocation, result: RunActionOutcome): void {
    if (!isCurrent(target)) return;
    const surface = owner.presentation?.surface;
    if (surface === 'rename' || surface === undefined) {
      owner.focus = { invocation: target, onlyIfLost: surface === undefined };
    }
    owner.presentation = { invocation: target, outcome: result };
    render();
  }

  function setError(target: Invocation, error: string): void {
    if (isCurrent(target) && owner.presentation !== undefined) {
      owner.presentation = { ...owner.presentation, error };
      render();
    }
  }

  async function submit(target: Invocation, value?: string, undo?: Run): Promise<void> {
    const { action, runId } = target;
    if (!isCurrent(target) || owner.pending.has(runId)) return;
    const run = list.findRun(runId) ?? undo;
    const history = stepsFor(runId) ?? target.history;
    if (run === undefined || !actionApplies(getAction(action), context(run, history)) ||
      (action === 'set-run-step' && (value === undefined || !runStepCandidates(run, history).includes(value)))) {
      const message = 'This action is no longer available for this run.';
      if (action === 'set-run-step' || action === 'rename-run') setError(target, message);
      else finish(target, { message, error: true });
      return;
    }
    const title = (value ?? '').trim();
    if (action === 'rename-run') {
      const invalid = titleError(title);
      if (invalid !== undefined) {
        setError(target, invalid);
        return;
      }
    }
    owner.pending.add(runId);
    if (owner.presentation?.error !== undefined) {
      const { error: _error, ...presentation } = owner.presentation;
      owner.presentation = presentation;
    }
    render();

    try {
      let updated: Run;
      let message: string;
      let kind: Parameters<RunListState['applyMutation']>[1] = 'lifecycle';
      switch (action) {
        case 'recover-run': {
          const result = await client.recoverRun(runId);
          updated = result.run;
          message = result.mode === 'resume' ? 'Recovered (resumed)' : 'Recovered (started over)';
          break;
        }
        case 'cancel-run':
          ({ run: updated } = await client.cancelRun(runId));
          message = 'Canceled';
          break;
        case 'archive-run':
          ({ run: updated } = await client.archiveRun(runId));
          message = 'Archived';
          kind = 'membership';
          break;
        case 'unarchive-run':
          ({ run: updated } = await client.unarchiveRun(runId));
          message = 'Unarchived';
          kind = 'membership';
          break;
        case 'rename-run':
          ({ run: updated } = await client.renameRun(runId, { title }));
          message = 'Renamed';
          kind = 'rename';
          break;
        case 'set-run-step':
          ({ run: updated } = await client.setRunStep(runId, { step: value! }));
          message = 'Moved back';
          break;
      }
      if (!isOwned()) return;
      list.applyMutation(updated, kind);
      latest.current.refreshDetail();
      finish(target, { message, ...(action === 'archive-run' ? { undo: updated } : {}) });
    } catch (error: unknown) {
      if (!isOwned()) return;
      const message = failure(error, action);
      const surface = isCurrent(target) ? owner.presentation?.surface : undefined;
      if (surface === 'rename' || surface === 'set-step') setError(target, message);
      else finish(target, { message, error: true });
      if (action === 'cancel-run' && error instanceof ControlPlaneClientError && error.status === 409) {
        const version = list.getRunReadVersion();
        try {
          const fresh = await client.getRun(runId);
          if (isOwned() && fresh.id === runId && list.getRunReadVersion() === version) {
            list.applyMutation(fresh, 'lifecycle');
            latest.current.refreshDetail();
          }
        } catch {
          // Keep the last known run and original conflict message.
        }
      }
    } finally {
      owner.pending.delete(runId);
      if (isOwned()) render();
    }
  }

  function dismiss(): void {
    if (invocation === undefined || !isCurrent(invocation)) return;
    if (current?.surface === 'rename') owner.focus = { invocation, onlyIfLost: false };
    // If already sent, the result may still announce an outcome for this selection.
    owner.presentation = { invocation };
    render();
  }

  function menuItems(run: Run): MenuItem[] {
    const state = context(run);
    return RUN_ACTIONS.filter(action => actionApplies(action, state)).map(action => ({
      label: action.name, keys: action.keys, opensDialog: action.takesFocus === true,
      onSelect: (opener) => start(action.id, run.id, opener)
    }));
  }

  const handlers: ActionHandlers = {};
  for (const action of RUN_ACTIONS) {
    handlers[action.id] = () => {
      const run = latest.current.selectedRun;
      if (run !== undefined) start(action.id, run.id, activeElement());
    };
  }
  useActionKeys(handlers, {
    getState: () => latest.current.selectedRun === undefined ? {} : context(latest.current.selectedRun)
  });

  const targetRun = invocation === undefined ? undefined : list.findRun(invocation.runId);
  return {
    menuItems, openMenu, outcome, dismiss, pending,
    rename: (run: Run, opener: HTMLElement) => start('rename-run', run.id, opener),
    undo: () => {
      if (outcome?.undo !== undefined) start('unarchive-run', outcome.undo.id, activeElement(), outcome.undo);
    },
    dialog: current?.surface === 'cancel' || current?.surface === 'set-step' ? {
      kind: current.surface,
      finalFocus: () => isOwned() && current.invocation.selectionVersion === list.getSelectionVersion()
        ? focusTarget(current.invocation.opener) ?? false : false,
      error: current.error,
      candidates: current.surface === 'set-step' && targetRun !== undefined ?
        runStepCandidates(targetRun, stepsFor(targetRun.id) ?? current.invocation.history) : []
    } : undefined,
    editor: current?.surface === 'rename' && targetRun?.id === options.selectedRun?.id && targetRun !== undefined ? {
      title: runDisplayTitle(targetRun), error: current.error
    } : undefined,
    submit: (value?: string) => {
      if (invocation !== undefined) void submit(invocation, value);
    }
  };
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
}
