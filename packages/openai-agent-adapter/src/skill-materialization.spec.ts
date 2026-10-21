import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { runtimeSkillsCatalogRoot, type MaterializedSkillIntent } from '@autocatalyst/execution';

import { buildOpenAISkillDescriptors, materializeOpenAISkillFiles } from './skill-materialization.js';

const CATALOG_ROOT = '/catalog';

function makeSkillIntent(resolved: MaterializedSkillIntent['resolved']): MaterializedSkillIntent {
  return {
    requested: resolved.map(s => s.ref),
    resolved
  };
}

describe('materializeOpenAISkillFiles', () => {
  it('returns zero mounts, empty manifest, and empty systemPromptHint for empty skills', () => {
    const result = materializeOpenAISkillFiles(makeSkillIntent([]), CATALOG_ROOT);

    expect(result.skillsRoot).toBe('/workspace/skills');
    expect(result.mounts).toHaveLength(0);
    expect(result.manifest).toEqual({});
    expect(result.systemPromptHint).toBe('');
  });

  it('returns correct mounts and manifest for two B1 skills', () => {
    const skills = makeSkillIntent([
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [] },
      { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] }
    ]);

    const result = materializeOpenAISkillFiles(skills, CATALOG_ROOT);

    expect(result.mounts).toHaveLength(2);
    expect(result.manifest).toHaveProperty('mm:planning');
    expect(result.manifest).toHaveProperty('mm:writing-guidelines');
    expect(result.systemPromptHint).toContain('mm:planning');
    expect(result.systemPromptHint).toContain('mm:writing-guidelines');
    expect(result.systemPromptHint).toContain('/workspace/skills/mm/planning/SKILL.md');
    expect(result.systemPromptHint).toContain('/workspace/skills/mm/writing-guidelines/SKILL.md');
  });

  it('uses correct hostPath resolved from catalogRoot and assetPath', () => {
    const skills = makeSkillIntent([
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [] }
    ]);

    const result = materializeOpenAISkillFiles(skills, CATALOG_ROOT);

    const expectedHostPath = path.resolve(CATALOG_ROOT, 'assets/mm/planning');
    expect(result.mounts[0]?.hostPath).toBe(expectedHostPath);
  });

  it('uses correct sandboxPath derived from skill ref', () => {
    const skills = makeSkillIntent([
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [] }
    ]);

    const result = materializeOpenAISkillFiles(skills, CATALOG_ROOT);

    expect(result.mounts[0]?.sandboxPath).toBe('/workspace/skills/mm/planning');
  });

  it('manifest maps refs to sandbox SKILL.md paths', () => {
    const skills = makeSkillIntent([
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [] },
      { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] }
    ]);

    const result = materializeOpenAISkillFiles(skills, CATALOG_ROOT);

    expect(result.manifest['mm:planning']).toBe('/workspace/skills/mm/planning/SKILL.md');
    expect(result.manifest['mm:writing-guidelines']).toBe('/workspace/skills/mm/writing-guidelines/SKILL.md');
  });

  it('does not include secrets or file contents in output', () => {
    const skills = makeSkillIntent([
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [], description: 'Planning skill' }
    ]);

    const result = materializeOpenAISkillFiles(skills, CATALOG_ROOT);
    const serialized = JSON.stringify(result);

    // Output should only contain safe path/ref info, not descriptions or file content
    expect(serialized).not.toContain('Planning skill');
    // Should not contain any secret-looking patterns
    expect(serialized).not.toMatch(/sk-[a-zA-Z0-9]+/);
    expect(serialized).not.toMatch(/password|token|secret|credential/i);
  });

  it('returns skillsRoot of /skills regardless of input', () => {
    const empty = materializeOpenAISkillFiles(makeSkillIntent([]), CATALOG_ROOT);
    const withSkills = materializeOpenAISkillFiles(
      makeSkillIntent([{ ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [] }]),
      CATALOG_ROOT
    );

    expect(empty.skillsRoot).toBe('/workspace/skills');
    expect(withSkills.skillsRoot).toBe('/workspace/skills');
  });

  it('systemPromptHint mentions skills root', () => {
    const skills = makeSkillIntent([
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [] }
    ]);

    const result = materializeOpenAISkillFiles(skills, CATALOG_ROOT);

    expect(result.systemPromptHint).toContain('Skills root: /workspace/skills');
    expect(result.systemPromptHint).toContain('Load and apply the skills declared in your session context');
  });
});


describe('native OpenAI skill descriptor containment', () => {
  it('rejects symlinked references instead of reading files outside the skill', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'openai-skills-test-'));
    try {
      mkdirSync(path.join(root, 'skill/references'), { recursive: true });
      writeFileSync(path.join(root, 'skill/SKILL.md'), '---\nname: example\ndescription: Test skill\n---\nContent');
      writeFileSync(path.join(root, 'secret'), 'private-secret-content');
      symlinkSync(path.join(root, 'secret'), path.join(root, 'skill/references/escaped'));
      expect(() => buildOpenAISkillDescriptors(makeSkillIntent([{ ref: 'mm:example', assetPath: 'skill', dependencies: [] }]), root))
        .toThrow('Runtime skill references must not contain symbolic links.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


it('loads the folded description and nested references from the shipped planning skill', () => {
  const [descriptor] = buildOpenAISkillDescriptors(makeSkillIntent([{ ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: [] }]), runtimeSkillsCatalogRoot);
  expect(descriptor?.description).toContain('Use when');
  expect(descriptor?.description).not.toBe('>');
  expect(Object.keys(descriptor?.references ?? {})).toContain('stages');
});
