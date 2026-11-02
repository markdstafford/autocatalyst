/**
 * RunSeparator tests: the separator semantics, 16 px arrow resizing (left widens the
 * right-hand pane), continuous pointer drag, and the ARIA value range.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RESIZE_STEP_PX, RunSeparator } from './run-separator.js';

function renderSeparator(widthPx = 440): { onResize: ReturnType<typeof vi.fn> } {
  const onResize = vi.fn();
  render(<RunSeparator widthPx={widthPx} minPx={320} maxPx={720} onResize={onResize} />);
  return { onResize };
}

describe('RunSeparator', () => {
  it('is a vertical separator in the value range', () => {
    renderSeparator(440);
    const handle = screen.getByRole('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuenow')).toBe('440');
    expect(handle.getAttribute('aria-valuemin')).toBe('320');
    expect(handle.getAttribute('aria-valuemax')).toBe('720');
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  it('widens the pane by a step on ArrowLeft and narrows on ArrowRight', () => {
    const { onResize } = renderSeparator(440);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(440 + RESIZE_STEP_PX);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(440 - RESIZE_STEP_PX);
  });

  it('resizes continuously while dragging', () => {
    const { onResize } = renderSeparator(440);
    const handle = screen.getByRole('separator');
    // jsdom lacks pointer capture; stub it so the handlers run.
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = vi.fn().mockReturnValue(true);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 600 });
    // Dragging left by 40 px widens the pane by 40.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 560 });
    expect(onResize).toHaveBeenLastCalledWith(480);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 540 });
    expect(onResize).toHaveBeenLastCalledWith(500);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    // After release, a move no longer resizes.
    onResize.mockClear();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    expect(onResize).not.toHaveBeenCalled();
  });
});
