/**
 * Bearer-token store tests: separate key, guarded access, in-memory fallback when
 * storage is blocked, and no stored token after clear.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PREFERENCES_STORAGE_KEY } from '../theme/preferences.js';
import {
  BEARER_TOKEN_STORAGE_KEY,
  clearBearerToken,
  hasBearerToken,
  readBearerToken,
  writeBearerToken
} from './token-store.js';

afterEach(() => {
  // Reset both the storage and the in-memory fallback between tests.
  clearBearerToken();
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

describe('bearer token store', () => {
  it('uses a key separate from preferences', () => {
    expect(BEARER_TOKEN_STORAGE_KEY).toBe('autocatalyst.bearerToken');
    expect(BEARER_TOKEN_STORAGE_KEY).not.toBe(PREFERENCES_STORAGE_KEY);
  });

  it('returns undefined when nothing is stored', () => {
    expect(readBearerToken()).toBeUndefined();
    expect(hasBearerToken()).toBe(false);
  });

  it('writes and reads under the bearer-token key only', () => {
    writeBearerToken('abc-123');
    expect(readBearerToken()).toBe('abc-123');
    expect(hasBearerToken()).toBe(true);
    expect(window.localStorage.getItem(BEARER_TOKEN_STORAGE_KEY)).toBe('abc-123');
    expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBeNull();
  });

  it('clears the token', () => {
    writeBearerToken('abc-123');
    clearBearerToken();
    expect(readBearerToken()).toBeUndefined();
    expect(window.localStorage.getItem(BEARER_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('falls back to in-memory storage when localStorage is blocked', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    writeBearerToken('in-memory-only');
    expect(readBearerToken()).toBe('in-memory-only');
    expect(hasBearerToken()).toBe(true);
  });
});
