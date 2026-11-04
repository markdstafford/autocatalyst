/**
 * ResizeHandle — the client-owned resize separator between two panes.
 *
 * This is a **custom** `ui/` component, not a Base UI wrapper: Base UI has no
 * resizable-panel primitive, and the behavior is small and already lived in custom
 * code (the former `runs/run-separator.tsx`). It is a focusable `role="separator"`
 * with a matching `aria-orientation` and `aria-valuenow`/`aria-valuemin`/
 * `aria-valuemax`. Arrow keys resize by {@link RESIZE_STEP_PX} (16 px) and pointer
 * drag resizes continuously; both report a value clamped to `[min, max]` through
 * `onResize`. The caller owns persistence and any further clamping (for example to a
 * share of the main area).
 *
 * `startAxisChange` says whether moving the handle toward the start of its axis
 * (ArrowLeft for vertical, ArrowUp for horizontal, or dragging that way) increases or
 * decreases the value. The run side pane sits to the right of a vertical handle, so
 * moving left widens it: `startAxisChange="increase"`.
 *
 * Colors follow the design system: `--color-border-subtle` at rest, `--color-primary`
 * on hover, focus, and during a drag. Hover/focus/drag are tracked in state so the one
 * `backgroundColor` is driven deterministically rather than relying on a utility for a
 * derived token.
 */
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react';

/** Keyboard resize step, per the design system. */
export const RESIZE_STEP_PX = 16;

export type ResizeOrientation = 'vertical' | 'horizontal';

/** Whether moving toward the axis start increases or decreases the value. */
export type StartAxisChange = 'increase' | 'decrease';

export interface ResizeHandleProps {
  /** Axis: `vertical` separates left/right panes; `horizontal` separates top/bottom. */
  readonly orientation: ResizeOrientation;
  /** Current value (the number arrow/drag deltas are applied to), e.g. a pane width. */
  readonly value: number;
  /** Minimum value, for the ARIA value range and clamping. */
  readonly min: number;
  /** Maximum value, for the ARIA value range and clamping. */
  readonly max: number;
  /** Accessible label for the separator. */
  readonly label: string;
  /** Whether moving toward the axis start increases or decreases the value. */
  readonly startAxisChange: StartAxisChange;
  /** Report a clamped next value; the caller persists it. */
  onResize(nextValue: number): void;
}

function clampValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  label,
  startAxisChange,
  onResize
}: ResizeHandleProps): ReactNode {
  const [active, setActive] = useState(false);
  const dragRef = useRef<{ start: number; startValue: number } | null>(null);
  const vertical = orientation === 'vertical';
  // Moving toward the axis start adds this sign times the delta to the value.
  const startSign = startAxisChange === 'increase' ? 1 : -1;

  function report(next: number): void {
    onResize(clampValue(next, min, max));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const towardStart = vertical ? 'ArrowLeft' : 'ArrowUp';
    const towardEnd = vertical ? 'ArrowRight' : 'ArrowDown';
    if (event.key === towardStart) {
      event.preventDefault();
      report(value + startSign * RESIZE_STEP_PX);
    } else if (event.key === towardEnd) {
      event.preventDefault();
      report(value - startSign * RESIZE_STEP_PX);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    // Primary button only.
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    dragRef.current = { start: vertical ? event.clientX : event.clientY, startValue: value };
    setActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current;
    if (drag === null) {
      return;
    }
    const position = vertical ? event.clientX : event.clientY;
    // Moving toward the axis start is a negative coordinate delta.
    const towardStart = drag.start - position;
    report(drag.startValue + startSign * towardStart);
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

  const orientationClass = vertical
    ? 'w-resize-handle cursor-col-resize'
    : 'h-[var(--width-resize-handle)] w-full cursor-row-resize';

  const style: CSSProperties = active ? {} : { backgroundColor: 'var(--color-border-subtle)' };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
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
      className={`shrink-0 select-none focus:outline-none ${orientationClass} ${active ? 'bg-primary' : ''}`}
      style={style}
    />
  );
}
