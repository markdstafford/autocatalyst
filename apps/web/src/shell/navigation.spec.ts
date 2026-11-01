/**
 * Header title/breadcrumb rules and settings-path detection.
 */
import { describe, expect, it } from 'vitest';

import { headerContentForPath, isSettingsPath } from './navigation.js';

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
