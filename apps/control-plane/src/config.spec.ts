import { describe, expect, it } from 'vitest';
import { readControlPlaneAppConfig } from './config.js';

describe('readControlPlaneAppConfig', () => {
  it('reads port, database path, bearer token, and master secret from environment variables', () => {
    expect(
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/control-plane.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'test-bearer-token',
        CONTROL_PLANE_MASTER_SECRET: 'test-master-secret'
      })
    ).toEqual({
      port: 4300,
      databasePath: '/tmp/control-plane.sqlite',
      bearerToken: 'test-bearer-token',
      masterSecret: 'test-master-secret',
      runConcurrency: 2
    });
  });

  it('lets flags take precedence over environment variables', () => {
    expect(
      readControlPlaneAppConfig(
        ['--port', '4400', '--database-path', '/tmp/flag.sqlite', '--bearer-token', 'flag-token', '--master-secret', 'flag-secret'],
        {
          CONTROL_PLANE_PORT: '4300',
          CONTROL_PLANE_DATABASE_PATH: '/tmp/env.sqlite',
          CONTROL_PLANE_BEARER_TOKEN: 'env-token',
          CONTROL_PLANE_MASTER_SECRET: 'env-secret'
        }
      )
    ).toEqual({
      port: 4400,
      databasePath: '/tmp/flag.sqlite',
      bearerToken: 'flag-token',
      masterSecret: 'flag-secret',
      runConcurrency: 2
    });
  });

  it('reads runConcurrency from AUTOCATALYST_RUN_CONCURRENCY when set', () => {
    expect(
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_RUN_CONCURRENCY: '5'
      }).runConcurrency
    ).toBe(5);
  });

  it('lets --run-concurrency flag take precedence over the env var', () => {
    expect(
      readControlPlaneAppConfig(['--run-concurrency', '7'], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_RUN_CONCURRENCY: '5'
      }).runConcurrency
    ).toBe(7);
  });

  it('defaults runConcurrency to 2 when not provided', () => {
    expect(
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      }).runConcurrency
    ).toBe(2);
  });

  it('throws for non-positive or non-integer runConcurrency', () => {
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_RUN_CONCURRENCY: '0'
      })
    ).toThrow('Run concurrency must be a positive integer.');
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_RUN_CONCURRENCY: 'abc'
      })
    ).toThrow('Run concurrency must be a positive integer.');
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_RUN_CONCURRENCY: '1.5'
      })
    ).toThrow('Run concurrency must be a positive integer.');
  });

  it('throws for missing, non-numeric, or out-of-range ports', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    })).toThrow('CONTROL_PLANE_PORT or --port is required.');
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: 'abc',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      })
    ).toThrow('Control-plane port must be a number between 0 and 65535.');
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '70000',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      })
    ).toThrow('Control-plane port must be a number between 0 and 65535.');
  });

  it('throws for missing or empty database paths', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '4300',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    })).toThrow('CONTROL_PLANE_DATABASE_PATH or --database-path is required.');
    expect(() =>
      readControlPlaneAppConfig(['--database-path', '   '], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      })
    ).toThrow('CONTROL_PLANE_DATABASE_PATH or --database-path is required.');
  });

  it('throws for missing or empty bearer tokens without echoing provided values', () => {
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_MASTER_SECRET: 'test-master-secret'
      })
    ).toThrow('CONTROL_PLANE_BEARER_TOKEN or --bearer-token is required.');

    expect(() =>
      readControlPlaneAppConfig(['--bearer-token', '   '], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_MASTER_SECRET: 'test-master-secret'
      })
    ).toThrow('CONTROL_PLANE_BEARER_TOKEN or --bearer-token is required.');
  });

  it('throws for missing or empty master secrets without echoing provided values', () => {
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'test-bearer-token'
      })
    ).toThrow('CONTROL_PLANE_MASTER_SECRET or --master-secret is required.');

    expect(() =>
      readControlPlaneAppConfig(['--master-secret', '   '], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'test-bearer-token'
      })
    ).toThrow('CONTROL_PLANE_MASTER_SECRET or --master-secret is required.');
  });
});
