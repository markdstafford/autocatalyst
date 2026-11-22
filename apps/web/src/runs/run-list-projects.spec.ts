/** Project-name joins use display names and fall back to a dash. */
import { describe, expect, it } from 'vitest';

import { CELL_DASH } from './run-fields.js';
import { makeProject } from './run-fixtures.js';
import {
  buildProjectNameMap,
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
