import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  configurationRecordCollectionPath,
  createConfigurationRecordSuccessStatusCode,
  degradedHealthStatusCode,
  healthResponseSchema,
  type RunnerEvent
} from '@autocatalyst/api-contract';
import {
  buildProviderAdapterKey,
  createExtensionRegistryCatalog,
  type ProviderAdapterFactory,
  type ProviderCompositionResult,
  type RunUnitOfWork
} from '@autocatalyst/core';
import type { ExecutionContext } from '@autocatalyst/api-contract';
import {
  ProviderConfigurationError,
  SPEC_AUTHOR_SCHEMA_ID,
  REVIEWER_RESULT_SCHEMA_ID,
  IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
  PR_FINALIZE_SCHEMA_ID,
  type AgentProviderAdapter,
  type AgentProviderAdapterRegistry,
  type AgentRunnerFactory,
  type AgentRunnerFactoryInput,
  type Runner
} from '@autocatalyst/execution';
import { claudeAgentAdapterId, claudeProviderKind } from '@autocatalyst/claude-agent-adapter';

import {
  createControlPlaneServer,
  createControlPlaneStepResultContractRegistry,
  createDelegatingExecutionEntryPoint,
  createExplicitProfileResolver,
  createNodeWorkspaceFilesystem,
  logProviderCompositionDiagnostics,
  resolveScratchResultValidationConfig,
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

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<T>> => ({ done: true, value: undefined as never })
      };
    }
  };
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
  it('production step-result registry resolves all server-wired contracts', () => {
    const registry = createControlPlaneStepResultContractRegistry({ specAuthorIdentity: 'autocatalyst' });

    expect(registry.resolve({
      step: 'spec.author',
      schemaId: SPEC_AUTHOR_SCHEMA_ID
    })).toMatchObject({ status: 'resolved' });

    expect(registry.resolve({
      step: 'implementation.build',
      schemaId: REVIEWER_RESULT_SCHEMA_ID
    })).toMatchObject({ status: 'resolved' });

    expect(registry.resolve({
      step: 'implementation.build',
      schemaId: IMPLEMENTER_DISPOSITIONS_SCHEMA_ID
    })).toMatchObject({ status: 'resolved' });

    expect(registry.resolve({
      step: 'pr.finalize',
      schemaId: PR_FINALIZE_SCHEMA_ID
    })).toMatchObject({ status: 'resolved' });
  });

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

  it('composes convergence dependencies when realRunnerDispatch and workspaceRoots are configured', async () => {
    await withTempDatabasePath(async (databasePath) => {
      // Seed a provider profile so the registry has something to bind.
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

      const workspacesRoot = await mkdtemp(join(tmpdir(), 'autocatalyst-workspaces-'));
      const reposRoot = await mkdtemp(join(tmpdir(), 'autocatalyst-repos-'));
      try {
        // Booting with realRunnerDispatch enabled AND workspaceRoots configured
        // exercises the convergence engine wiring path. A failure to compose the
        // dispatcher, git port, or convergence engine would throw before listen.
        const app = await createControlPlaneServer({
          databasePath,
          bearerToken: 'token',
          masterSecret: 'correct-master-secret',
          providerAdapters: new Map([[fakeClaudeKey, fakeClaudeAdapterFactory]]),
          realRunnerDispatch: { enabled: true, defaultProviderProfileId: created.id },
          workspaceRoots: { workspacesRoot, reposRoot }
        });

        const response = await app.inject({ method: 'GET', url: '/health' });
        expect(response.statusCode).toBe(200);

        await app.close();
      } finally {
        await rm(workspacesRoot, { recursive: true, force: true });
        await rm(reposRoot, { recursive: true, force: true });
      }
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

describe('createDelegatingExecutionEntryPoint — role routing', () => {
  function makeMinimalContext(taskInputsRole?: string, round = 1): ExecutionContext {
    const inputs: Record<string, unknown> = {};
    if (taskInputsRole !== undefined) {
      inputs['role'] = taskInputsRole;
      inputs['round'] = round;
      inputs['outputContract'] = {
        schemaId: taskInputsRole === 'reviewer' ? REVIEWER_RESULT_SCHEMA_ID : IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
        resultFile: `implementation-build-round-${round}-${taskInputsRole}-result.json`
      };
    }
    return {
      run: { id: 'run_1', workKind: 'feature', currentStep: 'implementation.build', tenant: 'tenant_1' },
      task: {
        prompt: 'test prompt',
        inputs
      },
      workspaceIntent: { shape: 'none' },
      secretBindings: [],
      toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
      skills: { requested: [], resolved: [] },
      capabilityRequirements: {
        shell: { kind: 'bash', required: false },
        paths: { canonicalWorkspacePaths: false },
        lsp: { requested: false }
      }
    };
  }

  it('passes role from task.inputs to factory, overriding resolveRole callback', async () => {
    const capturedInputs: AgentRunnerFactoryInput[] = [];
    const factory: AgentRunnerFactory = {
      createRunner: vi.fn(async (input) => {
        capturedInputs.push(input);
        throw new Error('runner-not-needed');
      })
    };
    const entryPoint = createDelegatingExecutionEntryPoint({
      factory,
      materialize: async () => { throw new Error('materialize-not-needed'); },
      resolveRole: () => 'implementer' // would produce wrong role without the fix
    });

    try {
      for await (const _ of entryPoint.execute({ context: makeMinimalContext('reviewer') })) {
        // consume
      }
    } catch {
      // expected — the mock factory throws
    }

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]?.role).toBe('reviewer');
  });

  it('falls back to resolveRole callback when task.inputs has no role', async () => {
    const capturedInputs: AgentRunnerFactoryInput[] = [];
    const factory: AgentRunnerFactory = {
      createRunner: vi.fn(async (input) => {
        capturedInputs.push(input);
        throw new Error('runner-not-needed');
      })
    };
    const entryPoint = createDelegatingExecutionEntryPoint({
      factory,
      materialize: async () => { throw new Error('materialize-not-needed'); },
      resolveRole: () => 'implementer'
    });

    try {
      for await (const _ of entryPoint.execute({ context: makeMinimalContext() })) {
        // consume
      }
    } catch {
      // expected
    }

    expect(capturedInputs).toHaveLength(1);
    expect(capturedInputs[0]?.role).toBe('implementer');
  });

  it('selects the reviewer result contract and the per-round reviewer file for reviewer sessions', () => {
    const context = makeMinimalContext('reviewer', 2);
    const config = resolveScratchResultValidationConfig(context);

    expect(config).toMatchObject({
      mode: 'scratch_file',
      step: 'implementation.build',
      schemaId: REVIEWER_RESULT_SCHEMA_ID,
      resultFile: 'implementation-build-round-2-reviewer-result.json'
    });
  });

  it('selects the implementer dispositions contract and the per-round implementer file for implementer sessions', () => {
    const context = makeMinimalContext('implementer', 2);
    const config = resolveScratchResultValidationConfig(context);

    expect(config).toMatchObject({
      mode: 'scratch_file',
      step: 'implementation.build',
      schemaId: IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
      resultFile: 'implementation-build-round-2-implementer-result.json'
    });
  });

  it('never crosses the two contracts: reviewer and implementer rounds resolve to distinct files and schemas', () => {
    const reviewer = resolveScratchResultValidationConfig(makeMinimalContext('reviewer', 1));
    const implementer = resolveScratchResultValidationConfig(makeMinimalContext('implementer', 1));

    expect('resultFile' in reviewer && 'resultFile' in implementer).toBe(true);
    if (!('resultFile' in reviewer) || !('resultFile' in implementer)) return;
    expect(reviewer.resultFile).not.toBe(implementer.resultFile);
    expect(reviewer.schemaId).toBe(REVIEWER_RESULT_SCHEMA_ID);
    expect(implementer.schemaId).toBe(IMPLEMENTER_DISPOSITIONS_SCHEMA_ID);
  });

  it('creates a per-run spec.author contract with tracked issue from task inputs', () => {
    const context = makeMinimalContext('implementer');
    context.run.currentStep = 'spec.author';
    context.run.workKind = 'feature';
    context.task.inputs = {
      run: { issueNumber: 76 },
      outputContract: { frontmatter: { trustedSpeccedBy: 'markdstafford' } }
    };

    const config = resolveScratchResultValidationConfig(context, undefined, {
      clock: () => '2026-06-17T12:34:56.000Z'
    });

    expect(config).toMatchObject({
      mode: 'scratch_file',
      step: 'spec.author',
      schemaId: SPEC_AUTHOR_SCHEMA_ID,
      resultFile: 'step-result.json'
    });
    expect('contract' in config).toBe(true);
    if (!('contract' in config) || config.contract === undefined) return;

    const parsed = config.contract.schema.parse({
      kind: 'feature_spec',
      slug: 'server-stamping',
      relativePath: 'context-human/specs/feature-server-stamping.md',
      frontmatter: {},
      body: '# Server stamping\n\nBody.'
    });

    expect(parsed.frontmatter).toMatchObject({
      created: '2026-06-17',
      last_updated: '2026-06-17',
      status: 'draft',
      issue: 76,
      specced_by: 'markdstafford'
    });
  });

  it('omits invented issue when spec.author task inputs have no issue number', () => {
    const context = makeMinimalContext('implementer');
    context.run.currentStep = 'spec.author';
    context.run.workKind = 'enhancement';
    context.task.inputs = {
      outputContract: { frontmatter: { trustedSpeccedBy: 'autocatalyst' } }
    };

    const config = resolveScratchResultValidationConfig(context, undefined, {
      clock: () => '2026-06-18T00:00:00.000Z'
    });

    expect('contract' in config).toBe(true);
    if (!('contract' in config) || config.contract === undefined) return;

    const parsed = config.contract.schema.parse({
      kind: 'enhancement_spec',
      slug: 'no-issue',
      relativePath: 'context-human/specs/enhancement-no-issue.md',
      frontmatter: { issue: 123 },
      body: '# No issue\n\nBody.'
    });

    expect(parsed.frontmatter.issue).toBeUndefined();
    expect(parsed.frontmatter.created).toBe('2026-06-18');
  });
});

describe('createDelegatingExecutionEntryPoint — onWorkspaceRootResolved branchName propagation', () => {
  function makeContext(runId = 'run_1'): ExecutionContext {
    return {
      run: { id: runId, workKind: 'chore', currentStep: 'implementation.build', tenant: 'tenant_1' },
      task: { prompt: 'test prompt', inputs: {} },
      workspaceIntent: { shape: 'none' },
      secretBindings: [],
      toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
      skills: { requested: [], resolved: [] },
      capabilityRequirements: {
        shell: { kind: 'bash', required: false },
        paths: { canonicalWorkspacePaths: false },
        lsp: { requested: false }
      }
    };
  }

  function makeNoopRunner(): Runner {
    return {
      run: () => emptyAsyncIterable<RunnerEvent>(),
      close: async () => ({ status: 'closed' as const })
    };
  }

  it('passes repoRoot and branchName to onWorkspaceRootResolved for two_roots workspaces', async () => {
    const capturedCalls: { runId: string; repoRoot: string; branchName: string }[] = [];

    const materialize = async (ctx: ExecutionContext) => ({
      context: ctx,
      workspace: {
        shape: 'two_roots' as const,
        repoRoot: '/workspace/repo',
        scratchRoot: '/workspace/scratch',
        branchName: 'chore/clean-up-Abc12345',
        provisionedBaseRef: 'origin/main',
        workspaceRoots: ['/workspace/repo', '/workspace/scratch']
      },
      environment: { variables: {}, secretVariableNames: [] },
      toolPolicy: { allowedTools: [], workspaceRoots: ['/workspace/repo', '/workspace/scratch'] },
      skills: { requested: [], resolved: [] },
      capabilities: {
        shell: { kind: 'bash' as const, available: false },
        paths: { repoRoot: '/workspace/repo', scratchRoot: '/workspace/scratch' },
        lsp: { requested: false, available: false }
      }
    });

    // createRunner must succeed so execution reaches materialize inside createExecutionEntryPoint.
    const factory: AgentRunnerFactory = {
      createRunner: vi.fn(async () => makeNoopRunner())
    };

    const entryPoint = createDelegatingExecutionEntryPoint({
      factory,
      materialize,
      onWorkspaceRootResolved: (runId, repoRoot, branchName) => {
        capturedCalls.push({ runId, repoRoot, branchName });
      }
    });

    for await (const _ of entryPoint.execute({ context: makeContext('run_chore_1') })) { /* consume */ }

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]).toEqual({
      runId: 'run_chore_1',
      repoRoot: '/workspace/repo',
      branchName: 'chore/clean-up-Abc12345'
    });
    // Critical: branchName must not be the runId
    expect(capturedCalls[0]?.branchName).not.toBe('run_chore_1');
  });

  it('onWorkspaceRootResolved is NOT called for non-two_roots workspaces', async () => {
    const capturedCalls: unknown[] = [];

    const materialize = async (ctx: ExecutionContext) => ({
      context: ctx,
      workspace: { shape: 'none' as const, workspaceRoots: [] },
      environment: { variables: {}, secretVariableNames: [] },
      toolPolicy: { allowedTools: [], workspaceRoots: [] },
      skills: { requested: [], resolved: [] },
      capabilities: {
        shell: { kind: 'bash' as const, available: false },
        paths: {},
        lsp: { requested: false, available: false }
      }
    });

    const factory: AgentRunnerFactory = {
      createRunner: vi.fn(async () => makeNoopRunner())
    };

    const entryPoint = createDelegatingExecutionEntryPoint({
      factory,
      materialize,
      onWorkspaceRootResolved: (...args) => { capturedCalls.push(args); }
    });

    for await (const _ of entryPoint.execute({ context: makeContext() })) { /* consume */ }

    expect(capturedCalls).toHaveLength(0);
  });

  it('awaits an async onWorkspaceRootResolved callback before runner.run() is called', async () => {
    const order: string[] = [];

    const materialize = async (ctx: ExecutionContext) => {
      order.push('materialize');
      return {
        context: ctx,
        workspace: {
          shape: 'two_roots' as const,
          repoRoot: '/r',
          scratchRoot: '/s',
          branchName: 'feature/test-Abc12345',
          provisionedBaseRef: 'origin/main',
          workspaceRoots: ['/r', '/s']
        },
        environment: { variables: {}, secretVariableNames: [] },
        toolPolicy: { allowedTools: [], workspaceRoots: [] },
        skills: { requested: [], resolved: [] },
        capabilities: {
          shell: { kind: 'bash' as const, available: false },
          paths: { repoRoot: '/r', scratchRoot: '/s' },
          lsp: { requested: false, available: false }
        }
      };
    };

    const factory: AgentRunnerFactory = {
      createRunner: vi.fn(async () => ({
        run: () => {
          order.push('runner-run-started');
          return emptyAsyncIterable<RunnerEvent>();
        },
        close: async () => ({ status: 'closed' as const })
      } satisfies Runner))
    };

    const entryPoint = createDelegatingExecutionEntryPoint({
      factory,
      materialize,
      onWorkspaceRootResolved: async (_runId, _repoRoot, _branchName) => {
        await Promise.resolve(); // yield to event loop
        order.push('callback-resolved');
      }
    });

    for await (const _ of entryPoint.execute({ context: makeContext() })) { /* consume */ }

    // callback-resolved must appear before runner-run-started (callback is awaited before runner runs)
    expect(order).toEqual(['materialize', 'callback-resolved', 'runner-run-started']);
  });
});

