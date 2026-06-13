/**
 * Integration test: sanitized failure reason flows end-to-end through the real
 * production composition path.
 *
 * A fake adapter that throws ClassifiedProviderFailureError is injected through
 * the standard realRunnerDispatch + providerAdapters seam. The test asserts:
 *   1. GET /v1/runs/:id returns failureReason: 'provider_auth_failed'
 *   2. GET /v1/runs/:id/events SSE contains matching reason and failureReason
 *   3. No sentinel credential value appears on any serialized surface
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { configurationRecordResponseSchema, createSecretResponseSchema } from '@autocatalyst/api-contract';
import { buildProviderAdapterKey, hardcodedDevelopmentPrincipal, type ControlPlaneService } from '@autocatalyst/core';
import {
  ClassifiedProviderFailureError,
  type AgentProviderAdapter,
  type AgentProviderSession,
  type AgentProviderSessionInput
} from '@autocatalyst/execution';
import { createDrizzleDomainRepositories, createSqliteDatabase, migrateSqliteDatabase } from '@autocatalyst/persistence';

import { createControlPlaneServer, startControlPlaneServer } from './server.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BEARER_TOKEN = 'failure-reason-integration-token';
const MASTER_SECRET = 'failure-reason-integration-secret';

/**
 * A sentinel value that stands in for a real credential. The test asserts
 * this value never appears on any serialized HTTP surface after a failure.
 */
const SENTINEL_CREDENTIAL = 'sk-sentinel-must-not-leak-XYZ789';

// Use the openai provider kind / adapter so that the profile resolves to
// fetch_transport, which avoids the Claude SDK process-launch path and keeps
// the test purely in-process.
const FAKE_PROVIDER_KIND = 'openai' as const;
const FAKE_ADAPTER_ID = 'openai-agents-sdk' as const;

// ---------------------------------------------------------------------------
// Fake adapter that immediately injects ClassifiedProviderFailureError
// ---------------------------------------------------------------------------

/**
 * Creates an AgentProviderAdapter whose startSession throws
 * ClassifiedProviderFailureError('provider_auth_failed') on the first
 * iteration of the events stream.
 *
 * Throwing from within the events generator (rather than synchronously from
 * startSession) exercises the full execution-run-unit-of-work catch path and
 * confirms the error propagates through consumeRunnerEvents.
 */
