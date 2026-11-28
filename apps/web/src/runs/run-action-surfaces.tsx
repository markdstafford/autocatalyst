import type { Run } from '@autocatalyst/api-contract';
import { Ellipsis } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Menu } from '../ui/menu.js';
import type { useRunActions } from './use-run-actions.js';

type Actions = ReturnType<typeof useRunActions>;

export function RunActionsMenu({ run, actions, rowTitle }: {
  readonly run: Run;
  readonly actions: Pick<Actions, 'menuItems' | 'openMenu'>;
  readonly rowTitle?: string;
}): ReactNode {
  const label = rowTitle === undefined ? 'Run actions' : `Run actions for ${rowTitle}`;
  return (
    <Menu label={label} triggerTooltip="Run actions" items={actions.menuItems(run)}
      onOpenChange={open => actions.openMenu(run, open)}
      trigger={
        <Button size="control-sm" variant="secondary" aria-label={label}
          className={`aspect-square shrink-0 border-0 bg-transparent px-0 text-subtext hover:bg-hover hover:text-text ${
            rowTitle === undefined ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          }`}>
          <Ellipsis size={14} aria-hidden />
        </Button>
      } />
  );
}

export function RunActionDialogs({ actions }: { readonly actions: Actions }): ReactNode {
  const { dialog, pending, dismiss, submit } = actions;
  const cancelDismiss = useRef<HTMLElement>(null);
  const backDismiss = useRef<HTMLElement>(null);
  // The wrapper needs the captured opener during the closing transition, after
  // the surface has been cleared. Never derive it from the current selection.
  const finalFocus = useRef<() => HTMLElement | false>(() => false);
  if (dialog !== undefined) finalFocus.current = dialog.finalFocus;
  const close = (open: boolean): void => { if (!open) dismiss(); };
  return (
    <>
      <Dialog alert open={dialog?.kind === 'cancel'} onOpenChange={close}
        title="Cancel this run?" description="Canceling ends this run, and it cannot be recovered."
        initialFocus={() => cancelDismiss.current} finalFocus={() => finalFocus.current()}>
        <div className="flex justify-end gap-2">
          <Button ref={cancelDismiss} variant="secondary" onClick={dismiss}>Cancel</Button>
          <Button variant="destructive" disabled={pending} onClick={() => submit()}>Cancel run</Button>
        </div>
      </Dialog>
      <Dialog open={dialog?.kind === 'set-step'} onOpenChange={close}
        title="Move the run back" description="The run repeats from the chosen step. Earlier steps and sessions are kept."
        initialFocus={() => backDismiss.current} finalFocus={() => finalFocus.current()}>
        {dialog?.kind === 'set-step' ? (
          <StepChoices candidates={dialog.candidates} error={dialog.error} pending={pending}
            dismissRef={backDismiss} dismiss={dismiss} submit={submit} />
        ) : null}
      </Dialog>
    </>
  );
}

function StepChoices({ candidates, error, pending, dismissRef, dismiss, submit }: {
  readonly candidates: readonly string[];
  readonly error: string | undefined;
  readonly pending: boolean;
  readonly dismissRef: React.RefObject<HTMLElement | null>;
  dismiss(): void;
  submit(step: string): void;
}): ReactNode {
  const name = useId();
  const [step, setStep] = useState('');
  return (
    <form onSubmit={event => { event.preventDefault(); if (candidates.includes(step)) submit(step); }}>
      <fieldset aria-label="Previously reached steps" className="max-h-60 space-y-1 overflow-auto" disabled={pending}>
        {candidates.map(candidate => (
          <label key={candidate} className="flex items-center gap-2 rounded-sm px-2 py-1 font-mono text-sm hover:bg-hover">
            <input type="radio" name={name} value={candidate} checked={step === candidate}
              className="accent-primary" onChange={() => setStep(candidate)} />
            {candidate}
          </label>
        ))}
      </fieldset>
      {error === undefined ? null : <p role="alert" className="mt-2 text-sm text-red">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button ref={dismissRef} variant="secondary" onClick={dismiss}>Cancel</Button>
        <Button type="submit" disabled={pending || !candidates.includes(step)}>Move back</Button>
      </div>
    </form>
  );
}

export function RunTitleEditor({ title, error, pending, dismiss, submit }: {
  readonly title: string;
  readonly error: string | undefined;
  readonly pending: boolean;
  dismiss(): void;
  submit(title: string): void;
}): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [draft, setDraft] = useState(title);
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <form onSubmit={event => { event.preventDefault(); submit(draft); }}>
      <Input ref={input} aria-label="Run title" aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className="border-primary focus:border-primary" value={draft} loading={pending}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }
        }} />
      {error === undefined ? null : <p id={errorId} role="alert" className="mt-1 text-sm text-red">{error}</p>}
    </form>
  );
}

export function RunActionOutcomeLine({ outcome, undo }: Pick<Actions, 'outcome' | 'undo'>): ReactNode {
  if (outcome === undefined) return null;
  return (
    <div className={`flex items-center gap-2 py-1 text-sm ${outcome.error ? 'text-red' : 'text-subtext'}`}>
      <p data-testid="run-action-outcome" role={outcome.error ? 'alert' : 'status'}>{outcome.message}</p>
      {outcome.undo === undefined ? null : (
        <Button size="control-sm" variant="secondary" onClick={undo}>Undo</Button>
      )}
    </div>
  );
}
