import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeSkillsCatalogRoot } from '@autocatalyst/execution';
import { ClaudeSkillMaterializationError, materializeClaudeSkillPlugins } from './skill-materialization.js';

const skills = [
  { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] },
  { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: ['mm:writing-guidelines'] }
];

describe('Claude local skill plugins', () => {
  it('creates one plugin per namespace with manifest, skills, and references; cleanup is idempotent', () => {
    const materialized = materializeClaudeSkillPlugins(skills, runtimeSkillsCatalogRoot);
    try {
      expect(materialized.plugins).toHaveLength(1);
      const plugin = materialized.plugins[0]!;
      expect(plugin.type).toBe('local');
      expect(JSON.parse(readFileSync(path.join(plugin.path, '.claude-plugin/plugin.json'), 'utf8'))).toEqual({ name: 'mm', version: '0.0.0' });
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
