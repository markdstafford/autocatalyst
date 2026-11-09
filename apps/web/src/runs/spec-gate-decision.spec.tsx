/**
 * SpecGateDecision tests: the derived label, the confirm popover copy (including the approve
 * co-confirmation), the exact SDK operation sent, control-plane error handling, and duplicate-submit
 * prevention. The SDK is faked at the public callback boundary (onApprove/onRequestChanges).
 */
import type { FeedbackResponse, Run } from '@autocatalyst/api-contract';
import { ControlPlaneClientError } from '@autocatalyst/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { makeRun } from './run-fixtures.js';
import { SpecGateDecision } from './spec-gate-decision.js';
import type { RunActionResult } from './use-run-detail.js';

const NOW = '2026-11-08T01:00:00.000Z';

function feedback(overrides: Partial<FeedbackResponse> & { id: string }): FeedbackResponse {
  return {
    id: overrides.id,
    runId: 'run-1',
    owner: { id: 'user-1', kind: 'human', tenantId: 'tenant-1', displayName: 'Phoebe' },
    tenant: 'tenant-1',
    target: 'artifact',
    status: 'open',
    title: 'Title',
    body: 'Body text',
    thread: [{ id: 't1', author: { id: 'user-1', kind: 'human', tenantId: 'tenant-1' }, body: 'Body text', createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as FeedbackResponse;
}

function gateRun(): Run {
  return makeRun({ id: 'run-1', workKind: 'feature' });
}

function render_(props?: {
  run?: Run;
  feedback?: FeedbackResponse[];
  currentPrincipalId?: string;
  onApprove?: () => Promise<RunActionResult>;
  onRequestChanges?: () => Promise<RunActionResult>;
}): { onApprove: ReturnType<typeof vi.fn>; onRequestChanges: ReturnType<typeof vi.fn> } {
  const onApprove = vi.fn(props?.onApprove ?? (async (): Promise<RunActionResult> => ({ status: 'ok' })));
  const onRequestChanges = vi.fn(props?.onRequestChanges ?? (async (): Promise<RunActionResult> => ({ status: 'ok' })));
  // Respect an explicitly-passed `undefined` principal (unknown identity), defaulting only when absent.
  const principalId = props !== undefined && 'currentPrincipalId' in props ? props.currentPrincipalId : 'user-1';
  render(
    <SpecGateDecision
      run={props?.run ?? gateRun()}
      feedback={props?.feedback ?? []}
      currentPrincipalId={principalId}
      onApprove={onApprove}
      onRequestChanges={onRequestChanges}
    />
  );
  return { onApprove, onRequestChanges };
}

describe('SpecGateDecision — label and availability', () => {
  it('shows Approve when no comment is open', () => {
    render_();
    expect(screen.getByTestId('spec-gate-decision').textContent).toBe('Approve');
  });

  it('shows Request changes (N) when comments are open', () => {
    render_({ feedback: [feedback({ id: 'a' }), feedback({ id: 'b' })] });
    expect(screen.getByTestId('spec-gate-decision').textContent).toBe('Request changes (2)');
  });

  it('renders nothing when the run is not at the spec gate', () => {
    render_({ run: { ...gateRun(), currentStep: 'implementation.human_review' } });
    expect(screen.queryByTestId('spec-gate-decision')).toBeNull();
  });
});

describe('SpecGateDecision — confirm and SDK operation', () => {
  it('sends exactly approve and closes on success', async () => {
    const user = userEvent.setup();
    const { onApprove, onRequestChanges } = render_();
    await user.click(screen.getByTestId('spec-gate-decision'));
    await user.click(await screen.findByTestId('spec-gate-decision-confirm'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onRequestChanges).not.toHaveBeenCalled();
  });

  it('sends exactly request_changes and never creates feedback', async () => {
    const user = userEvent.setup();
    const { onApprove, onRequestChanges } = render_({ feedback: [feedback({ id: 'a' })] });
    await user.click(screen.getByTestId('spec-gate-decision'));
    await user.click(await screen.findByTestId('spec-gate-decision-confirm'));
    expect(onRequestChanges).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('shows the approve co-confirmation copy for the current operator addressed comments', async () => {
    const user = userEvent.setup();
    render_({
      feedback: [
        feedback({ id: 'x', status: 'addressed' }),
        feedback({ id: 'y', status: 'addressed' })
      ],
      currentPrincipalId: 'user-1'
    });
    await user.click(screen.getByTestId('spec-gate-decision'));
    expect((await screen.findByTestId('spec-gate-decision-copy')).textContent).toBe(
      'Approving also confirms 2 of your addressed comments'
    );
  });

  it('omits the co-confirmation copy when the current operator is unknown', async () => {
    const user = userEvent.setup();
    render_({
      feedback: [feedback({ id: 'x', status: 'addressed' })],
      currentPrincipalId: undefined
    });
    await user.click(screen.getByTestId('spec-gate-decision'));
    await screen.findByTestId('spec-gate-decision-confirm');
    expect(screen.queryByTestId('spec-gate-decision-copy')).toBeNull();
  });
});

describe('SpecGateDecision — errors and duplicate submit', () => {
  it('keeps the popover open with the control-plane message on feedback_gate_blocked', async () => {
    const user = userEvent.setup();
    const error = new ControlPlaneClientError(409, { error: { code: 'feedback_gate_blocked', message: 'Another reviewer has open comments.' } });
    render_({ onApprove: async () => ({ status: 'error', error }) });
    await user.click(screen.getByTestId('spec-gate-decision'));
    await user.click(await screen.findByTestId('spec-gate-decision-confirm'));
    expect((await screen.findByTestId('spec-gate-decision-error')).textContent).toBe('Another reviewer has open comments.');
    // Gate-blocked is not retryable, so the confirm keeps its action label.
    expect(screen.getByTestId('spec-gate-decision-confirm').textContent).toBe('Approve');
  });

  it('offers a retry on a non-gate-blocked error', async () => {
    const user = userEvent.setup();
    const error = new ControlPlaneClientError(500, { error: { code: 'internal', message: 'Server error.' } });
    render_({ onApprove: async () => ({ status: 'error', error }) });
    await user.click(screen.getByTestId('spec-gate-decision'));
    await user.click(await screen.findByTestId('spec-gate-decision-confirm'));
    expect((await screen.findByTestId('spec-gate-decision-error')).textContent).toBe('Server error.');
    expect(screen.getByTestId('spec-gate-decision-confirm').textContent).toBe('Try again');
  });

  it('prevents a duplicate submit while a decision is in flight', async () => {
    const user = userEvent.setup();
    let resolve: ((value: RunActionResult) => void) | undefined;
    const pending = new Promise<RunActionResult>((r) => {
      resolve = r;
    });
    const { onApprove } = render_({ onApprove: () => pending });
    await user.click(screen.getByTestId('spec-gate-decision'));
    const confirm = await screen.findByTestId('spec-gate-decision-confirm');
    await user.click(confirm);
    await user.click(confirm);
    expect(onApprove).toHaveBeenCalledTimes(1);
    resolve?.({ status: 'ok' });
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
  });
});
