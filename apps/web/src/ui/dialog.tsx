/**
 * The client-owned dialog wrapper around Base UI's `Dialog` parts.
 *
 * App code imports this wrapper and never `@base-ui/react` directly (enforced by the
 * `src/ui/`-only rule and the import-conventions test), the same convention the
 * `Tooltip` and `Button` wrappers follow. Styling is token-only. The dialog is
 * controlled through `open`/`onOpenChange`; Base UI supplies focus trapping and
 * Escape-to-close.
 *
 * Two layouts: the default centered modal, and a full-screen variant
 * (`fullScreen`) that covers the entire viewport — including the footer — for
 * overlays that draw their own chrome.
 */
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { ReactNode } from 'react';

export interface DialogProps {
  readonly open: boolean;
  onOpenChange(open: boolean): void;
  /** Accessible dialog title. */
  readonly title: string;
  /** Optional one-line description under the title. */
  readonly description?: string;
  readonly alert?: boolean;
  readonly children: ReactNode;
  /** Extra utility classes merged onto the popup. */
  readonly className?: string;
  /** Render as a full-viewport overlay (covers the footer) instead of a centered modal. */
  readonly fullScreen?: boolean;
  /** Visually hide the title (keeps it for the accessible name). Use when the overlay draws its own header. */
  readonly titleVisuallyHidden?: boolean;
  /** Override the focus target when the dialog opens. */
  readonly initialFocus?: React.ComponentProps<typeof BaseDialog.Popup>['initialFocus'];
  /** Override the focus target when the dialog closes. */
  readonly finalFocus?: React.ComponentProps<typeof BaseDialog.Popup>['finalFocus'];
  /** Optional test id on the popup. */
  readonly 'data-testid'?: string;
}

const BACKDROP_CLASSES = 'fixed inset-0 z-40 bg-crust/70 transition-opacity duration-enter';
const POPUP_CLASSES =
  'fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 ' +
  'overflow-auto rounded-sm border border-border bg-background p-4 shadow-dialog ' +
  'focus-visible:outline-none';
const FULLSCREEN_POPUP_CLASSES =
  'fixed inset-0 z-50 flex flex-col overflow-auto bg-background focus-visible:outline-none';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  alert = false,
  children,
  className,
  fullScreen = false,
  titleVisuallyHidden = false,
  initialFocus,
  finalFocus,
  'data-testid': testId
}: DialogProps): ReactNode {
  const popupClasses = fullScreen ? FULLSCREEN_POPUP_CLASSES : POPUP_CLASSES;
  const titleClasses = titleVisuallyHidden ? 'sr-only' : 'text-md font-medium text-text';
  const Layer = alert ? AlertDialog : BaseDialog;
  return (
    <Layer.Root open={open} onOpenChange={(next: boolean) => onOpenChange(next)}>
      <Layer.Portal>
        <Layer.Backdrop className={BACKDROP_CLASSES} data-testid={testId === undefined ? undefined : testId + '-backdrop'} />
        <Layer.Popup initialFocus={initialFocus} finalFocus={finalFocus} className={`${popupClasses} ${className ?? ''}`.trim()} data-testid={testId}>
          <Layer.Title className={titleClasses}>{title}</Layer.Title>
          {description !== undefined ? (
            <Layer.Description className="mt-1 text-sm text-subtext">
              {description}
            </Layer.Description>
          ) : null}
          {fullScreen ? (
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          ) : (
            <div className="mt-3">{children}</div>
          )}
        </Layer.Popup>
      </Layer.Portal>
    </Layer.Root>
  );
}
