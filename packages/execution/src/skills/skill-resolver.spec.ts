import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeSkillsCatalog, runtimeSkillsCatalogRoot } from './catalog.js';

const forbiddenSkillRefs = [
  'superpowers:using-git-worktrees',
  'superpowers:finishing-a-development-branch',
  'superpowers:writing-plans',
  'superpowers:brainstorming'
];
const forbiddenInstructionPhrases = [
  'Branch setup',
  'create branch',
  'switch branch',
  'set up worktree',
  'push',
  'merge',
  'open PR',
  'pull request creation'
];

describe('runtime skills catalog assets', () => {
  it('declares exactly the B1 catalog refs and dependency edge', () => {
    expect(runtimeSkillsCatalog.map((entry) => entry.ref)).toEqual(['mm:planning', 'mm:writing-guidelines']);
    expect(runtimeSkillsCatalog.find((entry) => entry.ref === 'mm:planning')?.dependencies).toEqual(['mm:writing-guidelines']);
    expect(runtimeSkillsCatalog.find((entry) => entry.ref === 'mm:writing-guidelines')?.dependencies).toEqual([]);
  });

  it('does not include forbidden git/session-lifecycle skill refs', () => {
    const allRefs = runtimeSkillsCatalog.map((entry) => entry.ref);
    for (const forbidden of forbiddenSkillRefs) {
      expect(allRefs).not.toContain(forbidden);
    }
  });

  it('points every catalog entry at an existing runtime asset root', async () => {
    for (const entry of runtimeSkillsCatalog) {
      const assetRoot = path.resolve(runtimeSkillsCatalogRoot, entry.assetPath);
      const stats = await stat(assetRoot);
      expect(stats.isDirectory()).toBe(true);
      await expect(stat(path.join(assetRoot, 'SKILL.md'))).resolves.toBeDefined();
    }
  });

  it('records source metadata for both B1 skills', async () => {
    const metadata = JSON.parse(await readFile(path.join(runtimeSkillsCatalogRoot, 'assets/mm/SOURCE.json'), 'utf8')) as {
      sources: Array<{ ref: string; sourcePath: string; sha256: string; vendoredPath: string }>;
    };
    expect(metadata.sources.map((source) => source.ref).sort()).toEqual(['mm:planning', 'mm:writing-guidelines']);
    for (const source of metadata.sources) {
      expect(source.sourcePath).toMatch(/^\.agents\/mm:/u);
      expect(source.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(source.vendoredPath).toMatch(/^assets\/mm\//u);
    }
  });

  it('keeps forbidden support skills and lifecycle instructions out of vendored planning asset', async () => {
    const planning = await readFile(path.join(runtimeSkillsCatalogRoot, 'assets/mm/planning/SKILL.md'), 'utf8');
    for (const forbidden of forbiddenSkillRefs) {
      expect(planning).not.toContain(forbidden);
    }
    for (const phrase of forbiddenInstructionPhrases) {
      expect(planning.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
    expect(planning).toContain('mm:writing-guidelines');
    expect(planning).toContain('Autocatalyst handoff boundary');
  });

  it('retains required sections in the vendored planning asset', async () => {
    const planning = await readFile(path.join(runtimeSkillsCatalogRoot, 'assets/mm/planning/SKILL.md'), 'utf8');
    const requiredSections = [
      'Core principles',
      'When to use',
      'Process overview',
      'Shared concepts',
      'Prerequisite checking',
      'Section-by-section checkpoints',
      'Approval gates',
      'Artifact file management',
      'Working with your human',
      'Stage routing',
      'Artifact structure',
      'Roles',
      'Scaling',
      'Writing style'
    ];
    for (const section of requiredSections) {
      expect(planning).toContain(section);
    }
  });

  it('retains required sections in the vendored writing-guidelines asset', async () => {
    const guidelines = await readFile(path.join(runtimeSkillsCatalogRoot, 'assets/mm/writing-guidelines/SKILL.md'), 'utf8');
    const requiredSections = ['When to use', 'Style principles', 'Document-specific guidance', 'Review checklist', 'When to break the rules'];
    for (const section of requiredSections) {
      expect(guidelines).toContain(section);
    }
  });
});
