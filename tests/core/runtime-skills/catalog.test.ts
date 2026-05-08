import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveRuntimeSkillRefs } from '../../../src/core/runtime-skills/catalog.js';

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
      '      writing-guidelines:',
      '        path: skills/writing-guidelines',
      '  superpowers:',
      '    source: vendor/superpowers',
      '    plugin_manifest: .claude-plugin/plugin.json',
      '    extra_files:',
      '      - LICENSE',
      '    skills:',
      '      subagent-driven-development:',
      '        path: skills/subagent-driven-development',
      '        dependencies:',
      '          - superpowers:requesting-code-review',
      '      requesting-code-review:',
      '        path: skills/requesting-code-review',
      '',
    ].join('\n'),
    'utf-8',
  );

  for (const provider of ['mm', 'superpowers']) {
    mkdirSync(join(root, 'vendor', provider, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, 'vendor', provider, '.claude-plugin', 'plugin.json'), `{"name":"${provider}"}`, 'utf-8');
  }
  mkdirSync(join(root, 'vendor', 'mm', 'hooks'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'mm', 'hooks', 'session-start.sh'), '#!/usr/bin/env bash\n', 'utf-8');
  writeFileSync(join(root, 'vendor', 'superpowers', 'LICENSE'), 'MIT\n', 'utf-8');

  for (const skillDir of [
    join(root, 'vendor', 'mm', 'skills', 'planning'),
    join(root, 'vendor', 'mm', 'skills', 'writing-guidelines'),
    join(root, 'vendor', 'superpowers', 'skills', 'subagent-driven-development'),
    join(root, 'vendor', 'superpowers', 'skills', 'requesting-code-review'),
  ]) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: test\n---\n', 'utf-8');
  }

  return root;
}

describe('resolveRuntimeSkillRefs', () => {
  test('expands dependencies and groups resolved skills by provider', () => {
    const root = makeRuntimeSkillsRoot();

    const resolved = resolveRuntimeSkillRefs(['mm:planning', 'superpowers:subagent-driven-development'], {
      rootDir: root,
    });

    expect(resolved.providers.map(provider => provider.id)).toEqual(['mm', 'superpowers']);
    expect(resolved.providers[0]).toMatchObject({
      id: 'mm',
      sourceDir: join(root, 'vendor', 'mm'),
      pluginManifestPath: join(root, 'vendor', 'mm', '.claude-plugin', 'plugin.json'),
      extraFilePaths: [join(root, 'vendor', 'mm', 'hooks', 'session-start.sh')],
    });
    expect(resolved.providers[0].skills.map(skill => skill.ref)).toEqual([
      'mm:planning',
      'mm:writing-guidelines',
    ]);
    expect(resolved.providers[1].skills.map(skill => skill.ref)).toEqual([
      'superpowers:subagent-driven-development',
      'superpowers:requesting-code-review',
    ]);
  });

  test('throws a clear error for unknown skill refs', () => {
    const root = makeRuntimeSkillsRoot();

    expect(() => resolveRuntimeSkillRefs(['mm:missing'], { rootDir: root })).toThrow(
      'Runtime skill "mm:missing" is not declared in runtime-skills/manifest.yaml',
    );
  });

  test('throws a clear error when declared skill files are missing', () => {
    const root = makeRuntimeSkillsRoot();
    writeFileSync(
      join(root, 'manifest.yaml'),
      [
        'providers:',
        '  mm:',
        '    source: vendor/mm',
        '    plugin_manifest: .claude-plugin/plugin.json',
        '    skills:',
        '      planning:',
        '        path: skills/missing-planning',
        '',
      ].join('\n'),
      'utf-8',
    );

    expect(() => resolveRuntimeSkillRefs(['mm:planning'], { rootDir: root })).toThrow(
      'Runtime skill "mm:planning" is missing SKILL.md',
    );
  });
});
