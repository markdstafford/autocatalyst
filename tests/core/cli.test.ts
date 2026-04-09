import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/core/cli.js';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

describe('parseArgs', () => {
  it('parses --repo with valid directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    try {
      const result = parseArgs(['--repo', tempDir]);
      expect(result.repoPath).toBe(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves relative --repo path to absolute', () => {
    const result = parseArgs(['--repo', '.']);
    expect(result.repoPath).toMatch(/^\//);
  });

  it('throws for --repo with nonexistent path', () => {
    expect(() => parseArgs(['--repo', '/nonexistent/path'])).toThrow(/does not exist/);
  });

  it('throws for --repo pointing to a file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const filePath = join(tempDir, 'file.txt');
    writeFileSync(filePath, 'content');
    try {
      expect(() => parseArgs(['--repo', filePath])).toThrow(/not a directory/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws when --repo is not provided', () => {
    expect(() => parseArgs([])).toThrow(/--repo/);
  });

  it('returns help flag when --help is passed', () => {
    const result = parseArgs(['--help']);
    expect(result.help).toBe(true);
  });
});
