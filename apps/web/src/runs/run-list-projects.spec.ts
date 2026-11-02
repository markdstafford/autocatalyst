/**
 * Project-name join rule tests: name lookup, dash fallbacks, the bounded-refetch
 * decision, and the missing-id recompute that prevents per-poll refetching.
 */
import { describe, expect, it } from 'vitest';

import { CELL_DASH } from './run-fields.js';
import { makeProject } from './run-fixtures.js';
import {
  buildProjectNameMap,
  computeMissingProjectIds,
  needsProjectRefetch,
  projectName,
  referencedProjectIds
} from './run-list-projects.js';

const known = buildProjectNameMap([
  makeProject({ id: 'p1', displayName: 'Alpha' }),
  makeProject({ id: 'p2', displayName: 'Beta' })
]);

describe('projectName', () => {
  it('returns the name for a known id', () => {
    expect(projectName('p1', known)).toBe('Alpha');
  });

  it('returns a dash for an unknown or undefined id', () => {
    expect(projectName('nope', known)).toBe(CELL_DASH);
    expect(projectName(undefined, known)).toBe(CELL_DASH);
  });
});

describe('referencedProjectIds', () => {
  it('collects defined ids and ignores undefined', () => {
    const ids = referencedProjectIds([{ projectId: 'p1' }, { projectId: undefined }, { projectId: 'p1' }, { projectId: 'p3' }]);
    expect(ids.sort()).toEqual(['p1', 'p3']);
  });
});

describe('needsProjectRefetch', () => {
  it('is true for a defined unknown id not yet recorded missing', () => {
    expect(needsProjectRefetch([{ projectId: 'p9' }], known, new Set())).toBe(true);
  });

  it('is false when the only unknown id is already recorded missing', () => {
    expect(needsProjectRefetch([{ projectId: 'p9' }], known, new Set(['p9']))).toBe(false);
  });

  it('is false for undefined and known ids', () => {
    expect(needsProjectRefetch([{ projectId: undefined }, { projectId: 'p1' }], known, new Set())).toBe(false);
  });
});

describe('computeMissingProjectIds', () => {
  it('records only referenced ids absent from the known map', () => {
    const missing = computeMissingProjectIds([{ projectId: 'p1' }, { projectId: 'p9' }, { projectId: undefined }], known);
    expect([...missing]).toEqual(['p9']);
  });
});
