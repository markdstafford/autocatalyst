import { describe, expect, it } from 'vitest';

import { readControlPlaneAppConfig } from './config.js';

describe('readControlPlaneAppConfig', () => {
  it('reads port and database path from environment variables', () => {
    expect(
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/control-plane.sqlite'
      })
    ).toEqual({ port: 4300, databasePath: '/tmp/control-plane.sqlite' });
  });

  it('lets flags take precedence over environment variables', () => {
    expect(
      readControlPlaneAppConfig(['--port', '4400', '--database-path', '/tmp/flag.sqlite'], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/env.sqlite'
      })
    ).toEqual({ port: 4400, databasePath: '/tmp/flag.sqlite' });
  });

  it('throws for missing, non-numeric, or out-of-range ports', () => {
    expect(() => readControlPlaneAppConfig([], { CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite' })).toThrow(
      'CONTROL_PLANE_PORT or --port is required.'
    );
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: 'abc',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite'
      })
    ).toThrow('Control-plane port must be a number between 0 and 65535.');
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '70000',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite'
      })
    ).toThrow('Control-plane port must be a number between 0 and 65535.');
  });

  it('throws for missing or empty database paths', () => {
    expect(() => readControlPlaneAppConfig([], { CONTROL_PLANE_PORT: '4300' })).toThrow(
      'CONTROL_PLANE_DATABASE_PATH or --database-path is required.'
    );
    expect(() =>
      readControlPlaneAppConfig(['--database-path', '   '], { CONTROL_PLANE_PORT: '4300' })
    ).toThrow('CONTROL_PLANE_DATABASE_PATH or --database-path is required.');
  });
});
