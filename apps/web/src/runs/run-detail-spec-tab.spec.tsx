/**
 * Spec-tab tests: the three Spec variants map to the shared copy descriptors through the
 * shared `EmptyState` component (whose own rendering is covered in `ui/empty-state.spec`).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RunDetailSpecTab } from './run-detail-spec-tab.js';
import { SPEC_EMPTY_STATES } from './run-detail-empty-states.js';

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
