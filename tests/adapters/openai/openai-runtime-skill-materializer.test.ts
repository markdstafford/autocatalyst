import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { materializeOpenAIRuntimeSkills } from '../../../src/adapters/openai/openai-runtime-skill-materializer.js';

function makeRuntimeSkillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-openai-skills-'));
  writeFileSync(
    join(root, 'manifest.yaml'),
    [
      'providers:',
      '  mm:',
      '    source: vendor/mm',
      '    plugin_manifest: .claude-plugin/plugin.json',
      '    skills:',
      '      planning:',
      '        path: skills/planning',
      '  superpowers:',
      '    source: vendor/superpowers',
      '    plugin_manifest: .claude-plugin/plugin.json',
      '    skills:',
      '      writing-plans:',
      '        path: skills/writing-plans',
      '      subagent-driven-development:',
      '        path: skills/subagent-driven-development',
      '',
    ].join('\n'),
    'utf-8',
  );

  mkdirSync(join(root, 'vendor', 'mm', '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'mm', '.claude-plugin', 'plugin.json'), '{"name":"mm"}', 'utf-8');
  mkdirSync(join(root, 'vendor', 'mm', 'skills', 'planning'), { recursive: true });
  writeFileSync(
    join(root, 'vendor', 'mm', 'skills', 'planning', 'SKILL.md'),
    '# Planning skill content',
    'utf-8',
  );

  mkdirSync(join(root, 'vendor', 'superpowers', '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, 'vendor', 'superpowers', '.claude-plugin', 'plugin.json'), '{"name":"superpowers"}', 'utf-8');
  for (const skill of ['writing-plans', 'subagent-driven-development']) {
    mkdirSync(join(root, 'vendor', 'superpowers', 'skills', skill), { recursive: true });
    writeFileSync(
      join(root, 'vendor', 'superpowers', 'skills', skill, 'SKILL.md'),
      `# ${skill} skill content`,
      'utf-8',
    );
  }

  return root;
}

describe('materializeOpenAIRuntimeSkills', () => {
  test('returns [] for empty refs array (no file I/O)', async () => {
    await expect(materializeOpenAIRuntimeSkills([])).resolves.toEqual([]);
  });

  test('returns non-empty capabilities array for a valid skill ref', async () => {
    const root = makeRuntimeSkillsRoot();
    const result = await materializeOpenAIRuntimeSkills(['mm:planning'], { rootDir: root });
    expect(result.length).toBeGreaterThan(0);
  });

  test('returned capabilities contain the SKILL.md content for the resolved skill', async () => {
    const root = makeRuntimeSkillsRoot();
    const result = await materializeOpenAIRuntimeSkills(['mm:planning'], { rootDir: root });
    const capabilityJson = JSON.stringify(result);
    expect(capabilityJson).toContain('Planning skill content');
  });

  test('propagates errors from resolveRuntimeSkillRefs for unknown refs', async () => {
    const root = makeRuntimeSkillsRoot();
    await expect(
      materializeOpenAIRuntimeSkills(['mm:nonexistent'], { rootDir: root }),
    ).rejects.toThrow(/not declared in runtime-skills\/manifest\.yaml/);
  });
});
