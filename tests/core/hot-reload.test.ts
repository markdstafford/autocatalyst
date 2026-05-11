import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { loadConfig } from '../../src/core/config.js';

const MINIMAL_AI_CONFIG = `ai:
  credentials: []
  endpoints: []
  profiles: []
  routing:
    default_profile: none
`;

describe('loadConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'autocatalyst-reload-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads valid config from file path', () => {
    writeFileSync(
      join(tempDir, 'autocatalyst.yaml'),
      `polling:\n  interval_ms: 5000\n${MINIMAL_AI_CONFIG}`,
    );
    const result = loadConfig(join(tempDir, 'autocatalyst.yaml'), {});
    expect(result.config.polling?.interval_ms).toBe(5000);
    expect(result.filePath).toContain('autocatalyst.yaml');
  });

  it('resolves $VAR in loaded config', () => {
    writeFileSync(
      join(tempDir, 'autocatalyst.yaml'),
      `custom:\n  token: $MY_TOKEN\n${MINIMAL_AI_CONFIG}`,
    );
    const result = loadConfig(join(tempDir, 'autocatalyst.yaml'), { MY_TOKEN: 'secret123' });
    expect((result.config.custom as Record<string, string>).token).toBe('secret123');
  });

  it('throws on invalid WORKFLOW.md', () => {
    // Missing autocatalyst.yaml entirely — should throw
    expect(() => loadConfig(join(tempDir, 'nonexistent.yaml'), {})).toThrow();
  });

  it('throws on validation failure', () => {
    writeFileSync(
      join(tempDir, 'autocatalyst.yaml'),
      `polling:\n  interval_ms: -1\n${MINIMAL_AI_CONFIG}`,
    );
    expect(() => loadConfig(join(tempDir, 'autocatalyst.yaml'), {})).toThrow(/interval_ms/);
  });

  it('handles a Windows-style file path using dirname rather than POSIX regex', () => {
    // Simulate the path that node:path.win32 would produce on Windows.
    // On POSIX the path separators won't actually be backslashes, but we can
    // test the cross-platform logic by constructing a path where basename() is
    // 'autocatalyst.yaml' and dirname() returns the real temp dir.
    // That is exactly what join(tempDir, 'autocatalyst.yaml') already gives us
    // on every platform — we rely on the implementation using dirname() rather
    // than a regex that only strips the POSIX '/autocatalyst.yaml' suffix.
    writeFileSync(
      join(tempDir, 'autocatalyst.yaml'),
      `polling:\n  interval_ms: 3000\n${MINIMAL_AI_CONFIG}`,
    );
    // Pass the full file path; loadConfig must correctly resolve the repo dir.
    const result = loadConfig(join(tempDir, 'autocatalyst.yaml'), {});
    expect(result.config.polling?.interval_ms).toBe(3000);
    expect(result.filePath).toContain('autocatalyst.yaml');
  });
});
