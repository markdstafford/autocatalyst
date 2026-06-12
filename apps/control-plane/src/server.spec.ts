import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  configurationRecordCollectionPath,
  createConfigurationRecordSuccessStatusCode,
  degradedHealthStatusCode,
  healthResponseSchema
} from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  createExtensionRegistryCatalog,
  type ProviderAdapterFactory,
  type ProviderCompositionResult,
  type RunUnitOfWork
} from '@autocatalyst/core';
import {
  ProviderConfigurationError,
  type AgentProviderAdapter,
  type AgentProviderAdapterRegistry,
  type AgentRunnerFactoryInput
} from '@autocatalyst/execution';
import { claudeAgentAdapterId, claudeProviderKind } from '@autocatalyst/claude-agent-adapter';

import {
  createControlPlaneServer,
  createExplicitProfileResolver,
  createNodeWorkspaceFilesystem,
  logProviderCompositionDiagnostics,
  startControlPlaneServer
} from './server.js';

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-control-plane-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('createControlPlaneServer', () => {
  it('rejects empty bearer token', async () => {
    await withTempDatabasePath(async (databasePath) => {
      await expect(
        createControlPlaneServer({ databasePath, bearerToken: '', masterSecret: 'secret' })
      ).rejects.toThrow();
    });
  });

  it('rejects empty master secret', async () => {
    await withTempDatabasePath(async (databasePath) => {
      await expect(
        createControlPlaneServer({ databasePath, bearerToken: 'token', masterSecret: '' })
      ).rejects.toThrow();
    });
  });

  it('creates a Fastify server from options and responds to health', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(healthResponseSchema.parse(response.json())).toEqual({
        status: 'ok',
        database: { status: 'reachable' }
      });

      await app.close();
    });
  });

  it('uses injected health checker when provided', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        health: { isDatabaseReachable: async () => false }
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(degradedHealthStatusCode);

      await app.close();
    });
  });

  it('invokes provider composition during startup with empty results for a fresh database', async () => {
    await withTempDatabasePath(async (databasePath) => {
      let compositionResult: ProviderCompositionResult | undefined;
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        onProviderComposition: async (result) => { compositionResult = result; }
      });

      expect(compositionResult).toEqual({ composed: [], warnings: [], unresolved: [] });

      await app.close();
    });
  });

  it('awaits provider composition callback before startup resolves', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const callbackEvents: string[] = [];
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        onProviderComposition: async () => {
          callbackEvents.push('callback-started');
          await Promise.resolve();
          callbackEvents.push('callback-finished');
        }
      });

      expect(callbackEvents).toEqual(['callback-started', 'callback-finished']);

      await app.close();
    });
  });

  it('accepts runConcurrency option and starts correctly', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        runConcurrency: 1
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });

  it('continues startup when an existing provider profile is unresolved', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const first = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });
      const createdResponse = await first.inject({
        method: 'POST',
        url: configurationRecordCollectionPath,
        headers: { authorization: 'Bearer token' },
        payload: {
          kind: 'provider_profile',
          providerKind: 'model_runner',
          adapterId: 'fake-unresolved-model',
          settings: { profileName: 'default' }
        }
      });
      expect(createdResponse.statusCode).toBe(createConfigurationRecordSuccessStatusCode);
      await first.close();

      let compositionResult: ProviderCompositionResult | undefined;
      const second = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        extensionRegistry: createExtensionRegistryCatalog([
          { providerKind: 'model_runner', adapterId: 'fake-unresolved-model', displayName: 'Fake unresolved', capabilities: [] }
        ]),
        onProviderComposition: (result) => { compositionResult = result; }
      });

      expect(compositionResult?.composed).toEqual([]);
      expect(compositionResult?.warnings).toEqual([]);
      expect(compositionResult?.unresolved).toEqual([
        expect.objectContaining({
          providerKind: 'model_runner',
          adapterId: 'fake-unresolved-model',
          reason: 'adapter_not_found'
        })
      ]);

      await second.close();
    });
  });
});

