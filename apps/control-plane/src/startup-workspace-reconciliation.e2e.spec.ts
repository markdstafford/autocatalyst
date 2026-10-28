import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { provisionWorkspace } from '@autocatalyst/execution';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { createControlPlaneServer } from './server.js';

const execFileAsync = promisify(execFile);

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args as string[], { cwd, windowsHide: true });
  return result.stdout.trim();
}

// Replicates the control-plane server's own slug/short-id derivation so the manually
// provisioned run branch matches the branch the startup reconciler will compute.
function deriveTopicSlug(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80);
  return slug.length > 0 ? slug : 'topic';
}

function deriveShortRunId(runId: string): string {
  const withoutPrefix = runId.startsWith('run_') ? runId.slice(4) : runId;
  const compact = withoutPrefix.replace(/[^a-zA-Z0-9]/gu, '');
  return compact.length > 0 ? compact.slice(0, 8) : runId.slice(0, 8);
}

const owner = { id: 'user_1', kind: 'human', tenantId: 'tenant_1', displayName: 'Ada' } as const;
const tenant = 'tenant_1';

describe('startup workspace reconciliation (production server wiring)', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let sourcePath: string;
  let reposRoot: string;
  let workspacesRoot: string;
  let databasePath: string;

  beforeEach(async () => {
    await expect(git(['--version'])).resolves.toMatch(/^git version /);

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'autocatalyst-startup-reconcile-'));
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

  it('recreates a deleted run workspace from its branch on restart without advancing the run', async () => {
    // --- Seed a non-terminal two-root run and provision its workspace on-disk ---
    const seedDatabase = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(seedDatabase);
    const repos = createDrizzleDomainRepositories(seedDatabase);

    const project = await repos.projects.create({
      owner,
      tenant,
      displayName: 'Widgets',
      repoUrl: `file://${upstreamPath}`,
      hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: `file://${upstreamPath}` },
      workspaceRootOverride: null,
      issueTrackerSetting: null,
      codeHostSetting: null,
      credentialRefs: []
    });
    const conversation = await repos.conversations.create({
      projectId: project.id,
      owner,
      tenant,
      identity: 'conv-1',
      activeTopicId: null
    });
    const topic = await repos.topics.create({
      conversationId: conversation.id,
      owner,
      tenant,
      title: 'Recreate Workspace',
      kind: 'main'
    });
    const run = await repos.runs.create({
      topicId: topic.id,
      owner,
      tenant,
      workKind: 'feature',
      currentStep: 'implementation.build',
      terminal: false
    });

    const topicSlug = deriveTopicSlug(topic.title);
    const shortRunId = deriveShortRunId(run.id);

    const provisioned = await provisionWorkspace({
      runId: run.id,
      runKind: 'feature',
      topicSlug,
      shortRunId,
      defaultBranch: 'main',
      project,
      roots: { reposRoot, workspacesRoot }
    });
    expect(provisioned.shape).toBe('two_roots');
    if (provisioned.shape !== 'two_roots') return;

    // Persist workspace metadata exactly as normal dispatch materialization would. Its
    // presence is what marks the run as previously-provisioned and therefore recoverable.
    await repos.runWorkspaceMetadata.upsert({
      runId: run.id,
      workspaceHandle: provisioned.branchName,
      workspaceRepoRoot: provisioned.repoRoot,
      provisionedBaseRef: provisioned.provisionedBaseRef,
      createdAt: new Date().toISOString()
    });

    // Commit a file on the run branch so the durable truth is the branch, not the dir.
    await fs.writeFile(path.join(provisioned.repoRoot, 'work.txt'), 'durable work\n', 'utf8');
    await git(['add', 'work.txt'], provisioned.repoRoot);
    await git(
      ['-c', 'user.name=Autocatalyst Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'add work'],
      provisioned.repoRoot
    );

    // Simulate an operator deleting the on-disk workspace directory.
    await fs.rm(provisioned.runRoot, { recursive: true, force: true });
    await expect(fs.stat(provisioned.repoRoot)).rejects.toThrow();

    seedDatabase.close();

    // --- Restart: creating the server runs startup reconciliation ---
    const app = await createControlPlaneServer({
      databasePath,
      bearerToken: 'token',
      masterSecret: 'correct-master-secret',
      workspaceRoots: { reposRoot, workspacesRoot }
    });

    try {
      // Workspace is restored on the run branch with the committed file present.
      await expect(fs.readFile(path.join(provisioned.repoRoot, 'work.txt'), 'utf8')).resolves.toBe('durable work\n');
      await expect(git(['branch', '--show-current'], provisioned.repoRoot)).resolves.toBe(provisioned.branchName);

      // Scratch root exists and is empty.
      await expect(fs.readdir(provisioned.scratchRoot)).resolves.toEqual([]);
    } finally {
      await app.close();
    }

    // Run remains non-terminal at the same step; startup never advanced or failed it.
    const verifyDatabase = createSqliteDatabase({ path: databasePath });
    try {
      const verifyRepos = createDrizzleDomainRepositories(verifyDatabase);
      const after = await verifyRepos.runs.findById(run.id);
      expect(after).not.toBeNull();
      expect(after?.terminal).toBe(false);
      expect(after?.currentStep).toBe('implementation.build');
      expect(after?.failureReason).toBeUndefined();
    } finally {
      verifyDatabase.close();
    }
  });
});
