import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createControlPlaneClient, type ControlPlaneClient } from '@autocatalyst/sdk';

import { readControlPlaneAppConfig } from './config.js';
import { FAKE_FIXTURE_PROJECT } from './fake/constants.js';
import { startControlPlaneServer, type ControlPlaneServerHandle } from './server.js';

const RUN_STATE_TRANSITION = 'run_state_transition';
const FIXTURE_INDEX = '<!doctype html><title>stream-fixture</title>';

interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: unknown;
}

/**
 * Parse SSE frames from a raw fetch `Response` body. Reads until `maxFrames`
 * data-bearing frames are collected or the stream ends, then cancels the reader.
 * Comment frames (lines beginning with `:`) are skipped. The provided `signal`
 * bounds the read so the test fails rather than hangs if frames never arrive.
 */
async function readSseFrames(
  response: Response,
  options: { readonly maxFrames: number; readonly signal: AbortSignal }
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const body = response.body;
  if (body === null) {
    throw new Error('SSE response has no body.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    while (frames.length < options.maxFrames) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator >= 0) {
        const rawFrame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const frame = parseFrame(rawFrame);
        if (frame !== undefined) {
          frames.push(frame);
        }
        if (frames.length >= options.maxFrames) {
          break;
        }
        separator = buffer.indexOf('\n\n');
      }
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
  }
  return frames;
}

function parseFrame(rawFrame: string): SseFrame | undefined {
  let id: string | undefined;
  let event: string | undefined;
  let data: unknown;
  let sawField = false;
  for (const line of rawFrame.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) {
      continue; // blank or comment line
    }
    if (line.startsWith('id:')) {
      id = line.slice(3).trimStart();
      sawField = true;
    } else if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
      sawField = true;
    } else if (line.startsWith('data:')) {
      data = JSON.parse(line.slice(5).trimStart());
      sawField = true;
    }
  }
  return sawField ? { ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}), data } : undefined;
}

async function ensureSecretAndProject(client: ControlPlaneClient): Promise<string> {
  const { projects } = await client.listProjects();
  const existing = projects.find((project) => project.displayName === FAKE_FIXTURE_PROJECT.displayName);
  if (existing !== undefined) {
    return existing.id;
  }
  const { handle } = await client.createSecret({ value: 'fake-token' });
  const project = await client.createProject({
    displayName: FAKE_FIXTURE_PROJECT.displayName,
    repoUrl: FAKE_FIXTURE_PROJECT.repoUrl,
    hostRepository: {
      provider: FAKE_FIXTURE_PROJECT.hostRepository.provider,
      owner: FAKE_FIXTURE_PROJECT.hostRepository.owner,
      name: FAKE_FIXTURE_PROJECT.hostRepository.name
    },
    issueTrackerSetting: { provider: FAKE_FIXTURE_PROJECT.issueTrackerProvider, credentialRef: { id: handle, purpose: 'issue_tracker' } },
    codeHostSetting: { provider: FAKE_FIXTURE_PROJECT.codeHostProvider, credentialRef: { id: handle, purpose: 'code_host' } },
    credentialRefs: [{ id: handle, purpose: 'repo' }]
  });
  return project.id;
}