describe('createControlPlaneServer (real runner dispatch composition)', () => {
  const fakeAdapter: AgentProviderAdapter = {
    providerKind: claudeProviderKind,
    adapterId: claudeAgentAdapterId,
    supportedConnectionMechanism: 'process_environment',
    async startSession() {
      throw new Error('startSession should not be invoked in composition test');
    }
  };
  const fakeClaudeAdapterFactory: ProviderAdapterFactory = () => fakeAdapter;
  const fakeClaudeKey = buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId);

  const stubUnitOfWork: RunUnitOfWork = {
    async run() {
      return { directive: 'fail', reason: 'stub-unit-of-work' };
    }
  };

  it('uses injected unitOfWork without requiring a Claude adapter', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // No realRunnerDispatch, no providerAdapters — and explicit unitOfWork supplied.
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        unitOfWork: stubUnitOfWork
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });

  it('starts without realRunnerDispatch and does not require a Claude adapter', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });

      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });

  it('composes the adapter registry and starts when realRunnerDispatch is enabled', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Seed a provider profile configuration record so the registry has something to bind.
      const seed = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });
      const createdResponse = await seed.inject({
        method: 'POST',
        url: configurationRecordCollectionPath,
        headers: { authorization: 'Bearer token' },
        payload: {
          kind: 'provider_profile',
          providerKind: claudeProviderKind,
          adapterId: claudeAgentAdapterId,
          settings: { profileName: 'default' }
        }
      });
      expect(createdResponse.statusCode).toBe(createConfigurationRecordSuccessStatusCode);
      const created = createdResponse.json() as { id: string };
      await seed.close();

      let compositionResult: ProviderCompositionResult | undefined;
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        // Override the Claude adapter with a fake to avoid loading the real SDK.
        providerAdapters: new Map([[fakeClaudeKey, fakeClaudeAdapterFactory]]),
        realRunnerDispatch: { enabled: true, defaultProviderProfileId: created.id },
        onProviderComposition: (result) => {
          compositionResult = result;
        }
      });

      expect(compositionResult?.composed).toEqual([
        expect.objectContaining({
          providerKind: claudeProviderKind,
          adapterId: claudeAgentAdapterId
        })
      ]);
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);

      await app.close();
    });
  });

  it('createExplicitProfileResolver throws missing_profile when no matching record exists', async () => {
    const registry: AgentProviderAdapterRegistry = new Map([[fakeClaudeKey, fakeAdapter]]);
    const resolver = createExplicitProfileResolver({
      defaultProviderProfileId: 'cfg_does_not_exist',
      listRecords: async () => [],
      registry
    });
    const factoryInput: AgentRunnerFactoryInput = { runId: 'run_1', step: 'plan' };

    await expect(resolver(factoryInput)).rejects.toBeInstanceOf(ProviderConfigurationError);
    await expect(resolver(factoryInput)).rejects.toMatchObject({ code: 'missing_profile' });
  });

  it('createExplicitProfileResolver throws unsupported_adapter when registry lacks the adapter', async () => {
    const registry: AgentProviderAdapterRegistry = new Map();
    const resolver = createExplicitProfileResolver({
      defaultProviderProfileId: 'cfg_1',
      listRecords: async () => [
        {
          id: 'cfg_1',
          kind: 'provider_profile',
          providerKind: claudeProviderKind,
          adapterId: claudeAgentAdapterId,
          settings: { profileName: 'default' },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      registry
    });

    await expect(resolver({ runId: 'run_1', step: 'plan' })).rejects.toMatchObject({
      code: 'unsupported_adapter'
    });
  });
});

describe('startControlPlaneServer', () => {
  it('starts, listens, and closes with correct handle shape', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const handle = await startControlPlaneServer({
        port: 0,
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret'
      });

      expect(handle.port).toBeGreaterThan(0);
      expect(handle.databasePath).toBe(databasePath);
      expect(handle).not.toHaveProperty('app');

      const response = await fetch(`http://127.0.0.1:${handle.port}/health`);
      expect(response.status).toBe(200);

      await handle.close();
    });
  });
});

