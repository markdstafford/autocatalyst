import { describe, expect, it, vi } from 'vitest';

import { makeProject } from '../runs/run-fixtures.js';
import { createProjectDirectory } from './project-directory.js';

describe('project directory', () => {
  it('publishes before reconciliation, ignoring an older in-flight read and retaining data on refresh failure', async () => {
    const old = makeProject({ displayName: 'Old' });
    const saved = { ...old, displayName: 'Renamed', updatedAt: '2026-01-02T00:00:00.000Z' };
    let resolveOld!: (result: { projects: typeof old[] }) => void;
    const listProjects = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce({ projects: [saved, makeProject({ id: 'other' })] });
    const directory = createProjectDirectory({ listProjects });

    const staleRead = directory.refresh();
    directory.publish(saved);
    expect(directory.getSnapshot()).toEqual({ phase: 'ready', projects: [saved] });
    resolveOld({ projects: [old] });
    await staleRead;
    expect(directory.getSnapshot()).toEqual({ phase: 'ready', projects: [saved] });
    await directory.refresh();
    expect(directory.getSnapshot().projects.map(({ id }) => id)).toEqual([saved.id, 'other']);
  });

  it('looks up a missing name at most once and never conflates read failure with an empty list', async () => {
    const listProjects = vi.fn()
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValue({ projects: [makeProject()] });
    const directory = createProjectDirectory({ listProjects });
    expect(directory.getSnapshot().phase).toBe('loading');
    await directory.refresh();
    expect(directory.getSnapshot().phase).toBe('error');
    await directory.refresh();
    directory.lookup(['project-1']);
    expect(listProjects).toHaveBeenCalledTimes(2);
    directory.lookup(['missing']);
    await Promise.resolve();
    directory.lookup(['missing']);
    expect(listProjects).toHaveBeenCalledTimes(3);
    directory.lookup(['another']);
    expect(listProjects).toHaveBeenCalledTimes(4);
  });

  it('follows up once when a project ID first appears during a read that did not include it', async () => {
    const discovered = makeProject({ id: 'new' });
    let finish!: (result: { projects: typeof discovered[] }) => void;
    const listProjects = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ projects: [discovered] });
    const directory = createProjectDirectory({ listProjects });
    const first = directory.refresh();
    directory.lookup(['new']);
    directory.lookup(['new']);
    expect(listProjects).toHaveBeenCalledTimes(1);
    finish({ projects: [] });
    await first;
    expect(directory.getSnapshot().projects).toEqual([discovered]);
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('does not publish to a retired client', () => {
    const listProjects = vi.fn();
    const directory = createProjectDirectory({ listProjects });
    directory.setActive(false);
    directory.publish(makeProject());
    expect(directory.getSnapshot().projects).toEqual([]);
    expect(listProjects).not.toHaveBeenCalled();
  });
});
