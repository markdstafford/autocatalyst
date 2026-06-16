/**
 * Opt-in e2e proof for the interactive run reply flow.
 *
 * This proof is opt-in because live provider behavior and credentials are not
 * guaranteed in CI. Deterministic integration coverage in integration specs
 * remains the required default validation.
 *
 * Enable with:
 *   AUTOCATALYST_RUN_LIVE_REPLY_E2E=1
 *
 * All tests are SKIPPED unless the flag is set. CI never sets this variable,
 * so this suite never runs in CI.
 *
 * When enabled, the test uses the real HTTP server wired through
 * `createControlPlaneServer` with `app.inject()` to drive the approve reply
 * path. No live AI provider is required — the approve path is deterministic
 * and exercises only the classification + transition logic.
 *
 * NOTE: Full production-path proof (real AI dispatch after human unpauses) requires
 * real AI providers — see implementation-build-convergence-live.spec.ts for reference.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { runReplyResponseSchema, runSchema } from '@autocatalyst/api-contract';
import { hardcodedDevelopmentPrincipal } from '@autocatalyst/core';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { createControlPlaneServer } from './server.js';

// ---------------------------------------------------------------------------
// Gate: skip everything unless opted in
// ---------------------------------------------------------------------------

const liveReplyE2eEnabled = process.env['AUTOCATALYST_RUN_LIVE_REPLY_E2E'] === '1';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEARER_TOKEN = 'e2e-reply-token';
const MASTER_SECRET = 'e2e-reply-master-secret';
const OWNER = hardcodedDevelopmentPrincipal;
const TENANT = hardcodedDevelopmentPrincipal.tenantId;

// ---------------------------------------------------------------------------
// Spec markdown fixture (minimal valid spec file)
// ---------------------------------------------------------------------------

const SPEC_MARKDOWN = `---
specced_by: autocatalyst
status: implementing
issue: 99
---
# Enhancement: Interactive Reply E2E Fixture

A minimal spec used to exercise the approve reply path in the e2e proof.
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-reply-e2e-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedRunAtSpecHumanReview(
  databasePath: string,
  workspaceRoot: string
): Promise<{ runId: string }> {
  await mkdir(join(workspaceRoot, 'context-human', 'specs'), { recursive: true });
  await writeFile(
    join(workspaceRoot, 'context-human', 'specs', 'reply-e2e-spec.md'),
    SPEC_MARKDOWN,
    'utf-8'
  );

  const seedDb = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(seedDb);
  const repos = createDrizzleDomainRepositories(seedDb);

  const project = await repos.projects.create({
    owner: OWNER,
    tenant: TENANT,
    displayName: 'Reply E2E Project',
    repoUrl: 'https://example.test/reply-e2e',
    hostRepository: { provider: 'github', owner: 'test', name: 'reply-e2e' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });

  const conversation = await repos.conversations.create({
    projectId: project.id,
    owner: OWNER,
    tenant: TENANT,
    identity: 'reply-e2e-conv',
    activeTopicId: null
  });

  const topic = await repos.topics.create({
    conversationId: conversation.id,
    owner: OWNER,
    tenant: TENANT,
    title: 'Reply E2E Topic',
    kind: 'main'
  });

  const run = await repos.runs.create({
    topicId: topic.id,
    owner: OWNER,
    tenant: TENANT,
    workKind: 'enhancement',
    currentStep: 'spec.human_review',
    terminal: false
  });

  await repos.artifacts.create({
    runId: run.id,
    owner: OWNER,
    tenant: TENANT,
    kind: 'enhancement_spec',
    canonicalRecord: 'file',
    location: 'context-human/specs/reply-e2e-spec.md',
    cachedStatus: 'draft',
    publicationRefs: []
  });

  await repos.runWorkspaceMetadata.upsert({
    runId: run.id,
    workspaceHandle: 'reply-e2e-workspace',
    workspaceRepoRoot: workspaceRoot,
    createdAt: new Date().toISOString()
  });

  seedDb.close();
  return { runId: run.id };
}

// ---------------------------------------------------------------------------
// E2E suite
// ---------------------------------------------------------------------------

(liveReplyE2eEnabled ? describe : describe.skip)('interactive run replies e2e', () => {
  it('drives spec approval through HTTP replies', { timeout: 300_000 }, async () => {
    await withTempDatabasePath(async (databasePath) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'reply-e2e-ws-'));
      try {
        // Initialize a git repo so the spec approval finalizer can commit frontmatter.
        await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: tempDir });
        await execFileAsync('git', ['config', 'user.email', 'e2e@example.test'], { cwd: tempDir });
        await execFileAsync('git', ['config', 'user.name', 'Autocatalyst E2E'], { cwd: tempDir });

        // Seed run at spec.human_review
        const { runId } = await seedRunAtSpecHumanReview(databasePath, tempDir);

        // Commit the seeded spec file so the finalizer's commit-on-modify path has a clean base.
        await execFileAsync('git', ['add', '.'], { cwd: tempDir });
        await execFileAsync('git', ['commit', '-m', 'seed spec for e2e'], { cwd: tempDir });

        const app = await createControlPlaneServer({
          autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });
        try {
          // Verify the run starts at spec.human_review
          const getResp = await app.inject({
            method: 'GET',
            url: `/v1/runs/${runId}`,
            headers: { authorization: `Bearer ${BEARER_TOKEN}` }
          });
          expect(getResp.statusCode).toBe(200);
          const runBefore = runSchema.parse(getResp.json());
          expect(runBefore.currentStep).toBe('spec.human_review');
          expect(runBefore.waitingOn).toBe('human');

          // POST { kind: 'approve', body: 'Approved to build.' }
          const replyResp = await app.inject({
            method: 'POST',
            url: `/v1/runs/${runId}/replies`,
            headers: {
              authorization: `Bearer ${BEARER_TOKEN}`,
              'content-type': 'application/json'
            },
            payload: { kind: 'approve', body: 'Approved to build.' }
          });
          expect(replyResp.statusCode).toBe(200);

          const body = runReplyResponseSchema.parse(replyResp.json());

          // Assert classification.directive === 'advance', target === 'artifact'
          expect(body.classification.directive).toBe('advance');
          expect(body.classification.target).toBe('artifact');

          // Assert run transitions away from spec.human_review
          expect(body.run.id).toBe(runId);
          expect(body.run.currentStep).not.toBe('spec.human_review');
        } finally {
          await app.close();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
