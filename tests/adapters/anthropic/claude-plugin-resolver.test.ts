import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { resolveClaudeCodePlugins } from '../../../src/adapters/anthropic/claude-plugin-resolver.js';

function makePlugin(root: string, relativePath: string): string {
  const pluginPath = join(root, relativePath);
  mkdirSync(join(pluginPath, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginPath, '.claude-plugin', 'plugin.json'), '{"name":"test"}', 'utf-8');
  return pluginPath;
}

describe('resolveClaudeCodePlugins', () => {
  test('resolves mm and superpowers from the Claude plugin cache using latest versions', () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-plugins-'));
    makePlugin(home, '.claude/plugins/cache/micromanager/mm/2.0.0');
    const mmLatest = makePlugin(home, '.claude/plugins/cache/micromanager/mm/2.1.0');
    const superpowers = makePlugin(home, '.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7');

    expect(resolveClaudeCodePlugins(['mm', 'superpowers'], { homeDir: home })).toEqual([
      { type: 'local', path: mmLatest },
      { type: 'local', path: superpowers },
    ]);
  });

  test('throws a clear error when a required plugin is unavailable', () => {
    const home = mkdtempSync(join(tmpdir(), 'ac-plugins-'));

    expect(() => resolveClaudeCodePlugins(['mm'], { homeDir: home })).toThrow(
      'Required Claude Code plugin "mm" was not found',
    );
  });
});
