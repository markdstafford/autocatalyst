import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { materializeClaudeRuntimeSkillPlugins } from '../../../src/adapters/anthropic/claude-runtime-skill-materializer.js';

function makeRuntimeSkillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-runtime-skills-'));
  writeFileSync(
    join(root, 'manifest.yaml'),
    [
      'providers:',
      '  mm:',
      '    source: vendor/mm',
      '    plugin_manifest: .claude-plugin/plugin.json',
      '    extra_files:',
      '      - hooks/session-start.sh',
      '    skills:',
      '      planning:',
      '        path: skills/planning',
      '        dependencies:',
      '          - mm:writing-guidelines',
      '      issue-triage:',
      '        path: skills/issue-triage',
      '      writing-guidelines:',
      '        path: skills/writing-guidelines',
      '',
    ].join('\n'),
    'utf-8',
  );

  mkdirSync(join(root, 'vendor', 'mm', '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'mm', '.claude-plugin', 'plugin.json'), '{"name":"mm"}', 'utf-8');
  mkdirSync(join(root, 'vendor', 'mm', 'hooks'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'mm', 'hooks', 'session-start.sh'), '#!/usr/bin/env bash\n', 'utf-8');

  for (const skill of ['planning', 'issue-triage', 'writing-guidelines']) {
    const skillDir = join(root, 'vendor', 'mm', 'skills', skill);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${skill}\n---\n`, 'utf-8');
  }

  return root;
}

describe('materializeClaudeRuntimeSkillPlugins', () => {
  test('creates a route-scoped Claude plugin directory from runtime skills', async () => {
    const root = makeRuntimeSkillsRoot();
    const materializedRoot = mkdtempSync(join(tmpdir(), 'ac-materialized-skills-'));

    const plugins = await materializeClaudeRuntimeSkillPlugins(['mm:planning'], {
      rootDir: root,
      materializedRoot,
    });

    expect(plugins).toHaveLength(1);
    expect(plugins[0].type).toBe('local');
    const pluginPath = plugins[0].path;
    expect(readFileSync(join(pluginPath, '.claude-plugin', 'plugin.json'), 'utf-8')).toContain('"name":"mm"');
    expect(existsSync(join(pluginPath, 'hooks', 'session-start.sh'))).toBe(true);
    expect(existsSync(join(pluginPath, 'skills', 'planning', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(pluginPath, 'skills', 'writing-guidelines', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(pluginPath, 'skills', 'issue-triage', 'SKILL.md'))).toBe(false);
  });

  test('returns no plugins when no runtime skills are required', async () => {
    const root = makeRuntimeSkillsRoot();

    await expect(materializeClaudeRuntimeSkillPlugins([], { rootDir: root })).resolves.toEqual([]);
  });
});