async function waitForStep(client: ControlPlaneClient, runId: string, step: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const run = await client.getRun(runId);
    last = run.currentStep;
    if (run.currentStep === step) {
      return;
    }
    if (run.currentStep === 'failed' && step !== 'failed') {
      throw new Error(`Run ${runId} failed while waiting for ${step}: ${run.failureReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${step}; last step was ${last}.`);
}

describe('same-origin fake-mode run event stream (production wiring)', () => {
  let handle: ControlPlaneServerHandle | undefined;
  let stateDir: string;
  let clientDir: string;
  let client: ControlPlaneClient;
  let base: string;
  const bearerToken = 'fake-mode-token';

  let runId: string;
  let frameIds: string[] = [];

  beforeAll(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'ac-stream-state-'));
    clientDir = await mkdtemp(join(tmpdir(), 'ac-stream-client-'));
    await writeFile(join(clientDir, 'index.html'), FIXTURE_INDEX, 'utf-8');
    await mkdir(join(clientDir, 'assets'), { recursive: true });
    await writeFile(join(clientDir, 'assets', 'index-Bx3k9aZq.js'), 'export default 1;', 'utf-8');

    const config = readControlPlaneAppConfig(['--port', '0', '--fake-mode', '--fake-state-dir', stateDir], {
      AUTOCATALYST_CLIENT_DIR: clientDir
    });
    handle = await startControlPlaneServer(config);
    base = `http://127.0.0.1:${handle.port}`;
    client = createControlPlaneClient({ baseUrl: base, bearerToken });

    const projectId = await ensureSecretAndProject(client);

    // free_form submission with explicit workKind + no issue → feature run.
    const created = await client.createConversationWithFirstRun({
      projectId,
      identity: 'stream-test',
      topic: { title: 'Stream fixture feature run' },
      submission: { kind: 'free_form', body: 'Build the stream fixture feature.', workKind: 'feature' }
    });
    runId = created.run.id;

    // Pausing at spec.human_review guarantees multiple retained transitions exist.
    await waitForStep(client, runId, 'spec.human_review');
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await rm(clientDir, { recursive: true, force: true }).catch(() => {});
  });

  it('serves the fixture client from the same origin that streams run events', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FIXTURE_INDEX);
  });

  it('streams retained run_state_transition frames via the SDK fetch path', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const { response } = await client.subscribeRunEvents(runId, { replay: 'retained', signal: controller.signal });
      const frames = await readSseFrames(response, { maxFrames: 2, signal: controller.signal });
      expect(frames.length).toBe(2);
      for (const frame of frames) {
        expect(frame.event).toBe(RUN_STATE_TRANSITION);
        expect(typeof frame.id).toBe('string');
        expect((frame.data as { type?: string }).type).toBe(RUN_STATE_TRANSITION);
      }
      frameIds = frames.map((frame) => frame.id as string);
      expect(new Set(frameIds).size).toBe(2); // distinct ids
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }, 30_000);

  it('resumes from a known cursor and returns only later frames', async () => {
    expect(frameIds.length).toBe(2);
    const [firstId, secondId] = frameIds;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const { response } = await client.subscribeRunEvents(runId, {
        replay: 'retained',
        lastEventId: firstId,
        signal: controller.signal
      });
      const resumed = await readSseFrames(response, { maxFrames: 1, signal: controller.signal });
      expect(resumed.length).toBe(1);
      expect(resumed[0].id).toBe(secondId);
      expect(resumed[0].id).not.toBe(firstId);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }, 30_000);

  it('returns a JSON 409 before any SSE bytes for an unknown cursor', async () => {
    const res = await fetch(`${base}/v1/runs/${runId}/events?replay=retained`, {
      headers: { authorization: `Bearer ${bearerToken}`, 'last-event-id': 'made-up-cursor-xyz' }
    });
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(text.startsWith(':')).toBe(false); // no SSE comment/frame preface
    expect(text).not.toContain('event:');
    const body = JSON.parse(text) as { error: { code: string; message: string; lastEventId: string } };
    expect(body.error.code).toBe('run_event_replay_cursor_unknown');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.lastEventId).toBe('made-up-cursor-xyz');
  });

  it('rejects unsupported stream token transports with 401', async () => {
    const noHeader = await fetch(`${base}/v1/runs/${runId}/events`);
    expect(noHeader.status).toBe(401);

    const queryToken = await fetch(`${base}/v1/runs/${runId}/events?access_token=${bearerToken}`);
    expect(queryToken.status).toBe(401);

    const cookieToken = await fetch(`${base}/v1/runs/${runId}/events`, {
      headers: { cookie: `authorization=Bearer ${bearerToken}` }
    });
    expect(cookieToken.status).toBe(401);
  });
});
