/**
 * The client-owned tooltip wrapper around Base UI's `Tooltip` parts.
 *
 * Every icon-only button is required to carry a tooltip so its action has an
 * accessible, discoverable label. The wrapper composes onto the trigger element
 * (typically a `Button`) through Base UI's `render` prop, so the trigger stays a
 * real button while gaining tooltip behavior. Styling is token-only.
 *
 * When a keyboard key is supplied the label reads `Label (key)`.
 */
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

/** Compose the visible tooltip text: `label`, or `label (key)` when a key is given. */
export function formatTooltipLabel(label: string, keyHint?: string): string {
  return keyHint !== undefined && keyHint.length > 0 ? `${label} (${keyHint})` : label;
}

export interface TooltipProps {
  /** The tooltip text. */
  readonly label: string;
  /** Optional keyboard key shown as `label (key)`. */
  readonly keyHint?: string;
  /** The trigger element the tooltip is attached to (for example a `Button`). */
  readonly children: ReactElement;
  /** Milliseconds to wait before opening on hover. Defaults to 300. */
  readonly delay?: number;
}

const POPUP_CLASSES =
  'z-50 select-none rounded-sm bg-surface-2 px-2 py-1 text-sm text-text shadow-popover';

export function Tooltip({ label, keyHint, children, delay = 300 }: TooltipProps): ReactNode {
  return (
    <BaseTooltip.Provider delay={delay}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger delay={delay} render={children} />
        <BaseTooltip.Portal>
          <BaseTooltip.Positioner sideOffset={6}>
            <BaseTooltip.Popup className={POPUP_CLASSES}>
              {formatTooltipLabel(label, keyHint)}
            </BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
