import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runListResponseSchema, runSchema, type Run } from '@autocatalyst/api-contract';
import { hardcodedDevelopmentPrincipal, type ControlPlaneService, type RunUnitOfWork } from '@autocatalyst/core';
import {
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { createControlPlaneServer } from './server.js';

const BEARER_TOKEN = 'run-list-integration-token';
const MASTER_SECRET = 'run-list-integration-master-secret';
const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` } as const;

async function withTempDatabasePath(run: (databasePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'autocatalyst-run-list-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedProject(databasePath: string, displayName: string): Promise<string> {
  const db = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(db);
  const repos = createDrizzleDomainRepositories(db);
  const project = await repos.projects.create({
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    displayName,
    repoUrl: 'https://example.test/repo',
    hostRepository: { provider: 'github', owner: 'test', name: displayName.toLowerCase().replace(/\s+/gu, '-') },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  db.close();
  return project.id;
}

interface CreatedRun {
  readonly id: string;
  readonly run: unknown;
}

async function createRun(
  app: Awaited<ReturnType<typeof createControlPlaneServer>>,
  projectId: string,
  workKind: string,
  issueNumber: number,
  issueTitle: string
): Promise<CreatedRun> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/conversations',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    payload: {
      projectId,
      identity: 'run-list-test',
      topic: { title: `Topic for ${workKind}` },
      submission: {
        kind: 'free_form',
        body: `Please handle ${workKind}`,
        workKind,
        // free_form forwards an inline tracked issue onto the run, giving list rows real
        // issue number/title without a live issue tracker.
        trackedIssue: {
          number: issueNumber,
          title: issueTitle,
          state: 'open',
          url: `https://example.test/issues/${issueNumber}`
        }
      }
    }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { run: { id: string } & Record<string, unknown> };
  return { id: body.run.id, run: body.run };
}

async function listRuns(
  app: Awaited<ReturnType<typeof createControlPlaneServer>>,
  queryString: string
): Promise<Run[]> {
  const response = await app.inject({
    method: 'GET',
    url: queryString === '' ? '/v1/runs' : `/v1/runs?${queryString}`,
    headers: authHeaders
  });
  expect(response.statusCode).toBe(200);
  return runListResponseSchema.parse(response.json()).runs;
}

