import { describe, it, expect } from 'vitest';
import { defaultConvergenceMaxRounds, getStepConvergencePolicy } from './convergence-policy.js';

describe('convergence policy', () => {
  it('defaultConvergenceMaxRounds is 3', () => {
    expect(defaultConvergenceMaxRounds).toBe(3);
  });

  it('returns default max rounds when workflow has no convergence data', () => {
    // Create a minimal workflow definition without convergence data
    const workflow = { id: 'feature', steps: [], transitions: {} } as any;
    const policy = getStepConvergencePolicy(workflow, 'implementation.build');
    expect(policy.maxRounds).toBe(3);
  });

  it('returns configured max rounds when workflow has convergence data for step', () => {
    const workflow = {
      id: 'feature',
      steps: [],
      transitions: {},
      convergence: { 'implementation.build': { maxRounds: 2 } }
    } as any;
    const policy = getStepConvergencePolicy(workflow, 'implementation.build');
    expect(policy.maxRounds).toBe(2);
  });

  it('returns default max rounds for step not in convergence data', () => {
    const workflow = {
      id: 'feature',
      steps: [],
      transitions: {},
      convergence: { 'implementation.build': { maxRounds: 2 } }
    } as any;
    const policy = getStepConvergencePolicy(workflow, 'spec.author');
    expect(policy.maxRounds).toBe(3);
  });
});
