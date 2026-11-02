/**
 * useActionKeys dispatch tests: a registered handler fires for its action, `j` only
 * fires selection when focus is inside the run list, and an open dialog blocks it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { RUN_LIST_FOCUS_ATTR, useActionKeys, type ActionHandlers } from './use-action-keys.js';

function Harness(props: { handlers: ActionHandlers; withDialog?: boolean }): ReactNode {
  useActionKeys(props.handlers);
  return (
    <div>
      <div {...{ [RUN_LIST_FOCUS_ATTR]: true }} data-testid="list">
        <button data-testid="row">row</button>
      </div>
      <button data-testid="outside">outside</button>
      {props.withDialog === true ? <div role="dialog">overlay</div> : null}
    </div>
  );
}

describe('useActionKeys', () => {
  it('fires the sidebar toggle for "[" outside text entry', () => {
    const toggle = vi.fn();
    render(<Harness handlers={{ 'sidebar-toggle': toggle }} />);
    fireEvent.keyDown(document.body, { key: '[' });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('fires select-next for "j" only when focus is inside the run list', () => {
    const next = vi.fn();
    render(<Harness handlers={{ 'select-next': next }} />);

    screen.getByTestId('outside').focus();
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(next).not.toHaveBeenCalled();

    screen.getByTestId('row').focus();
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not fire single-key actions while a dialog is open', () => {
    const next = vi.fn();
    render(<Harness handlers={{ 'select-next': next }} withDialog />);
    screen.getByTestId('row').focus();
    fireEvent.keyDown(document.body, { key: 'j' });
    expect(next).not.toHaveBeenCalled();
  });
});
