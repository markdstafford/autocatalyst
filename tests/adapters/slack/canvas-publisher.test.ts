// tests/adapters/slack/canvas-publisher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { App } from '@slack/bolt';
import { SlackCanvasPublisher } from '../../../src/adapters/slack/canvas-publisher.js';

const nullDest = { write: () => {} };

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cp-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeSpecFile(content = '# My Spec\n\nsome content'): string {
  const path = join(tempDir, 'feature-test.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeMockApp(canvasId = 'CANVAS001') {
  return {
    client: {
      canvases: {
        create: vi.fn().mockResolvedValue({ canvas_id: canvasId }),
        edit: vi.fn().mockResolvedValue({}),
      },
      chat: {
        postMessage: vi.fn().mockResolvedValue({}),
      },
    },
  };
}

describe('CanvasPublisher.create', () => {
  it('calls canvases.create with spec file content', async () => {
    const mock = makeMockApp();
    const specPath = makeSpecFile('# My Spec\n\ncontent');
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await cp.create('C123', '100.0', specPath);

    expect(mock.client.canvases.create).toHaveBeenCalledWith(
      expect.objectContaining({
        document_content: expect.objectContaining({ markdown: expect.stringContaining('# My Spec') }),
      }),
    );
  });

  it('calls postMessage after canvases.create with channel_id, thread_ts, and canvas link', async () => {
    const mock = makeMockApp('CANVAS999');
    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await cp.create('C123', '100.0', specPath);

    expect(mock.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.0',
        text: expect.stringContaining('CANVAS999'),
      }),
    );
  });

  it('postMessage is called after canvases.create (ordering)', async () => {
    const order: string[] = [];
    const mock = makeMockApp();
    mock.client.canvases.create.mockImplementation(async () => {
      order.push('canvas.create');
      return { canvas_id: 'C1' };
    });
    mock.client.chat.postMessage.mockImplementation(async () => {
      order.push('chat.postMessage');
      return {};
    });

    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });
    await cp.create('C123', '100.0', specPath);

    expect(order.indexOf('canvas.create')).toBeLessThan(order.indexOf('chat.postMessage'));
  });

  it('returns canvas_id from canvases.create response', async () => {
    const mock = makeMockApp('CANVAS_XYZ');
    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    const result = await cp.create('C123', '100.0', specPath);

    expect(result).toBe('CANVAS_XYZ');
  });

  it('throws if canvases.create rejects; postMessage is not called', async () => {
    const mock = makeMockApp();
    mock.client.canvases.create.mockRejectedValue(new Error('canvas API error'));

    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await expect(cp.create('C123', '100.0', specPath)).rejects.toThrow('canvas API error');
    expect(mock.client.chat.postMessage).not.toHaveBeenCalled();
  });
});

describe('CanvasPublisher.update', () => {
  it('calls canvases.edit with canvas_id and updated spec content', async () => {
    const mock = makeMockApp();
    const specPath = makeSpecFile('# Revised Spec\n\nnew content');
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await cp.update('CANVAS001', specPath);

    expect(mock.client.canvases.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas_id: 'CANVAS001',
        changes: expect.arrayContaining([
          expect.objectContaining({
            document_content: expect.objectContaining({ markdown: expect.stringContaining('# Revised Spec') }),
          }),
        ]),
      }),
    );
  });

  it('throws if canvases.edit rejects', async () => {
    const mock = makeMockApp();
    mock.client.canvases.edit.mockRejectedValue(new Error('edit failed'));

    const specPath = makeSpecFile();
    const cp = new SlackCanvasPublisher(mock as unknown as App, { logDestination: nullDest });

    await expect(cp.update('CANVAS001', specPath)).rejects.toThrow('edit failed');
  });
});
