import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { loadConfig } from '../../src/core/config.js';

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autocatalyst-reload-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads valid config from file path', () => {
    writeFileSync(join(tempDir, 'WORKFLOW.md'), '---\npolling:\n  interval_ms: 5000\n---\nprompt');
    const result = loadConfig(join(tempDir, 'WORKFLOW.md'), {});
    expect(result.config.polling?.interval_ms).toBe(5000);
    expect(result.promptTemplate).toBe('prompt');
    expect(result.filePath).toContain('WORKFLOW.md');
  });

  it('resolves $VAR in loaded config', () => {
    writeFileSync(join(tempDir, 'WORKFLOW.md'), '---\ncustom:\n  token: $MY_TOKEN\n---\nprompt');
    const result = loadConfig(join(tempDir, 'WORKFLOW.md'), { MY_TOKEN: 'secret123' });
    expect((result.config.custom as Record<string, string>).token).toBe('secret123');
  });

  it('throws on invalid WORKFLOW.md', () => {
    writeFileSync(join(tempDir, 'WORKFLOW.md'), 'no frontmatter here');
    expect(() => loadConfig(join(tempDir, 'WORKFLOW.md'), {})).toThrow();
  });

  it('throws on validation failure', () => {
    writeFileSync(join(tempDir, 'WORKFLOW.md'), '---\npolling:\n  interval_ms: -1\n---\nprompt');
    expect(() => loadConfig(join(tempDir, 'WORKFLOW.md'), {})).toThrow(/interval_ms/);
  });
});
