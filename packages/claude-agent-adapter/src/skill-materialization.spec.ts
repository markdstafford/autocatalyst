import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSkills, runtimeSkillsCatalogRoot } from '@autocatalyst/execution';
import { ClaudeSkillMaterializationError, materializeClaudeSkillPlugins } from './skill-materialization.js';

const skills = [
  { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/plugins/mm/skills/writing-guidelines', dependencies: [] },
  { ref: 'mm:planning', assetPath: 'assets/mm/plugins/mm/skills/planning', dependencies: ['mm:writing-guidelines'] }
];

describe('Claude local skill plugins', () => {
  it('creates one plugin per namespace with manifest, skills, and references; cleanup is idempotent', () => {
    const materialized = materializeClaudeSkillPlugins(skills, runtimeSkillsCatalogRoot);
    try {
      expect(materialized.plugins).toHaveLength(1);
      const plugin = materialized.plugins[0]!;
      expect(plugin.type).toBe('local');
      expect(JSON.parse(readFileSync(path.join(plugin.path, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('mm');
      expect(readFileSync(path.join(plugin.path, 'skills/planning/SKILL.md'), 'utf8')).toContain('name: planning');
      expect(existsSync(path.join(plugin.path, 'skills/planning/references/stages/product-requirements.md'))).toBe(true);
      expect(existsSync(path.join(plugin.path, 'skills/writing-guidelines/SKILL.md'))).toBe(true);
    } finally {
      materialized.cleanup();
      materialized.cleanup();
    }
    expect(existsSync(materialized.plugins[0]!.path)).toBe(false);
  });

  it('creates no files for empty skill intent', () => {
    const result = materializeClaudeSkillPlugins([], runtimeSkillsCatalogRoot);
    expect(result.plugins).toEqual([]);
    result.cleanup();
  });

  it.each([
    { ref: '../escape:planning', assetPath: skills[0]!.assetPath },
    { ref: 'mm:../escape', assetPath: skills[0]!.assetPath },
    { ref: 'mm:planning', assetPath: '../escape' },
    { ref: 'mm:planning', assetPath: '' }
  ])('rejects malformed or escaping skill paths: %s', (skill) => {
    expect(() => materializeClaudeSkillPlugins([{ ...skill, dependencies: [] }], runtimeSkillsCatalogRoot)).toThrow(ClaudeSkillMaterializationError);
  });

  it('rejects symlinked content and missing sources without exposing file contents', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'claude-skill-test-'));
    try {
      mkdirSync(path.join(root, 'skill'));
      writeFileSync(path.join(root, 'secret'), 'sentinel-secret-content');
      symlinkSync(path.join(root, 'secret'), path.join(root, 'skill/link'));
      for (const assetPath of ['skill', 'missing']) {
        expect(() => materializeClaudeSkillPlugins([{ ref: 'mm:planning', assetPath, dependencies: [] }], root))
          .toThrow('Runtime skills could not be materialized as local Claude plugins.');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('retains both supplemental documents relative to the discovered SKILL.md inside the final temporary plugin', async () => {
  const skills = await resolveSkills(['mm:planning']);
  const materialized = materializeClaudeSkillPlugins(skills.resolved, runtimeSkillsCatalogRoot);
  const plugin = materialized.plugins[0]!;
  try {
    const planning = path.join(plugin.path, 'skills/planning');
    expect(existsSync(path.join(planning, 'SKILL.md'))).toBe(true);
    const sourceRoot = path.join(runtimeSkillsCatalogRoot, 'assets/mm');
    const manifest = JSON.parse(readFileSync(path.join(sourceRoot, 'SOURCE.json'), 'utf8')) as { files: Record<string, string> };
    // Resolve the exact paths advertised by the external invocation envelope, from
    // the FINAL discovered skill directory, not the host catalog or an intermediate copy.
    for (const file of Object.values(manifestSupplementalReferences())) {
      const delivered = path.resolve(planning, '../../../..', file);
      expect(existsSync(delivered), delivered).toBe(true);
      expect(createHash('sha256').update(readFileSync(delivered)).digest('hex')).toBe(manifest.files[file]);
    }
    const stagedRoot = path.resolve(plugin.path, '../..');
    expect(stagedRoot).not.toBe(sourceRoot);
    for (const [file, digest] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(path.join(stagedRoot, file))).digest('hex'), file).toBe(digest);
    }
    expect(JSON.parse(readFileSync(path.join(plugin.path, '.claude-plugin/plugin.json'), 'utf8')).version).toBe('2.3.0');
  } finally { materialized.cleanup(); }
  expect(existsSync(plugin.path)).toBe(false);
});

function manifestSupplementalReferences(): Record<string, string> {
  return JSON.parse(readFileSync(path.join(runtimeSkillsCatalogRoot, 'assets/mm/SOURCE.json'), 'utf8')).supplementalReferences;
}
