/**
 * The client-owned popover wrapper around Base UI's `Popover` parts.
 *
 * App code imports this wrapper and never `@base-ui/react` directly (enforced by the
 * `src/ui/`-only rule and the import-conventions test), the same convention the
 * `Dialog` and `Tooltip` wrappers follow. Styling is token-only. The popover is
 * controlled through `open`/`onOpenChange` and anchored to its `trigger`, which is
 * rendered via Base UI's `render` prop so it stays a real element (e.g. a `Button`).
 * Base UI supplies Escape-to-close, outside-click close, and focus management.
 *
 * `container` portals the popup into a specific element instead of the document body. Use it when the
 * popover opens from inside a focus-trapped modal (the expanded spec overlay): a popup portaled to the
 * body lands outside the dialog's DOM, so the modal layer treats it as inert and swallows pointer
 * clicks; portaling into a container inside the dialog keeps it clickable, not just keyboard-operable.
 */
import { Popover as BasePopover } from '@base-ui/react/popover';
import type { ReactElement, ReactNode } from 'react';

export interface PopoverProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** The trigger element (e.g. a Button); rendered via Base UI's render prop so it stays a real button. */
  readonly trigger: ReactElement;
  /** Popover body. */
  readonly children: ReactNode;
  /** Accessible label for the popup (it has role="dialog"). */
  readonly label?: string;
  /** Positioner side; defaults to 'bottom'. */
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  /** Positioner align; defaults to 'end'. */
  readonly align?: 'start' | 'center' | 'end';
  /** Extra classes merged onto the popup. */
  readonly className?: string;
  /** Portal the popup into this element instead of the document body (e.g. inside a modal overlay). */
  readonly container?: HTMLElement | null;
  /** Optional test id placed on the popup. */
  readonly 'data-testid'?: string;
}

const POPUP_CLASSES =
  'z-50 rounded-sm border border-border bg-mantle p-3 text-sm text-text shadow-popover ' +
  'focus-visible:outline-none';

export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  label,
  side,
  align,
  className,
  container,
  'data-testid': testId
}: PopoverProps): ReactNode {
  return (
    <BasePopover.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal {...(container !== undefined && container !== null ? { container } : {})}>
        <BasePopover.Positioner side={side ?? 'bottom'} align={align ?? 'end'} sideOffset={6}>
          <BasePopover.Popup
            className={`${POPUP_CLASSES} ${className ?? ''}`.trim()}
            aria-label={label}
            data-testid={testId}
          >
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}