describe('createControlPlaneServer — pull request reconciliation ticker', () => {
  it('does not start a ticker when pullRequestReconciliationTicker is not provided', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const reconcileCalls: unknown[] = [];
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        onControlPlaneReady: (service) => {
          // Spy on reconcilePullRequests to detect any calls
          const original = service.reconcilePullRequests.bind(service);
          service.reconcilePullRequests = async (input) => {
            reconcileCalls.push(input);
            return original(input);
          };
        }
      });

      // Give any timer a chance to fire
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reconcileCalls).toHaveLength(0);

      await app.close();
    });
  });

  it('does not start a ticker when pullRequestReconciliationTicker.enabled is false', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const reconcileCalls: unknown[] = [];
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        pullRequestReconciliationTicker: { enabled: false, intervalMs: 10, tenant: 'tenant_dev' },
        onControlPlaneReady: (service) => {
          const original = service.reconcilePullRequests.bind(service);
          service.reconcilePullRequests = async (input) => {
            reconcileCalls.push(input);
            return original(input);
          };
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reconcileCalls).toHaveLength(0);

      await app.close();
    });
  });

  it('starts a ticker and reconciliation is called on interval when enabled', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const reconcileCalls: unknown[] = [];
      const app = await createControlPlaneServer({
        databasePath,
        bearerToken: 'token',
        masterSecret: 'correct-master-secret',
        pullRequestReconciliationTicker: { enabled: true, intervalMs: 30, tenant: 'tenant_dev' },
        onControlPlaneReady: (service) => {
          const original = service.reconcilePullRequests.bind(service);
          service.reconcilePullRequests = async (input) => {
            reconcileCalls.push(input);
            return original(input);
          };
        }
      });

      // Wait for at least one interval to fire
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(reconcileCalls.length).toBeGreaterThanOrEqual(1);

      await app.close();

      // After close, no more calls should be made
      const callsAtClose = reconcileCalls.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(reconcileCalls.length).toBe(callsAtClose);
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