describe('createNodeWorkspaceFilesystem (symlink containment)', () => {
  async function withTempDirs(
    run: (workspace: string, outside: string) => Promise<void>
  ): Promise<void> {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-ws-'));
    const outside = await mkdtemp(join(tmpdir(), 'ac-outside-'));
    try {
      await run(workspace, outside);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }

  it('rejects writeFile through an intermediate symlink pointing outside the workspace', async () => {
    await withTempDirs(async (workspace, outside) => {
      // Set up context-human/specs as a legitimate directory but with a symlink
      // entry pointing to a directory outside the workspace.
      await mkdir(join(workspace, 'context-human'), { recursive: true });
      await symlink(outside, join(workspace, 'context-human', 'specs'));

      const fs = createNodeWorkspaceFilesystem();
      await expect(
        fs.writeFile({
          workspaceRepoRoot: workspace,
          relativePath: 'context-human/specs/feature-test.md',
          contents: 'should not be written'
        })
      ).rejects.toThrow();
    });
  });

  it('rejects writeFile when context-human is a symlink to outside and specs does not preexist, and creates no directory outside the workspace', async () => {
    await withTempDirs(async (workspace, outside) => {
      // context-human is a symlink to an outside directory; specs does not exist there.
      await symlink(outside, join(workspace, 'context-human'));

      const fs = createNodeWorkspaceFilesystem();
      await expect(
        fs.writeFile({
          workspaceRepoRoot: workspace,
          relativePath: 'context-human/specs/feature-symlink-escape.md',
          contents: 'should not be written'
        })
      ).rejects.toThrow();

      // No directory must have been created inside the outside directory.
      const outsideEntries = await readdir(outside).catch(() => []);
      expect(outsideEntries).toHaveLength(0);
    });
  });

  it('rejects writeFile to a symlink target directly under context-human/specs', async () => {
    await withTempDirs(async (workspace, outside) => {
      await mkdir(join(workspace, 'context-human', 'specs'), { recursive: true });
      // Create a file outside and a symlink inside the workspace pointing to it.
      await writeFile(join(outside, 'target.md'), 'existing content', 'utf-8');
      await symlink(join(outside, 'target.md'), join(workspace, 'context-human', 'specs', 'escaped.md'));

      const fs = createNodeWorkspaceFilesystem();
      await expect(
        fs.writeFile({
          workspaceRepoRoot: workspace,
          relativePath: 'context-human/specs/escaped.md',
          contents: 'should not be written'
        })
      ).rejects.toThrow(/symlink/i);
    });
  });

  it('rejects readFile through a symlink pointing outside the workspace', async () => {
    await withTempDirs(async (workspace, outside) => {
      await mkdir(join(workspace, 'context-human', 'specs'), { recursive: true });
      await writeFile(join(outside, 'secret.txt'), 'sensitive data', 'utf-8');
      await symlink(join(outside, 'secret.txt'), join(workspace, 'context-human', 'specs', 'leaked.md'));

      const fs = createNodeWorkspaceFilesystem();
      await expect(
        fs.readFile({
          workspaceRepoRoot: workspace,
          relativePath: 'context-human/specs/leaked.md'
        })
      ).rejects.toThrow();
    });
  });

  it('permits normal writeFile and readFile for non-symlink paths', async () => {
    await withTempDirs(async (workspace) => {
      await mkdir(join(workspace, 'context-human', 'specs'), { recursive: true });

      const fs = createNodeWorkspaceFilesystem();
      await fs.writeFile({
        workspaceRepoRoot: workspace,
        relativePath: 'context-human/specs/feature-normal.md',
        contents: '---\nstatus: draft\n---\n# Normal spec'
      });
      const contents = await fs.readFile({
        workspaceRepoRoot: workspace,
        relativePath: 'context-human/specs/feature-normal.md'
      });
      expect(contents).toContain('Normal spec');
    });
  });
});

describe('logProviderCompositionDiagnostics', () => {
  it('logs sanitized summary, composed, warning, and unresolved diagnostics', () => {
    const infoMessages: string[] = [];
    const warnMessages: string[] = [];
    logProviderCompositionDiagnostics(
      {
        composed: [
          {
            providerKind: 'model_runner',
            adapterId: 'fake-registered-model',
            configurationRecordId: 'cfg_composed',
            adapter: { secret: 'do-not-log-adapter-object' }
          }
        ],
        warnings: [
          {
            code: 'adapter_not_registered',
            configurationRecordId: 'cfg_warning',
            providerKind: 'model_runner',
            adapterId: 'fake-unregistered-model',
            message: 'contains only sanitized fields'
          }
        ],
        unresolved: [
          {
            configurationRecordId: 'cfg_unresolved',
            providerKind: 'model_runner',
            adapterId: 'fake-unresolved-model',
            reason: 'adapter_not_found',
            message: 'contains only sanitized fields'
          }
        ]
      },
      {
        info: (message) => { infoMessages.push(message); },
        warn: (message) => { warnMessages.push(message); }
      }
    );

    expect(infoMessages).toEqual([
      'Provider composition completed: composed=1 warnings=1 unresolved=1.',
      'Provider composed: configurationRecordId=cfg_composed providerKind=model_runner adapterId=fake-registered-model.'
    ]);
    expect(warnMessages).toEqual([
      'Provider composition warning: configurationRecordId=cfg_warning providerKind=model_runner adapterId=fake-unregistered-model code=adapter_not_registered.',
      'Provider unresolved: configurationRecordId=cfg_unresolved providerKind=model_runner adapterId=fake-unresolved-model reason=adapter_not_found.'
    ]);
    expect([...infoMessages, ...warnMessages].join('\n')).not.toContain('do-not-log-adapter-object');
  });
});
