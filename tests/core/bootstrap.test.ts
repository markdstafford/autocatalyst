import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { bootstrapConfig } from '../../src/core/config.js';

describe('bootstrapWorkflow', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autocatalyst-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates autocatalyst.yaml when missing', () => {
    bootstrapConfig(tempDir);
    expect(existsSync(join(tempDir, 'autocatalyst.yaml'))).toBe(true);
  });

  it('does not overwrite existing autocatalyst.yaml', () => {
    const existing = 'existing content';
    writeFileSync(join(tempDir, 'autocatalyst.yaml'), existing);
    bootstrapConfig(tempDir);
    expect(readFileSync(join(tempDir, 'autocatalyst.yaml'), 'utf-8')).toBe(existing);
  });

  it('derives repo name from directory path', () => {
    bootstrapConfig(tempDir);
    const content = readFileSync(join(tempDir, 'autocatalyst.yaml'), 'utf-8');
    const dirName = tempDir.split('/').pop()!;
    expect(content).toContain(dirName);
  });

  it('derives repo name from path with trailing slash', () => {
    bootstrapConfig(tempDir + '/');
    const content = readFileSync(join(tempDir, 'autocatalyst.yaml'), 'utf-8');
    const dirName = tempDir.split('/').pop()!;
    expect(content).toContain(dirName);
  });

  it('throws clear error for read-only directory', () => {
    const readOnlyDir = join(tempDir, 'readonly');
    mkdirSync(readOnlyDir);
    chmodSync(readOnlyDir, 0o444);
    expect(() => bootstrapConfig(readOnlyDir)).toThrow();
    chmodSync(readOnlyDir, 0o755); // restore for cleanup
  });
});