describe('GET /v1/runs filter + paging production wiring', () => {
  it('creates runs in two projects via POST /v1/conversations and filters by project and status', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const projectA = await seedProject(databasePath, 'Project Alpha');
      const projectB = await seedProject(databasePath, 'Project Beta');

      const app = await createControlPlaneServer({
        autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      try {
        const featureRun = await createRun(app, projectA, 'feature', 101, 'Feature in Alpha');
        await createRun(app, projectA, 'bug', 102, 'Bug in Alpha');
        const enhancementRun = await createRun(app, projectB, 'enhancement', 201, 'Enhancement in Beta');

        // Project filter returns only that project's runs.
        const alphaRuns = await listRuns(app, `projectId=${projectA}`);
        expect(alphaRuns).toHaveLength(2);
        expect(alphaRuns.every((run) => run.projectId === projectA)).toBe(true);
        expect(alphaRuns.some((run) => run.id === enhancementRun.id)).toBe(false);

        const betaRuns = await listRuns(app, `projectId=${projectB}`);
        expect(betaRuns.map((run) => run.id)).toEqual([enhancementRun.id]);
        expect(betaRuns[0]?.projectId).toBe(projectB);

        // status=in_progress returns all three freshly-created (non-terminal) runs.
        const inProgress = await listRuns(app, 'status=in_progress');
        expect(inProgress).toHaveLength(3);

        // Comma-separated statuses OR-combine; none are failed yet, so the set is unchanged.
        const orCombined = await listRuns(app, 'status=failed,in_progress');
        expect(orCombined.map((run) => run.id).sort()).toEqual(inProgress.map((run) => run.id).sort());

        // Every row carries the fields a collection view needs.
        const featureRow = alphaRuns.find((run) => run.id === featureRun.id);
        expect(featureRow).toBeDefined();
        expect(featureRow?.trackedIssue?.number).toBe(101);
        expect(featureRow?.trackedIssue?.title).toBe('Feature in Alpha');
        expect(featureRow?.workKind).toBe('feature');
        expect(featureRow?.status).toBe('in_progress');
        expect(featureRow?.waitingOn).toBe('system');
        expect(featureRow?.projectId).toBe(projectA);
        expect(typeof featureRow?.createdAt).toBe('string');
        expect(() => new Date(featureRow!.createdAt).toISOString()).not.toThrow();
      } finally {
        await app.close();
      }
    });
  });

  it('conversation-creation responses omit status/projectId while GET /v1/runs/:id includes them', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const projectId = await seedProject(databasePath, 'Shape Project');
      const app = await createControlPlaneServer({
        autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET
      });
      try {
        const created = await createRun(app, projectId, 'feature', 301, 'Shape feature');

        // Consumer shape: the create response carries the persisted/orchestrator run shape.
        const createdRun = created.run as Record<string, unknown>;
        expect(createdRun['status']).toBeUndefined();
        expect(createdRun['projectId']).toBeUndefined();

        // The single-run read uses the API mapper, so it carries status and projectId.
        const getResp = await app.inject({ method: 'GET', url: `/v1/runs/${created.id}`, headers: authHeaders });
        expect(getResp.statusCode).toBe(200);
        const got = runSchema.parse(getResp.json());
        expect(got.status).toBe('in_progress');
        expect(got.projectId).toBe(projectId);

        // list/get agree for the same run.
        const listed = (await listRuns(app, `projectId=${projectId}`)).find((run) => run.id === created.id);
        expect(listed?.status).toBe(got.status);
        expect(listed?.projectId).toBe(got.projectId);
        expect(listed?.waitingOn).toBe(got.waitingOn);
      } finally {
        await app.close();
      }
    });
  });

  it('status=failed returns a run driven to failed through the service transition path', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const projectId = await seedProject(databasePath, 'Fail Project');
      let controlPlane: ControlPlaneService | undefined;
      // A unit of work that fails the step drives the run to terminal `failed` through dispatch,
      // never via a direct repository write.
      const unitOfWork: RunUnitOfWork = { run: async () => ({ directive: 'fail', reason: 'intentional_test_failure' }) };
      const app = await createControlPlaneServer({
        autoDispatch: { enabled: false },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        unitOfWork,
        onControlPlaneReady: (service) => { controlPlane = service; }
      });
      try {
        if (controlPlane === undefined) throw new Error('control-plane service not exposed');
        const created = await createRun(app, projectId, 'question', 401, 'Question to fail');

        await controlPlane.tick({
          principal: hardcodedDevelopmentPrincipal,
          tenant: hardcodedDevelopmentPrincipal.tenantId,
          runId: created.id
        });

        const failed = await listRuns(app, 'status=failed');
        const failedRun = failed.find((run) => run.id === created.id);
        expect(failedRun).toBeDefined();
        expect(failedRun?.status).toBe('failed');
        expect(failedRun?.terminal).toBe(true);

        // It also appears under the OR-combined filter and is excluded by status=in_progress.
        const orCombined = await listRuns(app, 'status=failed,in_progress');
        expect(orCombined.some((run) => run.id === created.id)).toBe(true);
        const inProgress = await listRuns(app, 'status=in_progress');
        expect(inProgress.some((run) => run.id === created.id)).toBe(false);
      } finally {
        await app.close();
      }
    });
  });

  it('waitingOn=human returns a run driven to a human gate through the service transition path', async () => {
    await withTempDatabasePath(async (databasePath) => {
      const projectId = await seedProject(databasePath, 'Human Gate Project');
      // Auto-advance each dispatched step; a chore run walks intake → implementation.plan →
      // implementation.build → implementation.human_review (a human gate) with no model calls.
      const unitOfWork: RunUnitOfWork = { run: async () => ({ directive: 'advance' }) };
      const app = await createControlPlaneServer({
        autoDispatch: { enabled: true },
        databasePath,
        bearerToken: BEARER_TOKEN,
        masterSecret: MASTER_SECRET,
        unitOfWork
      });
      try {
        const created = await createRun(app, projectId, 'chore', 501, 'Chore to human gate');

        // Poll until auto-dispatch parks the run at a human-waiting step.
        let parkedWaitingOn: string | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const getResp = await app.inject({ method: 'GET', url: `/v1/runs/${created.id}`, headers: authHeaders });
          const run = runSchema.parse(getResp.json());
          if (run.waitingOn === 'human') {
            parkedWaitingOn = run.waitingOn;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(parkedWaitingOn).toBe('human');

        const humanWaiting = await listRuns(app, 'waitingOn=human');
        const humanRun = humanWaiting.find((run) => run.id === created.id);
        expect(humanRun).toBeDefined();
        expect(humanRun?.waitingOn).toBe('human');
        expect(humanRun?.status).toBe('in_progress');
        expect(humanRun?.projectId).toBe(projectId);
      } finally {
        await app.close();
      }
    });
  });
});