function createAuthFailingAdapter(): AgentProviderAdapter {
  return {
    providerKind: FAKE_PROVIDER_KIND,
    adapterId: FAKE_ADAPTER_ID,
    supportedConnectionMechanism: 'fetch_transport',
    startSession(_input: AgentProviderSessionInput): AgentProviderSession {
      const error = new ClassifiedProviderFailureError('provider_auth_failed', {
        statusCode: 401,
        errorName: 'AuthenticationError',
        providerKind: FAKE_PROVIDER_KIND
      });
      // Attach a no-op catch to the metadata rejection so Node.js does not
      // surface it as an unhandled rejection before the agent-orchestrator-runner
      // awaits it in its finally block.
      const metadataPromise = Promise.reject<never>(error);
      metadataPromise.catch(() => undefined);
      return {
        events: (async function* (): AsyncIterable<never> {
          throw error;
        })(),
        metadata: metadataPromise
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a temporary SQLite database file and cleans up on completion. */
async function withTempDatabasePath(
  run: (databasePath: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'ac-failure-reason-integration-'));
  try {
    await run(join(directory, 'control-plane.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Seeds a minimal project directly in the database (bypassing the HTTP API)
 * and returns the projectId. Uses the question workKind so no workspace
 * provisioning is required.
 */
async function seedProject(databasePath: string): Promise<{ projectId: string }> {
  const db = createSqliteDatabase({ path: databasePath });
  await migrateSqliteDatabase(db);
  const repos = createDrizzleDomainRepositories(db);
  const project = await repos.projects.create({
    owner: hardcodedDevelopmentPrincipal,
    tenant: hardcodedDevelopmentPrincipal.tenantId,
    displayName: 'Failure Reason Integration Project',
    repoUrl: 'https://example.test',
    hostRepository: { provider: 'github', owner: 'test', name: 'repo' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: []
  });
  db.close();
  return { projectId: project.id };
}

/**
 * Reads SSE frames from the given fetch Response until a `run_state_transition`
 * event is found whose data contains the given targetText, or until the
 * deadline elapses. Aborts the stream when done.
 *
 * Returns all raw SSE body text buffered during reading.
 */
async function collectSseUntilFailureReason(
  response: Response,
  targetText: string,
  controller: AbortController
): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error('SSE response has no body reader');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = setTimeout(() => controller.abort(), 12000);
  try {
    while (!buffer.includes(targetText)) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
    }
  } catch {
    // aborted via deadline or AbortController
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sanitized failure reason — end-to-end acceptance', () => {
  it(
    'drives through the real execution path via tick, surfaces provider_auth_failed on GET and SSE, never leaks sentinel credential',
    { timeout: 30000 },
    async () => {
      await withTempDatabasePath(async (databasePath) => {
        const { projectId } = await seedProject(databasePath);
        const authHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

        // Phase 1: bootstrap — create a secret and configuration record that
        // point to the fake openai adapter. The profile needs a credentialSecretHandle
        // referencing a stored (encrypted) secret so the full credential-resolution
        // path is exercised and the sentinel value can later be checked for leakage.
        const bootstrap = await createControlPlaneServer({
          autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET
        });

        let profileId: string;
        try {
          // Store the sentinel credential as an encrypted secret.
          const secretResp = await bootstrap.inject({
            method: 'POST',
            url: '/v1/secrets',
            headers: authHeaders,
            payload: { value: SENTINEL_CREDENTIAL }
          });
          expect(secretResp.statusCode).toBe(201);
          const { handle: secretHandle } = createSecretResponseSchema.parse(secretResp.json());
          expect(secretHandle).toMatch(/^sec_/u);

          // Create a provider_profile configuration record pointing at the fake
          // openai-agents-sdk adapter, referencing the stored secret.
          const cfgResp = await bootstrap.inject({
            method: 'POST',
            url: '/v1/configuration-records',
            headers: authHeaders,
            payload: {
              kind: 'provider_profile',
              providerKind: FAKE_PROVIDER_KIND,
              adapterId: FAKE_ADAPTER_ID,
              settings: {
                profileName: 'auth-failing-profile',
                credentialSecretHandle: secretHandle,
                endpoint: {
                  baseUrl: 'https://api.example.test'
                }
              }
            }
          });
          expect(cfgResp.statusCode).toBe(201);
          profileId = configurationRecordResponseSchema.parse(cfgResp.json()).id;
        } finally {
          await bootstrap.close();
        }

        // Phase 2: real-dispatch server with the auth-failing adapter injected.
        // autoDispatch is disabled so the test controls dispatch via tick().
        // Uses startControlPlaneServer (real HTTP port) so we can use live
        // fetch() for the SSE stream, which avoids inject's buffering limitation
        // that hangs on long-lived SSE connections.
        let controlPlane: ControlPlaneService | undefined;
        const handle = await startControlPlaneServer({
          port: 0,
          autoDispatch: { enabled: false },
          databasePath,
          bearerToken: BEARER_TOKEN,
          masterSecret: MASTER_SECRET,
          runConcurrency: 1,
          realRunnerDispatch: {
            enabled: true,
            defaultProviderProfileId: profileId
          },
          providerAdapters: new Map([
            [
              buildProviderAdapterKey(FAKE_PROVIDER_KIND, FAKE_ADAPTER_ID),
              () => createAuthFailingAdapter()
            ]
          ]),
          onControlPlaneReady: (service) => { controlPlane = service; }
        });

        try {
          if (controlPlane === undefined) {
            throw new Error('control-plane service was not exposed via onControlPlaneReady');
          }
          const captured = controlPlane;
          const baseUrl = `http://127.0.0.1:${handle.port}`;
          const fetchHeaders = { authorization: `Bearer ${BEARER_TOKEN}` };

          // Create the run via the HTTP conversations API (normal user path).
          const createResp = await fetch(`${baseUrl}/v1/conversations`, {
            method: 'POST',
            headers: { ...fetchHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({
              projectId,
              identity: 'failure-reason-integration-test',
              topic: { title: 'Trigger provider auth failure' },
              submission: { kind: 'free_form', body: 'what is the answer?', workKind: 'question' }
            })
          });
          expect(createResp.status).toBe(201);
          const createBody = (await createResp.json()) as { run: { id: string } };
          const runId = createBody.run.id;
          expect(runId).toMatch(/^run_/u);

          // Open SSE stream BEFORE tick so the failure transition event is
          // observed live (the retained store replays only after a cursor).
          const sseController = new AbortController();
          const sseResp = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
            headers: fetchHeaders,
            signal: sseController.signal
          });
          expect(sseResp.status).toBe(200);
          expect(sseResp.headers.get('content-type')).toMatch(/^text\/event-stream/u);

          // Tick drives the run through intake. The fake adapter throws
          // ClassifiedProviderFailureError from its events generator, caught
          // by createExecutionRunUnitOfWork → { directive: 'fail', reason: 'provider_auth_failed' }.
          await captured.tick({
            principal: hardcodedDevelopmentPrincipal,
            tenant: hardcodedDevelopmentPrincipal.tenantId,
            runId
          });

          // Collect SSE until we see the failure reason, then abort.
          const sseBody = await collectSseUntilFailureReason(
            sseResp,
            '"provider_auth_failed"',
            sseController
          );

          // --- Assertion 1: GET /v1/runs/:id returns failureReason ---
          const getRunResp = await fetch(`${baseUrl}/v1/runs/${runId}`, { headers: fetchHeaders });
          expect(getRunResp.status).toBe(200);
          const runBody = (await getRunResp.json()) as {
            terminal: boolean;
            currentStep: string;
            failureReason?: string;
          };
          expect(runBody.terminal).toBe(true);
          expect(runBody.currentStep).toBe('failed');
          expect(runBody.failureReason).toBe('provider_auth_failed');

          // --- Assertion 2: SSE stream contains the failure reason fields ---
          // The run_state_transition event for the fail transition carries
          // transition.reason and the embedded run.failureReason.
          expect(sseBody).toContain('"reason":"provider_auth_failed"');
          expect(sseBody).toContain('"failureReason":"provider_auth_failed"');

          // --- Assertion 3: sentinel credential must not appear on any surface ---
          // GET /v1/runs/:id body
          const getRunText = JSON.stringify(runBody);
          expect(getRunText).not.toContain(SENTINEL_CREDENTIAL);

          // SSE body
          expect(sseBody).not.toContain(SENTINEL_CREDENTIAL);

          // GET /v1/runs/:id/steps body (step records must not carry raw secrets)
          const stepsResp = await fetch(`${baseUrl}/v1/runs/${runId}/steps`, { headers: fetchHeaders });
          expect(stepsResp.status).toBe(200);
          const stepsText = JSON.stringify(await stepsResp.json());
          expect(stepsText).not.toContain(SENTINEL_CREDENTIAL);
        } finally {
          await handle.close();
        }
      });
    }
  );
});
