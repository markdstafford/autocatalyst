/** Token-styled wrapper for Base UI Menu and Context Menu. */
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu as BaseMenu } from '@base-ui/react/menu';
import { useCallback, useRef, useState, type ReactElement, type ReactNode } from 'react';

import { isMacPlatform, type Binding } from '../shell/key-utils.js';
import { ShortcutList } from './shortcut.js';
import { Tooltip } from './tooltip.js';

export interface MenuItem {
  readonly label: string;
  readonly keys?: readonly Binding[];
  readonly disabledReason?: string | undefined;
  /** Skip menu focus restoration when another surface takes ownership of focus. */
  readonly opensDialog?: boolean;
  onSelect(trigger: HTMLElement): void;
}

interface MenuProps {
  readonly label: string;
  readonly trigger: ReactElement;
  readonly triggerTooltip?: string;
  readonly context?: boolean;
  readonly items: readonly MenuItem[];
  onOpenChange?(open: boolean): void;
}

const POPUP_CLASSES = 'z-50 min-w-40 rounded-sm border border-border bg-mantle p-1 shadow-popover outline-none';
const ITEM_CLASSES = 'relative flex h-control-sm cursor-default items-center justify-between gap-4 rounded-sm px-2 text-sm text-text outline-none data-highlighted:bg-surface aria-disabled:text-subtext';

export function Menu({ label, trigger, triggerTooltip, context = false, items, onOpenChange }: MenuProps): ReactNode {
  const opener = useRef<HTMLElement>(null);
  const rememberOpener = useCallback((element: HTMLElement | null): void => {
    opener.current = element;
  }, []);
  const handingOffFocus = useRef(false);
  const platform = isMacPlatform() ? 'mac' : 'other';
  const Positioner = context ? ContextMenu.Positioner : BaseMenu.Positioner;
  const popup = (
    <BaseMenu.Portal>
      <Positioner {...(context ? {} : { align: 'end', sideOffset: 4 })} className="z-50">
        <BaseMenu.Popup
          aria-label={label}
          className={POPUP_CLASSES}
          finalFocus={() => handingOffFocus.current ? false : opener.current ?? true}
        >
          {items.map((item) => (
            <ActionItem key={item.label} item={item} platform={platform}
              onSelect={() => {
                if (opener.current === null) return;
                handingOffFocus.current = item.opensDialog === true;
                item.onSelect(opener.current);
              }}
            />
          ))}
        </BaseMenu.Popup>
      </Positioner>
    </BaseMenu.Portal>
  );
  const handleOpenChange = (open: boolean): void => {
    if (open) handingOffFocus.current = false;
    onOpenChange?.(open);
  };
  if (context) {
    return (
      <ContextMenu.Root onOpenChange={handleOpenChange}>
        <ContextMenu.Trigger
          render={trigger}
          ref={rememberOpener}
          aria-haspopup="menu"
          onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
            event.preventDefault();
            event.stopPropagation();
            // The primitive consumes contextmenu events. For the keyboard gesture,
            // anchor the same event at the focused trigger instead of the cursor.
            const { left, bottom } = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true, cancelable: true, clientX: left, clientY: bottom
            }));
          }}
        />
        {popup}
      </ContextMenu.Root>
    );
  }
  const button = <BaseMenu.Trigger render={trigger} ref={rememberOpener} />;
  return (
    <BaseMenu.Root onOpenChange={handleOpenChange}>
      {triggerTooltip === undefined ? button : <Tooltip label={triggerTooltip}>{button}</Tooltip>}
      {popup}
    </BaseMenu.Root>
  );
}

function ActionItem({ item, platform, onSelect }: {
  readonly item: MenuItem;
  readonly platform: 'mac' | 'other';
  onSelect(): void;
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const unavailable = item.disabledReason !== undefined;
  return (
    <BaseMenu.Item
      label={item.label}
      aria-label={item.label}
      aria-disabled={unavailable || undefined}
      aria-description={item.disabledReason}
      closeOnClick={!unavailable}
      className={ITEM_CLASSES}
      onMouseEnter={unavailable ? () => setHovered(true) : undefined}
      onMouseLeave={unavailable ? () => setHovered(false) : undefined}
      onFocus={unavailable ? () => setFocused(true) : undefined}
      onBlur={unavailable ? () => setFocused(false) : undefined}
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault();
          return;
        }
        onSelect();
      }}
    >
      {item.label}
      {item.keys === undefined ? null : (
        <span aria-hidden><ShortcutList bindings={item.keys} platform={platform} limit={1} /></span>
      )}
      {unavailable ? (
        // Keep the tooltip in this layer's DOM and out of its focus order.
        // A nested floating layer can interfere with the menu's roving focus.
        <span role="tooltip" hidden={!hovered && !focused}
          className="pointer-events-none absolute bottom-full right-0 z-10 w-max max-w-full rounded-sm bg-surface-2 px-2 py-1 text-xs text-text shadow-popover">
          {item.disabledReason}
        </span>
      ) : null}
    </BaseMenu.Item>
  );
}
