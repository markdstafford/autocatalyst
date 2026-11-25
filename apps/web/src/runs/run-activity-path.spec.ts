import { describe, expect, it } from 'vitest';
import { at, attempt, workflow } from './run-activity.test-helper.js';
import { groupActivity, placeSessions, projectActivity } from './run-activity-path.js';
import { makeRun, makeSession } from './run-fixtures.js';

const definition = workflow();

describe('Activity path', () => {
  it('walks forward only, retains retries and off-path pauses, and groups consecutive phases', () => {
    const run = { ...makeRun(), currentStep: 'look' };
    const history = [
      attempt('open', 0, 0, 1), attempt('write', 1, 1, 2), attempt('look', 2, 2, 3),
      attempt('assemble', 3, 3, 4), attempt('pause', 4, 4, 5),
      attempt('write', 5, 5, 6, 2), attempt('look', 6, 6, null, 2)
    ].reverse();
    const { rows } = projectActivity(run, history, definition);
    expect(rows.map(row => [row.step, row.state, row.attempt?.occurrence.attempt])).toEqual([
      ['open', 'done', 1], ['draft', 'skipped', undefined], ['write', 'done', 1], ['look', 'done', 1],
      ['assemble', 'done', 1], ['pause', 'done', 1], ['write', 'done', 2], ['look', 'waiting', 2],
      ['sign', 'unreached', undefined], ['finish', 'unreached', undefined]
    ]);
    expect(groupActivity(rows, definition).map(group => group.label)).toEqual([
      undefined, 'Prepare', 'Ship', 'Prepare', 'Ship', undefined
    ]);
  });

  it.each([['failed', 'error-stop'], ['canceled', 'abort-stop']] as const)(
    'retains a superseded %s occurrence and separates path completion from an off-path stop', (status, stop) => {
      const before = [attempt('write', 0, 0, 1), attempt(stop, 1, 1, null)];
      const terminal = projectActivity({ ...makeRun({ status }), currentStep: stop }, before, definition);
      expect(terminal.rows.at(-1)).toMatchObject({ step: stop, state: status, disclose: false });
      expect(terminal.rows.find(row => row.step === 'write')?.state).toBe(status);
      expect(terminal.rows.find(row => row.step === 'look')?.state).toBe('unreached');

      const active = { ...makeRun({ waitingOn: 'ai' }), currentStep: 'write' };
      const after = [...before, attempt('write', 2, 2, null, 2)];
      const recovered = projectActivity(active, after, definition);
      expect(recovered.rows.filter(row => row.attempt).map(row => row.state)).toEqual(['ended', 'historical-stop', 'running']);
      expect(recovered.rows.at(-1)).toMatchObject({ step: 'finish', state: 'unreached' });
      expect(recovered.rows.find(row => row.step === 'look')?.state).toBe('unreached');

      const done = projectActivity({ ...makeRun({ status: 'done' }), currentStep: 'finish' },
        [...after.slice(0, -1), attempt('write', 2, 2, 3, 2), attempt('finish', 3, 3, null)], definition);
      expect(done.rows.at(-1)).toMatchObject({ step: 'finish', state: 'done' });
      expect(done.rows.find(row => row.step === 'sign')?.state).toBe('skipped');
      expect(done.rows.filter(row => row.step === stop)).toHaveLength(1);

      const fallback = projectActivity(active, after);
      expect(fallback.rows.map(row => row.state)).toEqual(['done', 'refreshing', 'running']);
      expect(fallback.rows.every(row => row.phase === null && row.attempt !== undefined)).toBe(true);
    }
  );

  it('never fabricates a terminal occurrence or claims stale open history is current', () => {
    const state = projectActivity({ ...makeRun({ status: 'failed' }), currentStep: 'error-stop' },
      [attempt('write', 0, 0, null)], definition);
    expect(state.current).toBeUndefined();
    expect(state.mismatch).toBe(true);
    expect(state.rows.find(row => row.attempt)?.state).toBe('refreshing');
    expect(state.rows.some(row => row.step === 'error-stop' || row.step === 'finish')).toBe(false);
    expect(projectActivity(makeRun(), undefined, definition).rows).toEqual([]);
  });
});

it('places ordered sessions at the most recent containing window, including boundary and open windows', () => {
  const sessions = [
    { ...makeSession({ id: 'recent-later', sequence: 3 }), step: 'write', startedAt: at(3) },
    { ...makeSession({ id: 'unmatched', sequence: 4 }), step: 'write', startedAt: at(5) },
    { ...makeSession({ id: 'recent-first', sequence: 2 }), step: 'write', startedAt: at(2) },
    { ...makeSession({ id: 'first', sequence: 1 }), step: 'write', startedAt: at(1) }
  ];
  const [original, revisit] = [attempt('write', 0, 0, 2), attempt('write', 1, 2, null, 2)];
  const placed = placeSessions([revisit, original], sessions, Date.parse(at(4)));
  expect(placed.get(original.id)?.map(session => session.id)).toEqual(['first']);
  expect(placed.get(revisit.id)?.map(session => session.id)).toEqual(['recent-first', 'recent-later']);
});
