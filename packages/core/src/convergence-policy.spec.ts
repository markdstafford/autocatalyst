import { describe, it, expect } from 'vitest';
import {
  defaultConvergenceMaxRounds,
  defaultConvergenceDepth,
  getStepConvergencePolicy,
  getImplementationAltitudeLadder,
  StepConvergencePolicyError
} from './convergence-policy.js';

describe('convergence policy', () => {
  it('defaultConvergenceMaxRounds is 3', () => {
    expect(defaultConvergenceMaxRounds).toBe(3);
  });

  it('defaultConvergenceDepth is build_only', () => {
    expect(defaultConvergenceDepth).toBe('build_only');
  });

  it('returns default policy when workflow has no convergence data', () => {
    const workflow = { id: 'feature', steps: [], transitions: {} } as any;
    const policy = getStepConvergencePolicy(workflow, 'implementation.build');
    expect(policy.maxRounds).toBe(3);
    expect(policy.depth).toBe('build_only');
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
    expect(policy.depth).toBe('build_only');
  });

  it('returns default for step not in convergence data', () => {
    const workflow = {
      id: 'feature',
      steps: [],
      transitions: {},
      convergence: { 'implementation.build': { maxRounds: 2 } }
    } as any;
    const policy = getStepConvergencePolicy(workflow, 'spec.author');
    expect(policy.maxRounds).toBe(3);
    expect(policy.depth).toBe('build_only');
  });

  it('returns configured depth', () => {
    const workflow = {
      id: 'feature',
      steps: [],
      transitions: {},
      convergence: { 'implementation.build': { depth: 'full' } }
    } as any;
    const policy = getStepConvergencePolicy(workflow, 'implementation.build');
    expect(policy.depth).toBe('full');
    expect(policy.maxRounds).toBe(3);
  });

  it('throws StepConvergencePolicyError on invalid depth', () => {
    const workflow = {
      id: 'feature',
      steps: [],
      transitions: {},
      convergence: { 'implementation.build': { depth: 'bogus' } }
    } as any;
    expect(() => getStepConvergencePolicy(workflow, 'implementation.build')).toThrow(StepConvergencePolicyError);
  });

  it('throws StepConvergencePolicyError on invalid maxRounds', () => {
    const workflow = {
      id: 'feature',
      steps: [],
      transitions: {},
      convergence: { 'implementation.build': { maxRounds: 0 } }
    } as any;
    expect(() => getStepConvergencePolicy(workflow, 'implementation.build')).toThrow(StepConvergencePolicyError);
  });
});

describe('getImplementationAltitudeLadder', () => {
  it('build_only -> [build]', () => {
    expect(getImplementationAltitudeLadder({ maxRounds: 3, depth: 'build_only' })).toEqual(['build']);
  });

  it('layout -> [layout, build]', () => {
    expect(getImplementationAltitudeLadder({ maxRounds: 3, depth: 'layout' })).toEqual(['layout', 'build']);
  });

  it('public_api -> [layout, public_api, build]', () => {
    expect(getImplementationAltitudeLadder({ maxRounds: 3, depth: 'public_api' })).toEqual(['layout', 'public_api', 'build']);
  });

  it('full -> [layout, public_api, private_api, build]', () => {
    expect(getImplementationAltitudeLadder({ maxRounds: 3, depth: 'full' })).toEqual(['layout', 'public_api', 'private_api', 'build']);
  });
});
