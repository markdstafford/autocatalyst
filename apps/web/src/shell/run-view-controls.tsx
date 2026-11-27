import { Ellipsis, Plus } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import type { RunView, RunViewsState } from '../runs/run-views.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Field } from '../ui/field.js';
import { Input } from '../ui/input.js';
import { Menu, type MenuItem } from '../ui/menu.js';
import { Tooltip } from '../ui/tooltip.js';
import { getAction, actionTooltipKey } from './action-registry.js';
import { isMacPlatform } from './key-utils.js';

type EditKind = 'create' | 'rename' | 'delete';
type Edit = { readonly kind: EditKind; readonly target?: RunView; readonly opener?: HTMLElement; readonly open: boolean };

export function useRunViewControls(views: RunViewsState, onRunRoute: boolean) {
  const strip = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const [edit, setEdit] = useState<Edit>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  useLayoutEffect(() => {
    if (!onRunRoute) setEdit(undefined);
  }, [onRunRoute]);

  function open(kind: EditKind, target?: RunView, opener?: HTMLElement): void {
    setDraft(kind === 'rename' ? target?.name ?? '' : '');
    setError(undefined);
    setEdit({ kind, open: true, ...(target === undefined ? {} : { target }), ...(opener === undefined ? {} : { opener }) });
  }

  function close(): void {
    setEdit((current) => current === undefined ? undefined : { ...current, open: false });
  }

  function submit(): void {
    if (edit === undefined || !edit.open) return;
    const id = edit.target?.id;
    if (edit.kind === 'delete') {
      if (id !== undefined) views.commands.delete(id);
      close();
      return;
    }
    const error = edit.kind === 'create' ? views.commands.create(draft) : id === undefined ? undefined : views.commands.rename(id, draft);
    if (error === undefined) close();
    else setError(error);
  }

  function returnFocus(): HTMLElement | false {
    const preferred = edit?.kind === 'create' ? plus.current : edit?.opener;
    if (preferred?.isConnected) return preferred;
    return activeChip(strip.current) ?? false;
  }

  function menuItems(target: RunView): readonly MenuItem[] {
    const rename = getAction('rename-view');
    const remove = getAction('delete-view');
    return [
      { label: rename.name, keys: rename.keys, opensDialog: true, onSelect: (opener) => open('rename', target, opener) },
      {
        label: remove.name, keys: remove.keys, opensDialog: true,
        disabledReason: views.views.length === 1 ? 'The last view cannot be deleted' : undefined,
        onSelect: (opener) => open('delete', target, opener)
      }
    ];
  }

  return { strip, plus, edit, draft, setDraft, error, open, close, submit, returnFocus, menuItems };
}

type Controls = ReturnType<typeof useRunViewControls>;

function activeChip(strip: HTMLDivElement | null): HTMLElement | null {
  return strip?.querySelector<HTMLElement>('[aria-current="true"]') ?? null;
}

export function RunViewSettings({ view, controls }: { readonly view: RunView; readonly controls: Controls }): ReactNode {
  return (
    <Menu
      label="View settings"
      triggerTooltip="View settings"
      trigger={
        <Button variant="secondary" size="control-sm" className="ml-auto aspect-square shrink-0 px-0" aria-label="View settings">
          <Ellipsis size={16} aria-hidden />
        </Button>
      }
      items={controls.menuItems(view)}
    />
  );
}

const CHIP = 'flex h-control-sm max-w-48 shrink-0 items-center rounded-full border px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus';
const ACTIVE_CHIP = 'border-transparent bg-primary text-on-primary';
const INACTIVE_CHIP = 'border-border bg-surface text-text hover:bg-surface-1';

export function RunViewChips({ views, controls }: { readonly views: RunViewsState; readonly controls: Controls }): ReactNode {
  const { strip, plus } = controls;
  useLayoutEffect(() => {
    const row = strip.current;
    const chip = activeChip(row);
    if (row === null || chip === null) return;
    revealChip(row, chip);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => revealChip(row, chip));
    observer?.observe(row);
    observer?.observe(chip);
    return () => observer?.disconnect();
  }, [strip, views.activeViewId, views.views]);

  return (
    <div ref={strip} role="region" aria-label="Collection views"
      className="flex h-chip-row shrink-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden px-3 [scrollbar-width:none]">
      {views.views.map((view) => {
        const active = view.id === views.activeViewId;
        return (
          <Menu key={view.id} context label={`Actions for ${view.name}`}
            items={controls.menuItems(view)}
            trigger={
              <button type="button" aria-current={active ? 'true' : undefined}
                className={`${CHIP} ${active ? ACTIVE_CHIP : INACTIVE_CHIP}`}
                onClick={() => views.commands.activate(view.id)}>
                <span className="truncate">{view.name}</span>
              </button>
            }
          />
        );
      })}
      <Tooltip label="Create named view" keyHint={actionTooltipKey('create-view', isMacPlatform())}>
        <button ref={plus} type="button" aria-label="Create named view"
          className={`${CHIP} ${INACTIVE_CHIP}`} onClick={() => controls.open('create')}>
          <Plus size={14} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

/** Do not use scrollIntoView: it can also scroll the page and other ancestors. */
function revealChip(strip: HTMLDivElement, chip: HTMLElement): void {
  const stripLeft = strip.getBoundingClientRect().left + strip.clientLeft;
  const stripRight = stripLeft + strip.clientWidth;
  const { left, right, width } = chip.getBoundingClientRect();
  if (width > strip.clientWidth) {
    // A chip that spans the viewport is already as visible as it can be.
    if (left > stripLeft) strip.scrollLeft += left - stripLeft;
    else if (right < stripRight) strip.scrollLeft += right - stripRight;
  } else if (left < stripLeft) strip.scrollLeft += left - stripLeft;
  else if (right > stripRight) strip.scrollLeft += right - stripRight;
}

export function RunViewDialog({ controls, onRunRoute }: { readonly controls: Controls; readonly onRunRoute: boolean }): ReactNode {
  const field = useRef<HTMLInputElement>(null);
  const cancel: RefObject<HTMLElement | null> = useRef<HTMLElement>(null);
  const { edit, draft, setDraft, error, close, submit, returnFocus } = controls;
  const deleting = edit?.kind === 'delete';
  const renaming = edit?.kind === 'rename';
  return (
    <Dialog
      open={onRunRoute && edit?.open === true}
      onOpenChange={(open) => { if (!open) close(); }}
      title={deleting ? 'Delete view' : renaming ? 'Rename view' : 'New view'}
      {...(deleting ? { description: `Delete “${edit.target?.name ?? ''}”?` } : {})}
      initialFocus={deleting ? cancel : field}
      finalFocus={returnFocus}
    >
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {!deleting ? (
          <Field label="Name" {...(error === undefined ? {} : { error })}>
            <Input ref={field} value={draft} onChange={(event) => setDraft(event.target.value)}
              onFocus={renaming ? (event) => { event.currentTarget.select(); } : undefined} />
          </Field>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button ref={cancel} type="button" variant="secondary" onClick={close}>Cancel</Button>
          <Button type="submit" variant={deleting ? 'destructive' : 'primary'}>
            {deleting ? 'Delete view' : renaming ? 'Rename' : 'Create'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
