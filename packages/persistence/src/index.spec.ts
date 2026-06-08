import { describe, expect, it } from 'vitest';

import {
  DrizzleProbeResourceRepository,
  checkSqliteDatabaseReachability,
  createSqliteDatabase,
  migrateSqliteDatabase
} from './index.js';

describe('persistence barrel', () => {
  it('exports the public persistence API', () => {
    expect(createSqliteDatabase).toBeTypeOf('function');
    expect(migrateSqliteDatabase).toBeTypeOf('function');
    expect(checkSqliteDatabaseReachability).toBeTypeOf('function');
    expect(DrizzleProbeResourceRepository).toBeTypeOf('function');
  });
});
