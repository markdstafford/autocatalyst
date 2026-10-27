import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeSkillsCatalog, runtimeSkillsCatalogRoot } from './catalog.js';
import type { RuntimeSkillCatalogEntry } from './catalog.js';
import { validateSkillCatalog, resolveSkills } from './skill-resolver.js';

const forbiddenSkillRefs = [
  'superpowers:using-git-worktrees',
  'superpowers:finishing-a-development-branch',
  'superpowers:writing-plans',
  'superpowers:brainstorming'
];
describe('runtime skills catalog assets', () => {
  it('matches the selection and verifies the canonical enhancement template and nested checkbox format', async () => {
    const root = path.join(runtimeSkillsCatalogRoot, 'assets/mm');
    const manifest = JSON.parse(await readFile(path.join(root, 'SOURCE.json'), 'utf8')) as {
      commit: string;
      skills: Record<string, { path: string; dependencies: string[] }>;
      files: Record<string, string>;
    };
    expect(manifest.commit).toMatch(/^[a-f0-9]{40}$/);
    for (const entry of runtimeSkillsCatalog) {
      expect(entry.assetPath).toBe(`assets/mm/${manifest.skills[entry.ref]?.path}`);
      expect(entry.dependencies).toEqual(manifest.skills[entry.ref]?.dependencies);
    }
    for (const [file, digest] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(await readFile(path.join(root, file))).digest('hex'), file).toBe(digest);
    }
    const planning = path.join(root, 'plugins/mm/skills/planning');
    const template = await readFile(path.join(planning, 'references/templates/enhancement.md'), 'utf8');
    for (const heading of ['Parent feature', 'What', 'Why', 'Design changes', 'Technical changes', 'Task list']) {
      expect(template).toContain(`## ${heading}`);
    }
    expect(template).not.toContain('## Proposed behavior');
    const tasks = await readFile(path.join(planning, 'references/stages/task-decomposition.md'), 'utf8');
    expect(tasks).toContain('  - [ ] **Story:');
    expect(tasks).toContain('    - [ ] **Task:');
    expect(tasks).toContain('      - **Description**:');
    expect(tasks).toContain('      - **Acceptance criteria**:');
    expect(tasks).toContain('        - [ ] Migration file created');
    expect(tasks).toContain('      - **Dependencies**:');
  });

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

  it('retains upstream lifecycle instructions and keeps runtime overrides outside the plugin', async () => {
    const planning = await readFile(path.join(runtimeSkillsCatalogRoot, 'assets/mm/plugins/mm/skills/planning/SKILL.md'), 'utf8');
    expect(planning).toContain('### Branch setup');
    expect(planning).toContain('superpowers:using-git-worktrees');
    expect(planning).not.toContain('Autocatalyst handoff boundary');
  });

  it('retains required sections in the vendored planning asset', async () => {
    const planning = await readFile(path.join(runtimeSkillsCatalogRoot, 'assets/mm/plugins/mm/skills/planning/SKILL.md'), 'utf8');
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
    const guidelines = await readFile(path.join(runtimeSkillsCatalogRoot, 'assets/mm/plugins/mm/skills/writing-guidelines/SKILL.md'), 'utf8');
    const requiredSections = ['When to use', 'Style principles', 'Document-specific guidance', 'Review checklist', 'When to break the rules'];
    for (const section of requiredSections) {
      expect(guidelines).toContain(section);
    }
  });

  it('has a filesystem entry for every references/... path cited in the planning SKILL.md', async () => {
    const skillMdPath = path.join(runtimeSkillsCatalogRoot, 'assets/mm/plugins/mm/skills/planning/SKILL.md');
    const content = await readFile(skillMdPath, 'utf8');
    const planningRoot = path.join(runtimeSkillsCatalogRoot, 'assets/mm/plugins/mm/skills/planning');

    // Extract all `references/...` paths from backtick spans
    const cited = new Set<string>();
    const pattern = /`(references\/[^`\s]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const p = match[1]!;
      // Skip bare directory references (e.g., `references/templates/`)
      if (!p.endsWith('/')) {
        cited.add(p);
      }
    }

    expect(cited.size).toBeGreaterThan(0); // sanity check

    for (const relPath of cited) {
      const fullPath = path.join(planningRoot, relPath);
      await expect(stat(fullPath), `Expected ${relPath} to exist in the vendored catalog`).resolves.toBeDefined();
    }
  });
});

