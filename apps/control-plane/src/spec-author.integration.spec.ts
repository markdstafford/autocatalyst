import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DefaultControlPlaneService,
  DefaultIssueReferenceIntakeResolver,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  RunDispatchQueue,
  StaticIssueTrackerRegistry,
  buildSpecAuthorContext,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint,
  type SpecAuthoringServiceDependencies
} from '@autocatalyst/core';
import {
  createExecutionEntryPoint,
  createExecutionMaterializer,
  createSpecAuthorResultContract,
  createStepResultContractRegistry,
  registerSpecAuthorResultContract,
  SPEC_AUTHOR_SCHEMA_ID
} from '@autocatalyst/execution';
import {
  DrizzleConversationIngressRepository,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { loadSpecAuthorPromptInput, SpecAuthoringContextLoadError } from './spec-authoring-context-loader.js';
import { createSpecAuthoringHarness } from './spec-authoring-harness.spec-helper.js';

const execFileAsync = promisify(execFile);

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args as string[], { cwd, windowsHide: true });
  return result.stdout.trim();
}

function makePassThroughIntakeResolver(): DefaultIssueReferenceIntakeResolver {
  const trackerRegistry = new StaticIssueTrackerRegistry({});
  return new DefaultIssueReferenceIntakeResolver({ registry: trackerRegistry });
}

