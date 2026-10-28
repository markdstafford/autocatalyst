import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { provisionWorkspace } from '@autocatalyst/execution';
import type { RunUnitOfWork } from '@autocatalyst/core';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase,
  type DrizzleDomainRepositories
} from '@autocatalyst/persistence';

import { createControlPlaneServer } from './server.js';

const execFileAsync = promisify(execFile);

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args as string[], { cwd, windowsHide: true });
  return result.stdout.trim();
}

function deriveTopicSlug(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  return slug.length > 0 ? slug : 'topic';
}

function deriveShortRunId(runId: string): string {
  const withoutPrefix = runId.startsWith('run_') ? runId.slice(4) : runId;
  const compact = withoutPrefix.replace(/[^a-zA-Z0-9]/gu, '');
  return compact.length > 0 ? compact.slice(0, 8) : runId.slice(0, 8);
}

// The server's default principal resolves to tenant 'tenant_dev', so seed data must use it
// for the HTTP recovery calls to resolve the run within the caller's tenant.
const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_dev', displayName: 'Ada' } as const;
const tenant = 'tenant_dev';
const authorization = { authorization: 'Bearer token' };

interface SeededFailedRun {
  readonly runId: string;
  readonly repoRoot: string;
  readonly runRoot: string;
  readonly scratchRoot: string;
  readonly branchName: string;
  readonly provisionedBaseRef: string;
}

