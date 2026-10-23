import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedSkill } from '@autocatalyst/api-contract';
import { runtimeSkillsCatalogRoot } from '@autocatalyst/execution';

import {
  CodexSkillMaterializationError,
  materializeCodexSkills
} from './skill-materialization.js';

describe('materializeCodexSkills', () => {
  it('returns empty materialization for no skills', () => {
    const result = materializeCodexSkills([], runtimeSkillsCatalogRoot);
    expect(result.mounts).toHaveLength(0);
    expect(result.delivered).toHaveLength(0);
    expect(result.systemPromptHint).toBe('');
  });

  it('maps resolved skills to mounts with absolute host paths and sandbox paths', () => {
    const skills: ResolvedSkill[] = [
      { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] },
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: ['mm:writing-guidelines'] }
    ];
    const result = materializeCodexSkills(skills, runtimeSkillsCatalogRoot);
    expect(result.delivered).toEqual(['mm:writing-guidelines', 'mm:planning']);
    expect(result.mounts[0]!.hostPath).toBe(path.join(runtimeSkillsCatalogRoot, 'assets/mm/writing-guidelines'));
    expect(result.mounts[0]!.sandboxPath).toBe(path.join(runtimeSkillsCatalogRoot, 'assets/mm/writing-guidelines'));
    expect(result.systemPromptHint).toContain('mm:planning');
    expect(result.systemPromptHint).toContain(runtimeSkillsCatalogRoot);
  });

  it('throws on an empty assetPath', () => {
    const skills: ResolvedSkill[] = [{ ref: 'mm:planning', assetPath: '   ', dependencies: [] }];
    let err: CodexSkillMaterializationError | undefined;
    try {
      materializeCodexSkills(skills, runtimeSkillsCatalogRoot);
    } catch (e) {
      err = e as CodexSkillMaterializationError;
    }
    expect(err).toBeInstanceOf(CodexSkillMaterializationError);
    expect(err?.details?.reason).toBe('empty_asset_path');
  });

  it('throws when an asset path escapes the catalog boundary', () => {
    const skills: ResolvedSkill[] = [{ ref: 'mm:planning', assetPath: '../../etc/passwd', dependencies: [] }];
    let err: CodexSkillMaterializationError | undefined;
    try {
      materializeCodexSkills(skills, runtimeSkillsCatalogRoot);
    } catch (e) {
      err = e as CodexSkillMaterializationError;
    }
    expect(err).toBeInstanceOf(CodexSkillMaterializationError);
    expect(err?.details?.reason).toBe('asset_path_outside_catalog');
  });
});
