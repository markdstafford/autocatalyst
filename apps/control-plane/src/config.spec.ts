import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('reads workspace roots from AUTOCATALYST_REPOS_ROOT and AUTOCATALYST_WORKSPACES_ROOT when set', () => {
    expect(
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_REPOS_ROOT: '/var/autocatalyst/repos',
        AUTOCATALYST_WORKSPACES_ROOT: '/var/autocatalyst/workspaces'
      }).workspaceRoots
    ).toEqual({
      reposRoot: '/var/autocatalyst/repos',
      workspacesRoot: '/var/autocatalyst/workspaces'
    });
  });

  it('lets workspace root flags take precedence over environment variables', () => {
    expect(
      readControlPlaneAppConfig(['--repos-root', '/flag/repos', '--workspaces-root', '/flag/workspaces'], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_REPOS_ROOT: '/env/repos',
        AUTOCATALYST_WORKSPACES_ROOT: '/env/workspaces'
      }).workspaceRoots
    ).toEqual({ reposRoot: '/flag/repos', workspacesRoot: '/flag/workspaces' });
  });

  it('leaves workspace roots undefined when neither root is configured', () => {
    expect(
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      }).workspaceRoots
    ).toBeUndefined();
  });

  it('throws when only one workspace root is configured', () => {
    expect(() =>
      readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_REPOS_ROOT: '/var/autocatalyst/repos'
      })
    ).toThrow('Both repos root and workspaces root must be configured together.');

    expect(() =>
      readControlPlaneAppConfig(['--workspaces-root', '/var/autocatalyst/workspaces'], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      })
    ).toThrow('Both repos root and workspaces root must be configured together.');
  });

  it('throws for blank workspace root values without echoing them', () => {
    expect(() =>
      readControlPlaneAppConfig(['--repos-root', '   ', '--workspaces-root', '/var/autocatalyst/workspaces'], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      })
    ).toThrow('Workspace root values must be non-empty when configured.');

    expect(() =>
      readControlPlaneAppConfig(['--repos-root', '/var/autocatalyst/repos', '--workspaces-root', '   '], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      })
    ).toThrow('Workspace root values must be non-empty when configured.');
  });

  it('enables real runner dispatch from AUTOCATALYST_REAL_DISPATCH truthy values', () => {
    for (const value of ['1', 'true', 'yes']) {
      expect(readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '3000',
        CONTROL_PLANE_DATABASE_PATH: ':memory:',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret',
        AUTOCATALYST_REAL_DISPATCH: value
      }).realRunnerDispatch).toEqual({ enabled: true });
    }
  });

  it('enables real runner dispatch from --real-dispatch even when env is false', () => {
    expect(readControlPlaneAppConfig(['--real-dispatch'], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_REAL_DISPATCH: 'false'
    }).realRunnerDispatch).toEqual({ enabled: true });
  });

  it('rejects unsupported real-dispatch env values without echoing them', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_REAL_DISPATCH: 'secret-token-value'
    })).toThrow('AUTOCATALYST_REAL_DISPATCH must be one of 1, true, yes, 0, false, or no.');
  });

  it('reads default provider profile id from env and flag when real dispatch is enabled', () => {
    expect(readControlPlaneAppConfig(['--real-dispatch', '--default-provider-profile-id', 'cfg_flag'], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID: 'cfg_env'
    }).realRunnerDispatch).toEqual({ enabled: true, defaultProviderProfileId: 'cfg_flag' });
  });

  it('rejects blank default provider profile ids', () => {
    expect(() => readControlPlaneAppConfig(['--real-dispatch', '--default-provider-profile-id', '   '], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    })).toThrow('Default provider profile id must be non-empty when configured.');
  });

  it('rejects default provider profile id unless real dispatch is enabled', () => {
    expect(() => readControlPlaneAppConfig(['--default-provider-profile-id', 'cfg_1'], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    })).toThrow('Default provider profile id requires real runner dispatch to be enabled.');
  });

  it('leaves real runner dispatch undefined by default', () => {
    expect(readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    }).realRunnerDispatch).toBeUndefined();
  });

  it('reads specAuthorIdentity from GITHUB_LOGIN env var', () => {
    expect(readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      GITHUB_LOGIN: 'markdstafford'
    }).specAuthorIdentity).toBe('markdstafford');
  });

  it('leaves specAuthorIdentity undefined when GITHUB_LOGIN is absent', () => {
    expect(readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    }).specAuthorIdentity).toBeUndefined();
  });

  it('leaves pullRequestReconciliationTicker undefined by default', () => {
    expect(readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    }).pullRequestReconciliationTicker).toBeUndefined();
  });

  it('parses pullRequestReconciliationTicker from env vars when ticker is enabled', () => {
    expect(readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_PR_RECONCILE_TICKER: 'true',
      AUTOCATALYST_PR_RECONCILE_INTERVAL_MS: '30000',
      AUTOCATALYST_PR_RECONCILE_TENANT: 'tenant_dev'
    }).pullRequestReconciliationTicker).toEqual({ enabled: true, intervalMs: 30000, tenant: 'tenant_dev' });
  });

  it('parses pullRequestReconciliationTicker from CLI flags', () => {
    expect(readControlPlaneAppConfig(
      ['--pr-reconcile-ticker', '--pr-reconcile-interval-ms', '5000', '--pr-reconcile-tenant', 'tenant_dev'],
      {
        CONTROL_PLANE_PORT: '3000',
        CONTROL_PLANE_DATABASE_PATH: ':memory:',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      }
    ).pullRequestReconciliationTicker).toEqual({ enabled: true, intervalMs: 5000, tenant: 'tenant_dev' });
  });

  it('throws for invalid boolean value for AUTOCATALYST_PR_RECONCILE_TICKER', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_PR_RECONCILE_TICKER: 'maybe'
    })).toThrow('AUTOCATALYST_PR_RECONCILE_TICKER must be one of 1, true, yes, 0, false, or no.');
  });

  it('throws when ticker is enabled but interval is missing', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_PR_RECONCILE_TICKER: 'true',
      AUTOCATALYST_PR_RECONCILE_TENANT: 'tenant_dev'
    })).toThrow('AUTOCATALYST_PR_RECONCILE_INTERVAL_MS or --pr-reconcile-interval-ms is required when the PR reconciliation ticker is enabled.');
  });

  it('throws when ticker is enabled but interval is zero', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_PR_RECONCILE_TICKER: 'true',
      AUTOCATALYST_PR_RECONCILE_INTERVAL_MS: '0',
      AUTOCATALYST_PR_RECONCILE_TENANT: 'tenant_dev'
    })).toThrow('AUTOCATALYST_PR_RECONCILE_INTERVAL_MS must be a positive integer.');
  });

  it('throws when ticker is enabled but interval is not a number', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_PR_RECONCILE_TICKER: 'true',
      AUTOCATALYST_PR_RECONCILE_INTERVAL_MS: 'abc',
      AUTOCATALYST_PR_RECONCILE_TENANT: 'tenant_dev'
    })).toThrow('AUTOCATALYST_PR_RECONCILE_INTERVAL_MS must be a positive integer.');
  });

  it('throws when ticker is enabled but tenant is missing', () => {
    expect(() => readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '3000',
      CONTROL_PLANE_DATABASE_PATH: ':memory:',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret',
      AUTOCATALYST_PR_RECONCILE_TICKER: 'true',
      AUTOCATALYST_PR_RECONCILE_INTERVAL_MS: '5000'
    })).toThrow('AUTOCATALYST_PR_RECONCILE_TENANT or --pr-reconcile-tenant is required when the PR reconciliation ticker is enabled.');
  });

  describe('fake mode', () => {
    it('leaves fakeMode undefined and preserves existing behavior when disabled', () => {
      const config = readControlPlaneAppConfig([], {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'token',
        CONTROL_PLANE_MASTER_SECRET: 'secret'
      });
      expect(config.fakeMode).toBeUndefined();
      expect(config).toEqual({
        port: 4300,
        databasePath: '/tmp/db.sqlite',
        bearerToken: 'token',
        masterSecret: 'secret',
        runConcurrency: 2
      });
    });

    it('enables fake mode from the --fake-mode flag with documented defaults', () => {
      const config = readControlPlaneAppConfig(['--fake-mode', '--fake-state-dir', '/tmp/fake'], {});
      expect(config.fakeMode).toEqual({ enabled: true, stateDir: '/tmp/fake' });
      expect(config.port).toBe(4010);
      expect(config.bearerToken).toBe('fake-mode-token');
      expect(config.masterSecret).toBe('fake-mode-master-secret');
      expect(config.databasePath).toBe('/tmp/fake/control-plane.sqlite');
      expect(config.workspaceRoots).toEqual({ reposRoot: '/tmp/fake/repos', workspacesRoot: '/tmp/fake/workspaces' });
    });

    it('enables fake mode from AUTOCATALYST_FAKE_MODE and resolves a relative state dir to absolute', () => {
      const config = readControlPlaneAppConfig([], { AUTOCATALYST_FAKE_MODE: 'true' });
      expect(config.fakeMode?.enabled).toBe(true);
      expect(config.fakeMode?.stateDir.endsWith('.autocatalyst-fake')).toBe(true);
      expect(config.fakeMode?.stateDir.startsWith('/')).toBe(true);
    });

    it('reads the state dir from AUTOCATALYST_FAKE_STATE_DIR', () => {
      const config = readControlPlaneAppConfig([], {
        AUTOCATALYST_FAKE_MODE: '1',
        AUTOCATALYST_FAKE_STATE_DIR: '/var/fake-state'
      });
      expect(config.fakeMode).toEqual({ enabled: true, stateDir: '/var/fake-state' });
    });

    it('lets explicit settings override fake defaults', () => {
      const config = readControlPlaneAppConfig(
        ['--fake-mode', '--fake-state-dir', '/tmp/fake', '--port', '5555', '--bearer-token', 'custom-token'],
        { CONTROL_PLANE_MASTER_SECRET: 'custom-secret', CONTROL_PLANE_DATABASE_PATH: '/custom/db.sqlite' }
      );
      expect(config.port).toBe(5555);
      expect(config.bearerToken).toBe('custom-token');
      expect(config.masterSecret).toBe('custom-secret');
      expect(config.databasePath).toBe('/custom/db.sqlite');
    });

    it('rejects fake mode combined with --real-dispatch', () => {
      expect(() => readControlPlaneAppConfig(['--fake-mode', '--real-dispatch'], {})).toThrow(
        'Fake mode owns dispatch and provider adapter selection; remove --real-dispatch / AUTOCATALYST_REAL_DISPATCH.'
      );
    });

    it('rejects fake mode combined with AUTOCATALYST_REAL_DISPATCH', () => {
      expect(() => readControlPlaneAppConfig([], { AUTOCATALYST_FAKE_MODE: 'true', AUTOCATALYST_REAL_DISPATCH: 'true' })).toThrow(
        'Fake mode owns dispatch and provider adapter selection; remove --real-dispatch / AUTOCATALYST_REAL_DISPATCH.'
      );
    });

    it('rejects fake mode combined with --default-provider-profile-id', () => {
      expect(() => readControlPlaneAppConfig(['--fake-mode', '--default-provider-profile-id', 'cfg_1'], {})).toThrow(
        'Fake mode owns dispatch and provider adapter selection; remove --default-provider-profile-id / AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID.'
      );
    });

    it('rejects fake mode combined with AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID', () => {
      expect(() => readControlPlaneAppConfig([], { AUTOCATALYST_FAKE_MODE: 'true', AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID: 'cfg_1' })).toThrow(
        'Fake mode owns dispatch and provider adapter selection; remove --default-provider-profile-id / AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID.'
      );
    });
  });

  describe('client directory', () => {
    let clientDir: string;

    const baseEnv = {
      CONTROL_PLANE_PORT: '4300',
      CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
      CONTROL_PLANE_BEARER_TOKEN: 'token',
      CONTROL_PLANE_MASTER_SECRET: 'secret'
    };

    beforeEach(async () => {
      clientDir = await mkdtemp(join(tmpdir(), 'ac-client-dir-'));
      await writeFile(join(clientDir, 'index.html'), '<!doctype html><title>fixture</title>', 'utf-8');
    });

    afterEach(async () => {
      await rm(clientDir, { recursive: true, force: true });
    });

    it('leaves clientDirectory undefined and performs no validation when unset', () => {
      expect(readControlPlaneAppConfig([], { ...baseEnv }).clientDirectory).toBeUndefined();
    });

    it('reads an absolute client directory from AUTOCATALYST_CLIENT_DIR', () => {
      expect(
        readControlPlaneAppConfig([], { ...baseEnv, AUTOCATALYST_CLIENT_DIR: clientDir }).clientDirectory
      ).toBe(clientDir);
    });

    it('lets --client-dir take precedence over AUTOCATALYST_CLIENT_DIR', async () => {
      const flagDir = await mkdtemp(join(tmpdir(), 'ac-client-flag-'));
      await writeFile(join(flagDir, 'index.html'), '<!doctype html>', 'utf-8');
      try {
        expect(
          readControlPlaneAppConfig(['--client-dir', flagDir], {
            ...baseEnv,
            AUTOCATALYST_CLIENT_DIR: clientDir
          }).clientDirectory
        ).toBe(flagDir);
      } finally {
        await rm(flagDir, { recursive: true, force: true });
      }
    });

    it('resolves a relative client directory against process.cwd()', () => {
      const relativeDir = relative(process.cwd(), clientDir);
      expect(
        readControlPlaneAppConfig(['--client-dir', relativeDir], { ...baseEnv }).clientDirectory
      ).toBe(clientDir);
    });

    it('is also parsed in fake mode', () => {
      const config = readControlPlaneAppConfig(['--fake-mode', '--fake-state-dir', '/tmp/fake'], {
        AUTOCATALYST_CLIENT_DIR: clientDir
      });
      expect(config.fakeMode).toEqual({ enabled: true, stateDir: '/tmp/fake' });
      expect(config.clientDirectory).toBe(clientDir);
    });

    it('throws when the configured directory does not exist', () => {
      expect(() =>
        readControlPlaneAppConfig([], { ...baseEnv, AUTOCATALYST_CLIENT_DIR: join(clientDir, 'nope') })
      ).toThrow(/does not exist/u);
    });

    it('throws when the configured path is not a directory', async () => {
      const filePath = join(clientDir, 'index.html');
      expect(() =>
        readControlPlaneAppConfig([], { ...baseEnv, AUTOCATALYST_CLIENT_DIR: filePath })
      ).toThrow(/is not a directory/u);
    });

    it('throws when the directory is missing a root index.html', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'ac-client-empty-'));
      try {
        expect(() =>
          readControlPlaneAppConfig([], { ...baseEnv, AUTOCATALYST_CLIENT_DIR: emptyDir })
        ).toThrow(/missing a root index\.html/u);
      } finally {
        await rm(emptyDir, { recursive: true, force: true });
      }
    });

    it('throws for a blank client directory value', () => {
      expect(() =>
        readControlPlaneAppConfig(['--client-dir', '   '], { ...baseEnv })
      ).toThrow('Client directory must be non-empty when configured.');
    });
  });
});