describe('run recovery (production server wiring)', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let sourcePath: string;
  let reposRoot: string;
  let workspacesRoot: string;
  let databasePath: string;

  beforeEach(async () => {
    await expect(git(['--version'])).resolves.toMatch(/^git version /);
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocatalyst-recovery-'));
    upstreamPath = path.join(tempRoot, 'upstream.git');
    sourcePath = path.join(tempRoot, 'source');
    reposRoot = path.join(tempRoot, 'repos');
    workspacesRoot = path.join(tempRoot, 'workspaces');
    databasePath = path.join(tempRoot, 'control-plane.sqlite');

    await git(['init', '--bare', upstreamPath]);
    await git(['clone', upstreamPath, sourcePath]);
    await git(['checkout', '-b', 'main'], sourcePath);
    await git(['config', 'user.name', 'Autocatalyst Test'], sourcePath);
    await git(['config', 'user.email', 'test@example.invalid'], sourcePath);
    await fs.writeFile(path.join(sourcePath, 'README.md'), '# Example\n', 'utf8');
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

  async function seedFailedRun(options: {
    readonly repos: DrizzleDomainRepositories;
    readonly title: string;
    readonly failedStep: 'implementation.build' | 'spec.author';
    readonly phase: 'implementation' | 'spec';
    readonly commitWork: boolean;
  }): Promise<SeededFailedRun> {
    const { repos } = options;
    const project = await repos.projects.create({
      owner, tenant, displayName: 'Widgets', repoUrl: `file://${upstreamPath}`,
      hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: `file://${upstreamPath}` },
      workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
    });
    const conversation = await repos.conversations.create({ projectId: project.id, owner, tenant, identity: 'conv-1', activeTopicId: null });
    const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant, title: options.title, kind: 'main' });

    const start = await repos.runs.recordRunLifecycleStart({
      run: { topicId: topic.id, owner, tenant, workKind: 'feature', currentStep: options.failedStep, terminal: false },
      runStep: { phase: options.phase, step: options.failedStep, role: 'implementer', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
    });
    const runId = start.run.id;

    const provisioned = await provisionWorkspace({
      runId, runKind: 'feature', topicSlug: deriveTopicSlug(topic.title), shortRunId: deriveShortRunId(runId),
      defaultBranch: 'main', project, roots: { reposRoot, workspacesRoot }
    });
    if (provisioned.shape !== 'two_roots') throw new Error('expected two_roots workspace');

    await repos.runWorkspaceMetadata.upsert({
      runId, workspaceHandle: provisioned.branchName, workspaceRepoRoot: provisioned.repoRoot,
      provisionedBaseRef: provisioned.provisionedBaseRef, createdAt: new Date().toISOString()
    });

    if (options.commitWork) {
      await fs.writeFile(path.join(provisioned.repoRoot, 'work.txt'), 'durable work\n', 'utf8');
      await git(['add', 'work.txt'], provisioned.repoRoot);
      await git(['-c', 'user.name=Autocatalyst Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'add work'], provisioned.repoRoot);
    }

    // Transition the run to the terminal failed state.
    await repos.runs.recordRunStepTransition({
      runId, currentStep: 'failed', terminal: true, failureReason: 'provider_auth_failed',
      sourceRunStepId: start.runStep.id,
      runStep: { phase: null, step: 'failed', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
    });

    return {
      runId, repoRoot: provisioned.repoRoot, runRoot: provisioned.runRoot,
      scratchRoot: provisioned.scratchRoot, branchName: provisioned.branchName,
      provisionedBaseRef: provisioned.provisionedBaseRef
    };
  }

  it('recovers an implementation failure with committed work (omitted mode → resume) and reaches the next step', async () => {
    const seedDatabase = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(seedDatabase);
    const repos = createDrizzleDomainRepositories(seedDatabase);
    const seeded = await seedFailedRun({ repos, title: 'Impl Resume', failedStep: 'implementation.build', phase: 'implementation', commitWork: true });
    seedDatabase.close();

    // A stub unit of work lets the reopened run advance past implementation.build so we can
    // observe that recovery re-dispatches through the existing queue.
    const unitOfWork: RunUnitOfWork = { run: async () => ({ directive: 'advance' as const }) };
    const app = await createControlPlaneServer({
      databasePath, bearerToken: 'token', masterSecret: 'correct-master-secret',
      workspaceRoots: { reposRoot, workspacesRoot }, unitOfWork, autoDispatch: { enabled: true }
    });

    try {
      const response = await app.inject({ method: 'POST', url: `/v1/runs/${seeded.runId}/recover`, headers: authorization, payload: {} });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { mode: string; run: { currentStep: string } };
      expect(body.mode).toBe('resume');

      // The committed file survives on the resumed run branch.
      await expect(fs.readFile(path.join(seeded.repoRoot, 'work.txt'), 'utf8')).resolves.toBe('durable work\n');

      // Earlier failed rows remain in the step history.
      const steps = await app.inject({ method: 'GET', url: `/v1/runs/${seeded.runId}/steps`, headers: authorization });
      const stepList = (steps.json() as { steps: { step: string }[] }).steps;
      expect(stepList.some((s) => s.step === 'failed')).toBe(true);
      expect(stepList.filter((s) => s.step === 'implementation.build').length).toBeGreaterThanOrEqual(2);

      // The reopened run advances past implementation.build via the dispatch queue.
      let reached = false;
      for (let i = 0; i < 50; i += 1) {
        const run = await app.inject({ method: 'GET', url: `/v1/runs/${seeded.runId}`, headers: authorization });
        const current = (run.json() as { currentStep: string }).currentStep;
        if (current !== 'implementation.build' && current !== 'failed') { reached = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(reached).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('starts a spec failure over (omitted mode) on a fresh branch, removing earlier commits', async () => {
    const seedDatabase = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(seedDatabase);
    const repos = createDrizzleDomainRepositories(seedDatabase);
    const seeded = await seedFailedRun({ repos, title: 'Spec StartOver', failedStep: 'spec.author', phase: 'spec', commitWork: true });
    seedDatabase.close();

    const app = await createControlPlaneServer({
      databasePath, bearerToken: 'token', masterSecret: 'correct-master-secret',
      workspaceRoots: { reposRoot, workspacesRoot }, autoDispatch: { enabled: false }
    });

    try {
      const response = await app.inject({ method: 'POST', url: `/v1/runs/${seeded.runId}/recover`, headers: authorization, payload: {} });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { mode: string }).mode).toBe('start_over');
      expect((response.json() as { run: { currentStep: string } }).run.currentStep).toBe('spec.author');

      // The workspace was rebuilt from the default branch; the prior committed file is gone.
      await expect(fs.stat(path.join(seeded.repoRoot, 'work.txt'))).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it('keeps existing files when a spec failure is recovered with mode: resume', async () => {
    const seedDatabase = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(seedDatabase);
    const repos = createDrizzleDomainRepositories(seedDatabase);
    const seeded = await seedFailedRun({ repos, title: 'Spec Resume', failedStep: 'spec.author', phase: 'spec', commitWork: true });
    seedDatabase.close();

    const app = await createControlPlaneServer({
      databasePath, bearerToken: 'token', masterSecret: 'correct-master-secret',
      workspaceRoots: { reposRoot, workspacesRoot }, autoDispatch: { enabled: false }
    });

    try {
      const response = await app.inject({ method: 'POST', url: `/v1/runs/${seeded.runId}/recover`, headers: authorization, payload: { mode: 'resume' } });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { mode: string }).mode).toBe('resume');

      // Explicit resume keeps the existing workspace and its committed file.
      await expect(fs.readFile(path.join(seeded.repoRoot, 'work.txt'), 'utf8')).resolves.toBe('durable work\n');
    } finally {
      await app.close();
    }
  });

  it('removes earlier commits when an implementation failure is recovered with mode: start_over', async () => {
    const seedDatabase = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(seedDatabase);
    const repos = createDrizzleDomainRepositories(seedDatabase);
    const seeded = await seedFailedRun({ repos, title: 'Impl StartOver', failedStep: 'implementation.build', phase: 'implementation', commitWork: true });
    seedDatabase.close();

    const app = await createControlPlaneServer({
      databasePath, bearerToken: 'token', masterSecret: 'correct-master-secret',
      workspaceRoots: { reposRoot, workspacesRoot }, autoDispatch: { enabled: false }
    });

    try {
      const response = await app.inject({ method: 'POST', url: `/v1/runs/${seeded.runId}/recover`, headers: authorization, payload: { mode: 'start_over' } });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { mode: string }).mode).toBe('start_over');

      // Start-over rebuilds from the default branch; the committed file is gone.
      await expect(fs.stat(path.join(seeded.repoRoot, 'work.txt'))).rejects.toThrow();
    } finally {
      await app.close();
    }
  });

  it('returns 409 when recovering a canceled run', async () => {
    const seedDatabase = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(seedDatabase);
    const repos = createDrizzleDomainRepositories(seedDatabase);

    const project = await repos.projects.create({
      owner, tenant, displayName: 'Widgets', repoUrl: `file://${upstreamPath}`,
      hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: `file://${upstreamPath}` },
      workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
    });
    const conversation = await repos.conversations.create({ projectId: project.id, owner, tenant, identity: 'conv-1', activeTopicId: null });
    const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant, title: 'Canceled', kind: 'main' });
    const start = await repos.runs.recordRunLifecycleStart({
      run: { topicId: topic.id, owner, tenant, workKind: 'feature', currentStep: 'spec.author', terminal: false },
      runStep: { phase: 'spec', step: 'spec.author', role: 'implementer', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
    });
    await repos.runs.recordRunStepTransition({
      runId: start.run.id, currentStep: 'canceled', terminal: true,
      sourceRunStepId: start.runStep.id,
      runStep: { phase: null, step: 'canceled', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null }
    });
    const runId = start.run.id;
    seedDatabase.close();

    const app = await createControlPlaneServer({
      databasePath, bearerToken: 'token', masterSecret: 'correct-master-secret',
      workspaceRoots: { reposRoot, workspacesRoot }, autoDispatch: { enabled: false }
    });

    try {
      const response = await app.inject({ method: 'POST', url: `/v1/runs/${runId}/recover`, headers: authorization, payload: {} });
      expect(response.statusCode).toBe(409);
      expect((response.json() as { error: { code: string } }).error.code).toBe('conflict');
    } finally {
      await app.close();
    }
  });
});
