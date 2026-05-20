import { PassThrough } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { ConfigWatcher } from '../../src/core/config-watcher.js';

describe('ConfigWatcher', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autocatalyst-watch-'));
    filePath = join(tempDir, 'WORKFLOW.md');
    writeFileSync(filePath, '---\npolling:\n  interval_ms: 1000\n---\nprompt');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('calls onReload when file changes', async () => {
    const onReload = vi.fn();
    const watcher = new ConfigWatcher(filePath, { onReload, debounceMs: 50 });
    watcher.start();

    // Modify file
    writeFileSync(filePath, '---\npolling:\n  interval_ms: 2000\n---\nprompt');

    // Wait for debounce
    await new Promise(r => setTimeout(r, 200));

    expect(onReload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('debounces rapid changes into one callback', async () => {
    const onReload = vi.fn();
    const watcher = new ConfigWatcher(filePath, { onReload, debounceMs: 100 });
    watcher.start();

    // Rapid changes
    writeFileSync(filePath, '---\npolling:\n  interval_ms: 2000\n---\nprompt');
    writeFileSync(filePath, '---\npolling:\n  interval_ms: 3000\n---\nprompt');
    writeFileSync(filePath, '---\npolling:\n  interval_ms: 4000\n---\nprompt');

    await new Promise(r => setTimeout(r, 300));

    expect(onReload).toHaveBeenCalledTimes(1);
    watcher.stop();
  });

  it('stop() cleans up without errors', () => {
    const watcher = new ConfigWatcher(filePath, { onReload: vi.fn(), debounceMs: 50 });
    watcher.start();
    expect(() => watcher.stop()).not.toThrow();
  });

  it('stop() before start() does not throw', () => {
    const watcher = new ConfigWatcher(filePath, { onReload: vi.fn(), debounceMs: 50 });
    expect(() => watcher.stop()).not.toThrow();
  });
});

describe('ConfigWatcher telemetry', () => {
  it('logs config_watcher.started and stopped', async () => {
    const dest = new PassThrough();
    const lines: string[] = [];
    dest.on('data', (c: Buffer) => c.toString().split('\n').filter(Boolean).forEach(l => lines.push(l)));

    const dir = mkdtempSync(join(tmpdir(), 'ac-test-'));
    const fp = join(dir, 'config.yaml');
    writeFileSync(fp, 'test: true');

    try {
      const watcher = new ConfigWatcher(fp, { onReload: () => {}, logDestination: dest });
      watcher.start();
      watcher.stop();
      dest.end();
      await new Promise(r => dest.on('finish', r));

      const parsed = lines.map(l => JSON.parse(l));
      expect(parsed.find(l => l.event === 'config_watcher.started')).toBeDefined();
      expect(parsed.find(l => l.event === 'config_watcher.stopped')).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