describe('validateSkillCatalog', () => {
  it('accepts the real B1 catalog without error', async () => {
    const result = await validateSkillCatalog({ catalog: runtimeSkillsCatalog, catalogRoot: runtimeSkillsCatalogRoot });
    expect(result.map((e) => e.ref).sort()).toEqual(['mm:planning', 'mm:writing-guidelines']);
    for (const entry of result) {
      expect(typeof entry.absoluteAssetPath).toBe('string');
      expect(path.isAbsolute(entry.absoluteAssetPath)).toBe(true);
    }
  });

  it('rejects a catalog entry with a bad ref format', async () => {
    const catalog = [{ ref: 'not-a-valid-ref', assetPath: 'assets/x', dependencies: [], description: 'x' }] as const;
    await expect(
      validateSkillCatalog({ catalog: catalog as unknown as readonly RuntimeSkillCatalogEntry[], catalogRoot: '/some/path' })
    ).rejects.toMatchObject({ code: 'catalog_entry_malformed' });
  });

  it('rejects a catalog with a duplicate ref', async () => {
    const catalog = [
      { ref: 'a:b', assetPath: 'assets/a/b', dependencies: [], description: 'first' },
      { ref: 'a:b', assetPath: 'assets/a/b2', dependencies: [], description: 'second' }
    ] as const;
    await expect(
      validateSkillCatalog({ catalog: catalog as unknown as readonly RuntimeSkillCatalogEntry[], catalogRoot: '/some/path' })
    ).rejects.toMatchObject({ code: 'catalog_entry_malformed' });
  });

  it('rejects a catalog entry whose dependency is not in the catalog', async () => {
    const catalog = [
      { ref: 'a:b', assetPath: 'assets/a/b', dependencies: ['a:missing'], description: 'b' }
    ] as const;
    await expect(
      validateSkillCatalog({ catalog: catalog as unknown as readonly RuntimeSkillCatalogEntry[], catalogRoot: '/some/path' })
    ).rejects.toMatchObject({ code: 'skill_dependency_missing' });
  });

  it('rejects an asset path that escapes the catalog root', async () => {
    const catalog = [
      { ref: 'a:b', assetPath: '../../etc/passwd', dependencies: [], description: 'b' }
    ] as const;
    await expect(
      validateSkillCatalog({ catalog: catalog as unknown as readonly RuntimeSkillCatalogEntry[], catalogRoot: '/some/path' })
    ).rejects.toMatchObject({ code: 'skill_asset_outside_catalog' });
  });

  it('rejects an asset path that escapes the catalog root via a symlink', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'ac-catalog-sym-'));
    const catalogRoot = path.join(tmp, 'catalog');
    const outside = path.join(tmp, 'outside');
    try {
      await mkdir(catalogRoot, { recursive: true });
      await mkdir(outside, { recursive: true });
      // Create a symlink inside the catalog pointing to an outside directory.
      await symlink(outside, path.join(catalogRoot, 'escape-link'));
      const catalog = [
        { ref: 'a:b', assetPath: 'escape-link', dependencies: [], description: 'b' }
      ] as const;
      await expect(
        validateSkillCatalog({ catalog: catalog as unknown as readonly RuntimeSkillCatalogEntry[], catalogRoot })
      ).rejects.toMatchObject({ code: 'skill_asset_outside_catalog' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('rejects an asset path that does not exist on the filesystem', async () => {
    const catalog = [
      { ref: 'a:b', assetPath: 'assets/does-not-exist-xyz', dependencies: [], description: 'b' }
    ] as const;
    await expect(
      validateSkillCatalog({ catalog: catalog as unknown as readonly RuntimeSkillCatalogEntry[], catalogRoot: '/nonexistent/catalog-root' })
    ).rejects.toMatchObject({ code: 'skill_asset_missing' });
  });
});

describe('resolveSkills', () => {
  it('resolves mm:planning with dep-first ordering (writing-guidelines before planning)', async () => {
    const result = await resolveSkills(['mm:planning']);
    expect(result.requested).toEqual(['mm:planning']);
    expect(result.resolved.map((e) => e.ref)).toEqual(['mm:writing-guidelines', 'mm:planning']);
  });

  it('deduplicates repeated requested refs', async () => {
    const result = await resolveSkills(['mm:planning', 'mm:planning']);
    expect(result.requested).toEqual(['mm:planning']);
    expect(result.resolved.filter((e) => e.ref === 'mm:planning')).toHaveLength(1);
  });

  it('resolves mm:writing-guidelines alone without pulling in mm:planning', async () => {
    const result = await resolveSkills(['mm:writing-guidelines']);
    expect(result.requested).toEqual(['mm:writing-guidelines']);
    expect(result.resolved.map((e) => e.ref)).toEqual(['mm:writing-guidelines']);
  });

  it('throws skill_not_found for a ref absent from the catalog', async () => {
    await expect(resolveSkills(['mm:does-not-exist'])).rejects.toMatchObject({ code: 'skill_not_found' });
  });

  it('throws skill_ref_invalid for a ref that does not match the ref schema', async () => {
    await expect(resolveSkills(['not-a-valid-ref'])).rejects.toMatchObject({ code: 'skill_ref_invalid' });
  });
});
