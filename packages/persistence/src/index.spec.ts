import { describe, expect, it } from 'vitest';

import { createPersistenceScaffold } from './index.js';

describe('persistence scaffold', () => {
  it('records sqlite as the initial storage engine', () => {
    expect(createPersistenceScaffold()).toEqual({
      packageName: '@autocatalyst/persistence',
      storageEngine: 'sqlite'
    });
  });
});
