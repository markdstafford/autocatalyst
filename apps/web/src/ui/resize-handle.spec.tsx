/**
 * ResizeHandle tests: separator semantics and value range for both orientations, 16 px
 * arrow resizing with the `startAxisChange` direction (left/up widens the start-side
 * pane), continuous pointer drag along the correct axis, and clamping to `[min, max]`.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RESIZE_STEP_PX, ResizeHandle, type ResizeHandleProps } from './resize-handle.js';

function renderHandle(overrides: Partial<ResizeHandleProps> = {}): {
  onResize: ReturnType<typeof vi.fn>;
} {
  const onResize = vi.fn();
  const props: ResizeHandleProps = {
    orientation: overrides.orientation ?? 'vertical',
    value: overrides.value ?? 440,
    min: overrides.min ?? 320,
    max: overrides.max ?? 720,
    label: overrides.label ?? 'Resize detail pane',
    startAxisChange: overrides.startAxisChange ?? 'increase',
    onResize
  };
  render(<ResizeHandle {...props} />);
  return { onResize };
}

function stubPointerCapture(el: HTMLElement): void {
  // jsdom lacks pointer capture; stub it so the handlers run.
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn().mockReturnValue(true);
}

describe('ResizeHandle vertical', () => {
  it('is a vertical separator in the value range', () => {
    renderHandle({ value: 440 });
    const handle = screen.getByRole('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('440');
    expect(handle.getAttribute('aria-valuemin')).toBe('320');
    expect(handle.getAttribute('aria-valuemax')).toBe('720');
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('aria-label')).toBe('Resize detail pane');
  });

  it('widens the start-side pane by a step on ArrowLeft and narrows on ArrowRight', () => {
    const { onResize } = renderHandle({ value: 440, startAxisChange: 'increase' });
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(440 + RESIZE_STEP_PX);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(440 - RESIZE_STEP_PX);
  });

  it('resizes continuously while dragging, along the x-axis', () => {
    const { onResize } = renderHandle({ value: 440 });
    const handle = screen.getByRole('separator');
    stubPointerCapture(handle);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600, clientY: 10 });
    // Dragging left by 40 px widens the start-side pane by 40.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 560, clientY: 10 });
    expect(onResize).toHaveBeenLastCalledWith(480);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 540, clientY: 10 });
    expect(onResize).toHaveBeenLastCalledWith(500);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    // After release, a move no longer resizes.
    onResize.mockClear();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 10 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('clamps arrow and drag values to the declared range', () => {
    const { onResize } = renderHandle({ value: 712, min: 320, max: 720 });
    const handle = screen.getByRole('separator');
    // 712 + 16 = 728, clamped to the max of 720.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(720);

    stubPointerCapture(handle);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 0 });
    // Dragging right far past the minimum clamps to 320.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000, clientY: 0 });
    expect(onResize).toHaveBeenLastCalledWith(320);
  });

  it('honours startAxisChange="decrease" so ArrowLeft shrinks the value', () => {
    const { onResize } = renderHandle({ value: 440, startAxisChange: 'decrease' });
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(440 - RESIZE_STEP_PX);
  });
});

describe('ResizeHandle horizontal', () => {
  it('is a horizontal separator and resizes on ArrowUp/ArrowDown', () => {
    const { onResize } = renderHandle({ orientation: 'horizontal', value: 280, min: 160, max: 480 });
    const handle = screen.getByRole('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onResize).toHaveBeenLastCalledWith(280 + RESIZE_STEP_PX);
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(onResize).toHaveBeenLastCalledWith(280 - RESIZE_STEP_PX);
  });

  it('drags along the y-axis', () => {
    const { onResize } = renderHandle({ orientation: 'horizontal', value: 280, min: 160, max: 480 });
    const handle = screen.getByRole('separator');
    stubPointerCapture(handle);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 0, clientY: 300 });
    // Dragging up by 30 px widens the top-side pane by 30.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0, clientY: 270 });
    expect(onResize).toHaveBeenLastCalledWith(310);
  });
});
