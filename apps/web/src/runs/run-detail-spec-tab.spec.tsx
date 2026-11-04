/**
 * Spec-tab and empty-state tests: the three Spec variants map to the shared copy
 * descriptors, and the reusable empty-state component renders title + line without a
 * button.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunDetailEmptyState } from './run-detail-empty-state.js';
import { RunDetailSpecTab } from './run-detail-spec-tab.js';
import {
  ACCEPTANCE_EMPTY_STATE,
  ACTIVITY_EMPTY_STATE,
  SPEC_EMPTY_STATES
} from './run-detail-empty-states.js';

describe('RunDetailEmptyState', () => {
  it('renders the descriptor title and line with no button', () => {
    render(<RunDetailEmptyState testId="x" copy={ACCEPTANCE_EMPTY_STATE} />);
    const region = screen.getByTestId('x');
    expect(region.textContent).toContain(ACCEPTANCE_EMPTY_STATE.title);
    expect(region.textContent).toContain(ACCEPTANCE_EMPTY_STATE.line);
    expect(screen.queryByRole('button')).toBeNull();
    expect(region.querySelector('img')).toBeNull();
  });

  it('renders the Activity copy', () => {
    render(<RunDetailEmptyState testId="activity" copy={ACTIVITY_EMPTY_STATE} />);
    expect(screen.getByTestId('activity').textContent).toContain(ACTIVITY_EMPTY_STATE.title);
  });
});

describe('RunDetailSpecTab', () => {
  it('shows the no-spec variant', () => {
    render(<RunDetailSpecTab spec={{ status: 'no-spec' }} />);
    expect(screen.getByTestId('pane-spec-empty').textContent).toContain(SPEC_EMPTY_STATES.noSpec.title);
  });

  it('shows the drafting variant', () => {
    render(<RunDetailSpecTab spec={{ status: 'drafting' }} />);
    expect(screen.getByTestId('pane-spec-empty').textContent).toContain(SPEC_EMPTY_STATES.drafting.title);
  });

  it('shows the ready variant', () => {
    render(<RunDetailSpecTab spec={{ status: 'ready' }} />);
    expect(screen.getByTestId('pane-spec-empty').textContent).toContain(SPEC_EMPTY_STATES.ready.title);
  });

  it('shows a loading state while the spec read is in flight', () => {
    render(<RunDetailSpecTab spec={{ status: 'loading' }} />);
    expect(screen.getByTestId('pane-spec-loading')).toBeDefined();
  });

  it('shows an inline error on a non-404 failure', () => {
    render(<RunDetailSpecTab spec={{ status: 'error', message: 'nope' }} />);
    expect(screen.getByTestId('pane-spec-error').textContent).toContain('nope');
  });
});
