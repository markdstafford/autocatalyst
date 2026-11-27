/**
 * Header title/breadcrumb rules and settings-path detection.
 */
import { describe, expect, it } from 'vitest';

import { headerContentForPath, isRunsPath, isSettingsPath, runPath } from './navigation.js';

describe('headerContentForPath', () => {
  it('shows only a title on the top-level Runs view', () => {
    expect(headerContentForPath('/runs', 'All runs')).toEqual({ title: 'All runs' });
  });

  it('keeps project resolution separate from the view title', () => {
    expect(headerContentForPath('/runs/r1', 'Review', { phase: 'ready', name: 'Fixture app' }))
      .toEqual({ title: 'Review', breadcrumb: 'Fixture app' });
    expect(headerContentForPath('/runs', 'Review', { phase: 'loading' }).breadcrumb).toBe('Loading project…');
    expect(headerContentForPath('/runs', 'Review', { phase: 'ready' }).breadcrumb).toBe('Project unavailable');
  });

  it('shows a breadcrumb plus title on the second-level Connection view', () => {
    expect(headerContentForPath('/settings/connection', 'My review')).toEqual({
      breadcrumb: 'Settings',
      title: 'Connection'
    });
  });
});

describe('isSettingsPath', () => {
  it('detects the settings frame', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/connection')).toBe(true);
    expect(isSettingsPath('/runs')).toBe(false);
    expect(isSettingsPath('/')).toBe(false);
  });
});

describe('isRunsPath', () => {
  it('detects the runs collection and a selected run', () => {
    expect(isRunsPath('/runs')).toBe(true);
    expect(isRunsPath('/runs/run-123')).toBe(true);
    expect(isRunsPath('/settings')).toBe(false);
    expect(isRunsPath('/')).toBe(false);
  });
});

describe('runPath', () => {
  it('builds the address for a selected run', () => {
    expect(runPath('run-123')).toBe('/runs/run-123');
  });
});