const owner = {
  id: 'principal_dev_human',
  kind: 'human' as const,
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

// ---------------------------------------------------------------------------
// Spec-author stray-frontmatter production-path proof
// ---------------------------------------------------------------------------
//
// This test drives a full feature run through the real spec.author execution
// boundary using a harness that writes a step-result.json containing unknown
// keys (issue_url, extra), a null optional (implemented_by), a stale date
// (created: '1999-01-01'), and an invalid identity (specced_by: 'some-model').
//
// The normalizer inside createSpecAuthorResultContract must strip all stray
// keys and stamp conformant system-owned frontmatter before the result is
// accepted. The run must reach spec.human_review and the persisted spec must
// not contain any of the stray keys.
// ---------------------------------------------------------------------------

describe('spec-author integration: stray-frontmatter recovery at production boundary', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let reposRoot: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-spec-stray-'));
    upstreamPath = path.join(tempRoot, 'upstream.git');
    const sourcePath = path.join(tempRoot, 'source');
    reposRoot = path.join(tempRoot, 'repos');
    workspacesRoot = path.join(tempRoot, 'workspaces');

    await git(['init', '--bare', upstreamPath]);
    await git(['clone', upstreamPath, sourcePath]);
    await git(['checkout', '-b', 'main'], sourcePath);
    await git(['config', 'user.name', 'Autocatalyst Test'], sourcePath);
    await git(['config', 'user.email', 'test@example.invalid'], sourcePath);
    await fs.writeFile(path.join(sourcePath, 'README.md'), '# Stray Frontmatter Test\n', 'utf8');
    await git(['add', 'README.md'], sourcePath);
    await git(['commit', '-m', 'initial commit'], sourcePath);
    await git(['push', '-u', 'origin', 'main'], sourcePath);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], upstreamPath);

    await fs.mkdir(reposRoot, { recursive: true });
    await fs.mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it(
    'normalizes stray frontmatter: run reaches spec.human_review with conformant specced_by and no unknown keys',
    async () => {
      const database = createSqliteDatabase({ path: ':memory:' });
      await migrateSqliteDatabase(database);
      try {
        const domainRepos = createDrizzleDomainRepositories(database);
        const conversationIngress = new DrizzleConversationIngressRepository(database);

        const upstreamUrl = `file://${upstreamPath}`;
        const project = await domainRepos.projects.create({
          owner,
          tenant: 'tenant_dev',
          displayName: 'Spec Stray Frontmatter Project',
          repoUrl: upstreamUrl,
          hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
          workspaceRootOverride: null,
          issueTrackerSetting: null,
          codeHostSetting: null,
          credentialRefs: []
        });

        const now = new Date().toISOString();
        const seedResult = await conversationIngress.createConversationTopicMessageAndRun({
          conversation: {
            projectId: project.id,
            owner,
            tenant: 'tenant_dev',
            identity: 'spec-stray-frontmatter',
            activeTopicId: null
          },
          topic: {
            owner,
            tenant: 'tenant_dev',
            title: 'Spec Stray Frontmatter Topic',
            kind: 'main'
          },
          message: {
            owner,
            tenant: 'tenant_dev',
            author: owner,
            direction: 'inbound',
            body: 'author a feature spec (stray frontmatter recovery)'
          },
          run: {
            owner,
            tenant: 'tenant_dev',
            workKind: 'feature',
            currentStep: 'spec.author',
            terminal: false
          },
          runStep: {
            phase: 'spec',
            step: 'spec.author',
            role: 'none',
            startedAt: now,
            endedAt: null,
            durationMs: null
          }
        });
        const runId = seedResult.run.id;

        const harness = createSpecAuthoringHarness('stray_frontmatter');

        const inMemoryFiles = new Map<string, string>();
        const sharedFilesystem = {
          writeFile: async (input: { workspaceRepoRoot: string; relativePath: string; contents: string }): Promise<void> => {
            inMemoryFiles.set(`${input.workspaceRepoRoot}::${input.relativePath}`, input.contents);
          },
          readFile: async (input: { workspaceRepoRoot: string; relativePath: string }): Promise<string> => {
            const key = `${input.workspaceRepoRoot}::${input.relativePath}`;
            const value = inMemoryFiles.get(key);
            if (value === undefined) throw new Error(`File not found in in-memory filesystem: ${input.relativePath}`);
            return value;
          }
        };

        const workspaceRootRegistry = new Map<string, string>();

        // Use createSpecAuthorResultContract directly so normalization is applied
        // (strips unknown keys, stamps specced_by: 'autocatalyst', corrects dates)
        const contract = createSpecAuthorResultContract();

        const materializer = createExecutionMaterializer({
          capabilities: { shellAvailable: false, lspAvailable: false }
        });

        const entryPoint = createExecutionEntryPoint({
          runner: harness.runner,
          materialize: async (context) => {
            const env = await materializer.materialize(context);
            if (env.workspace.shape === 'two_roots') {
              workspaceRootRegistry.set(context.run.id, env.workspace.repoRoot);
            }
            return env;
          },
          resultValidation: {
            mode: 'scratch_file',
            contract,
            step: 'spec.author',
            schemaId: SPEC_AUTHOR_SCHEMA_ID,
            resultFile: 'step-result.json'
          }
        });

        const unitOfWork = createExecutionRunUnitOfWork({
          execute: entryPoint,
          resolveContext: async (workInput) => {
            let specAuthorPrompt: string | undefined;
            let specAuthorTaskInputs: Record<string, unknown> | undefined;
            if (
              workInput.run.currentStep === 'spec.author' &&
              (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')
            ) {
              try {
                const promptInput = await loadSpecAuthorPromptInput({
                  runId: workInput.runId,
                  tenantId: workInput.tenant,
                  repositories: domainRepos
                });
                const ctx = buildSpecAuthorContext(promptInput);
                specAuthorPrompt = ctx.prompt;
                specAuthorTaskInputs = ctx.taskInputs;
              } catch (error) {
                if (error instanceof SpecAuthoringContextLoadError) {
                  throw new Error(`spec_authoring_context_load_failed: ${error.code}`);
                }
                throw error;
              }
            }

            return createExecutionContextResolver({
              workspace: (input) => ({
                project,
                roots: { reposRoot, workspacesRoot },
                topicSlug: 'spec-stray-frontmatter',
                shortRunId: input.run.id.slice(0, 8),
                defaultBranch: 'main'
              }),
              secretsAvailable: false,
              ...(specAuthorPrompt !== undefined ? { prompt: specAuthorPrompt } : {}),
              ...(specAuthorTaskInputs !== undefined ? { taskInputs: specAuthorTaskInputs } : {})
            }).resolve(workInput);
          },
          onEvent: () => {}
        });

        const eventBus = new InMemoryRunEventBus();
        const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });

        const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
          artifacts: domainRepos.artifacts,
          filesystem: sharedFilesystem,
          git: { commitFiles: vi.fn().mockResolvedValue({}) },
          clock: () => new Date().toISOString()
        };

        const orchestrator = new DefaultOrchestrator({
          runs: domainRepos.runs,
          conversationIngress,
          events: eventBus,
          dispatchQueue,
          unitOfWork,
          autoDispatch: { enabled: false },
          specAuthoringDependencies,
          resolveWorkspaceContext: async ({ runId: rId }) => {
            const repoRoot = workspaceRootRegistry.get(rId);
            if (repoRoot === undefined) throw new Error(`Workspace root not found for run '${rId}'`);
            return { workspaceRepoRoot: repoRoot, workspaceHandle: rId };
          },
          runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
        });

        const controlPlane = new DefaultControlPlaneService({
          orchestrator,
          runs: domainRepos.runs,
          runSteps: domainRepos.runSteps,
          events: eventBus,
          policy: permissivePolicyDecisionPoint,
          artifacts: domainRepos.artifacts,
          feedback: domainRepos.feedback,
          runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
          workspaceFilesystem: sharedFilesystem,
          feedbackLifecycle: {
            feedback: domainRepos.feedback,
            ids: () => `id_${Math.random().toString(36).slice(2)}`,
            clock: () => new Date().toISOString()
          },
          projects: domainRepos.projects,
          issueReferenceIntakeResolver: makePassThroughIntakeResolver()
        });

        // Execute the spec.author step through the real entry point
        await controlPlane.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: 'tenant_dev',
          runId
        });

        // Run must reach spec.human_review (not terminal)
        const run = await domainRepos.runs.findById(runId);
        expect(run).not.toBeNull();
        expect(run?.currentStep).toBe('spec.human_review');
        expect(run?.terminal).toBe(false);

        // The persisted spec must have conformant frontmatter
        const spec = await controlPlane.getRunSpec({
          principal: hardcodedDevelopmentPrincipal,
          tenant: 'tenant_dev',
          runId
        });

        // System-stamped identity must be 'autocatalyst', not the model-supplied 'some-model'
        expect(spec.markdown).toContain('specced_by: autocatalyst');
        expect(spec.markdown).not.toContain('some-model');

        // Unknown keys must have been stripped by the normalizer
        expect(spec.markdown).not.toContain('issue_url');
        expect(spec.markdown).not.toContain('extra:');
        expect(spec.markdown).not.toContain('implemented_by');

        // Stale date '1999-01-01' must have been overwritten by system stamp
        expect(spec.markdown).not.toContain('1999-01-01');
      } finally {
        database.close();
      }
    },
    60000
  );
});
