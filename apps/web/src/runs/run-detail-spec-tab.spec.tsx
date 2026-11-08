/**
 * Spec-tab tests: the empty discriminators map to the shared copy, and the `ready` discriminator
 * renders the review surface (rendered document + comment column). Read-only vs commenting is driven
 * by the run's current step.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunDetailSpecTab } from './run-detail-spec-tab.js';
import { SPEC_EMPTY_STATES } from './run-detail-empty-states.js';
import { makeRun } from './run-fixtures.js';

const run = makeRun();
const noop = vi.fn(async () => ({ status: 'created' as const }));
const reload = vi.fn();

function renderTab(spec: Parameters<typeof RunDetailSpecTab>[0]['spec']): void {
  render(<RunDetailSpecTab spec={spec} run={run} onCreateComment={noop} onReloadNeeded={reload} />);
}

describe('RunDetailSpecTab', () => {
  it('shows the no-spec variant', () => {
    renderTab({ status: 'no-spec' });
    expect(screen.getByTestId('pane-spec-empty').textContent).toContain(SPEC_EMPTY_STATES.noSpec.title);
  });

  it('shows the drafting variant', () => {
    renderTab({ status: 'drafting' });
    expect(screen.getByTestId('pane-spec-empty').textContent).toContain(SPEC_EMPTY_STATES.drafting.title);
  });

  it('renders the review surface when the spec is ready', () => {
    renderTab({ status: 'ready', markdown: '# Spec heading\n\nBody.', artifactId: 'artifact-1', feedback: [] });
    const doc = screen.getByTestId('spec-document');
    expect(within(doc).getByText('Spec heading')).toBeDefined();
    expect(screen.getByTestId('comment-column')).toBeDefined();
  });

  it('shows a loading state while the spec read is in flight', () => {
    renderTab({ status: 'loading' });
    expect(screen.getByTestId('pane-spec-loading')).toBeDefined();
  });

  it('shows an inline error on a non-404 failure', () => {
    renderTab({ status: 'error', message: 'nope' });
    expect(screen.getByTestId('pane-spec-error').textContent).toContain('nope');
  });
});
