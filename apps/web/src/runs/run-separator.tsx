/**
 * The vertical resize separator between the run list and the side detail pane.
 *
 * It is a focusable `role="separator"` with `aria-orientation="vertical"`. Arrow keys
 * resize by {@link RESIZE_STEP_PX} (16 px); pointer drag resizes continuously. The
 * pane sits to the right, so moving the handle left (ArrowLeft / dragging left) widens
 * the pane. The caller clamps and persists the width, so this component only reports
 * the requested next width.
 *
 * Colors follow the design system: `--color-border-subtle` at rest, `--color-primary`
 * on hover, focus, and during a drag. Hover/focus/drag are tracked in state so the one
 * `backgroundColor` is driven deterministically rather than relying on a utility for a
 * derived token.
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

/** Keyboard resize step, per the design system. */
export const RESIZE_STEP_PX = 16;

export interface RunSeparatorProps {
  /** Current pane width in px (the value arrow/drag deltas are applied to). */
  readonly widthPx: number;
  /** Minimum pane width, for the ARIA value range. */
  readonly minPx: number;
  /** Maximum pane width, for the ARIA value range. */
  readonly maxPx: number;
  /** Report a requested next width; the caller clamps and persists it. */
  onResize(nextWidthPx: number): void;
}

export function RunSeparator({ widthPx, minPx, maxPx, onResize }: RunSeparatorProps): ReactNode {
  const [active, setActive] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onResize(widthPx + RESIZE_STEP_PX);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onResize(widthPx - RESIZE_STEP_PX);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    // Primary button only.
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: widthPx };
    setActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    // Dragging left (negative delta) widens the right-hand pane.
    const next = drag.startWidth + (drag.startX - event.clientX);
    onResize(next);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>): void {
    if (dragRef.current === null) {
      return;
    }
    dragRef.current = null;
    setActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize detail pane"
      aria-valuenow={Math.round(widthPx)}
      aria-valuemin={minPx}
      aria-valuemax={maxPx}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onFocus={() => {
        setActive(true);
      }}
      onBlur={() => {
        if (dragRef.current === null) {
          setActive(false);
        }
      }}
      onMouseEnter={() => {
        setActive(true);
      }}
      onMouseLeave={() => {
        if (dragRef.current === null) {
          setActive(false);
        }
      }}
      className={`w-resize-handle shrink-0 cursor-col-resize select-none focus:outline-none ${
        active ? 'bg-primary' : ''
      }`}
      {...(active ? {} : { style: { backgroundColor: 'var(--color-border-subtle)' } })}
    />
  );
}
