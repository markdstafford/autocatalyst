/**
 * Header title/breadcrumb rules and settings-path detection.
 */
import { describe, expect, it } from 'vitest';

import { headerContentForPath, isRunsPath, isSettingsPath, runPath } from './navigation.js';

describe('headerContentForPath', () => {
  it('shows only a title on the top-level Runs view', () => {
    expect(headerContentForPath('/runs')).toEqual({ title: 'Runs' });
  });

  it('shows a breadcrumb plus title on the second-level Connection view', () => {
    expect(headerContentForPath('/settings/connection')).toEqual({
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
