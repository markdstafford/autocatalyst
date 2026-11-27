import { expect, it } from 'vitest';

import { makeRun } from './run-fixtures.js';
import { buildRunViewRequest, projectRunViewRows } from './run-view-list.js';
import { ALL_RUNS } from './run-views.js';

it('emits only address scope, leaving pagination to the caller', () => {
  expect(buildRunViewRequest(ALL_RUNS, undefined)).toEqual({});
  expect(buildRunViewRequest(ALL_RUNS, 'p42')).toEqual({ projectId: 'p42' });
});

it('returns original rows in server order', () => {
  const rows = [makeRun({ id: 'b' }), makeRun({ id: 'a' })];
  expect(projectRunViewRows(ALL_RUNS, rows)).toBe(rows);
});
