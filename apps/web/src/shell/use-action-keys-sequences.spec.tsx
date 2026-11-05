/**
 * Sequence dispatch through the shared `useActionKeys` tracker.
 *
 * Driven by scripted registries (no shipped action uses a sequence yet): two- and
 * three-chord sequences fire on their final chord; pending state clears on a wrong key,
 * Escape, and after `SEQUENCE_TIMEOUT_MS`; a wrong key after a prefix is re-evaluated as a
 * fresh first chord; and two mounted instances share one pending tracker.
 */
import { fireEvent, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionDescriptor } from './action-registry.js';
import { SEQUENCE_TIMEOUT_MS, useActionKeys, type ActionHandlers } from './use-action-keys.js';

/** A sequence action (`g` then `r`) plus a combo (`j`), both applying outside text entry. */
const REGISTRY: readonly ActionDescriptor[] = [
  { id: 'open-shortcuts', name: 'g then r', keys: [[{ key: 'g' }, { key: 'r' }]], appliesWhen: 'no-text-entry' },
  { id: 'select-next', name: 'j', keys: [[{ key: 'j' }]], appliesWhen: 'no-text-entry' }
];

const THREE_STEP: readonly ActionDescriptor[] = [
  {
    id: 'open-shortcuts',
    name: 'g then r then t',
    keys: [[{ key: 'g' }, { key: 'r' }, { key: 't' }]],
    appliesWhen: 'no-text-entry'
  }
];

function Harness(props: {
  handlers: ActionHandlers;
  registry: readonly ActionDescriptor[];
}): ReactNode {
  useActionKeys(props.handlers, { registry: props.registry });
  return null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sequence dispatch', () => {
  it('fires a two-chord sequence on the final chord', () => {
    const fire = vi.fn();
    render(<Harness handlers={{ 'open-shortcuts': fire }} registry={REGISTRY} />);
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('fires a three-chord sequence on the final chord', () => {
    const fire = vi.fn();
    render(<Harness handlers={{ 'open-shortcuts': fire }} registry={THREE_STEP} />);
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(fire).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 't' });
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('clears pending state after the sequence timeout', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    render(<Harness handlers={{ 'open-shortcuts': fire }} registry={REGISTRY} />);
    fireEvent.keyDown(document.body, { key: 'g' });
    vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS + 1);
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(fire).not.toHaveBeenCalled();
  });

  it('clears pending state on Escape', () => {
    const fire = vi.fn();
    render(<Harness handlers={{ 'open-shortcuts': fire }} registry={REGISTRY} />);
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(fire).not.toHaveBeenCalled();
  });

  it('re-evaluates a wrong key as a fresh first chord', () => {
    const seq = vi.fn();
    const next = vi.fn();
    render(<Harness handlers={{ 'open-shortcuts': seq, 'select-next': next }} registry={REGISTRY} />);
    fireEvent.keyDown(document.body, { key: 'g' });
    // `j` does not continue the `g…` sequence, so pending clears and `j` runs as a combo.
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(seq).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('shares one pending tracker across two mounted instances', () => {
    const seq = vi.fn();
    const next = vi.fn();
    function Dual(): ReactNode {
      useActionKeys({ 'open-shortcuts': seq }, { registry: REGISTRY });
      useActionKeys({ 'select-next': next }, { registry: REGISTRY });
      return null;
    }
    render(<Dual />);

    // A sequence owned by the first instance completes through the shared tracker.
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'r' });
    expect(seq).toHaveBeenCalledTimes(1);

    seq.mockClear();
    next.mockClear();

    // A wrong key clears the shared pending state; the combo owned by the second
    // instance then runs from the re-evaluated key.
    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(seq).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
