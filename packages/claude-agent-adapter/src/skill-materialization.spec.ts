import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedSkill } from '@autocatalyst/api-contract';

import {
  ClaudeSkillMaterializationError,
  materializeClaudeSkillPlugins
} from './skill-materialization.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG_ROOT = '/var/autocatalyst/runtime/skills';
const SECRET_TOKEN = 'sk-ant-secret-99999';
const PROMPT_TEXT = 'Write a comprehensive plan for the feature.';
const WORKSPACE_CONTENT = 'README content from repo';

function makeResolvedSkill(overrides?: Partial<ResolvedSkill>): ResolvedSkill {
  return {
    ref: 'mm:planning',
    assetPath: 'assets/mm/planning',
    dependencies: ['mm:writing-guidelines'],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests: empty skills
// ---------------------------------------------------------------------------

describe('materializeClaudeSkillPlugins — empty skills', () => {
  it('returns [] when no resolved skills are provided', () => {
    const result = materializeClaudeSkillPlugins([], CATALOG_ROOT);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: B1 skills (mm:writing-guidelines + mm:planning)
// ---------------------------------------------------------------------------

describe('materializeClaudeSkillPlugins — B1 skill set', () => {
  it('returns 2 plugin entries for mm:writing-guidelines and mm:planning', () => {
    const skills: ResolvedSkill[] = [
      { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] },
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: ['mm:writing-guidelines'] }
    ];

    const result = materializeClaudeSkillPlugins(skills, CATALOG_ROOT);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'claudecode',
      path: path.resolve(CATALOG_ROOT, 'assets/mm/writing-guidelines')
    });
    expect(result[1]).toEqual({
      type: 'claudecode',
      path: path.resolve(CATALOG_ROOT, 'assets/mm/planning')
    });
  });

  it('uses type "claudecode" for every plugin entry', () => {
    const skills: ResolvedSkill[] = [
      { ref: 'mm:writing-guidelines', assetPath: 'assets/mm/writing-guidelines', dependencies: [] },
      { ref: 'mm:planning', assetPath: 'assets/mm/planning', dependencies: ['mm:writing-guidelines'] }
    ];

    const result = materializeClaudeSkillPlugins(skills, CATALOG_ROOT);

    for (const plugin of result) {
      expect(plugin.type).toBe('claudecode');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: absolute path resolution
// ---------------------------------------------------------------------------

describe('materializeClaudeSkillPlugins — path resolution', () => {
  it('resolves catalog-relative assetPath to an absolute path using catalogRoot', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: 'assets/mm/planning',
      dependencies: []
    };

    const result = materializeClaudeSkillPlugins([skill], CATALOG_ROOT);

    expect(result).toHaveLength(1);
    expect(path.isAbsolute(result[0]!.path)).toBe(true);
    expect(result[0]!.path).toBe(path.join(CATALOG_ROOT, 'assets/mm/planning'));
  });

  it('resolves a nested assetPath correctly', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: 'assets/mm/planning',
      dependencies: []
    };

    const result = materializeClaudeSkillPlugins([skill], '/catalog/root');

    expect(result[0]!.path).toBe('/catalog/root/assets/mm/planning');
  });

  it('handles a single skill entry correctly', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:writing-guidelines',
      assetPath: 'assets/mm/writing-guidelines',
      dependencies: []
    };

    const result = materializeClaudeSkillPlugins([skill], CATALOG_ROOT);

    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(path.resolve(CATALOG_ROOT, 'assets/mm/writing-guidelines'));
  });
});

// ---------------------------------------------------------------------------
// Tests: no secrets, file contents, or prompt text in output
// ---------------------------------------------------------------------------

describe('materializeClaudeSkillPlugins — sanitization', () => {
  it('does not include raw secrets in plugin entries', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: 'assets/mm/planning',
      dependencies: []
    };

    const result = materializeClaudeSkillPlugins([skill], CATALOG_ROOT);
    const serialized = JSON.stringify(result);

    expect(serialized.includes(SECRET_TOKEN)).toBe(false);
  });

  it('does not include raw prompt text in plugin entries', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: 'assets/mm/planning',
      dependencies: []
    };

    const result = materializeClaudeSkillPlugins([skill], CATALOG_ROOT);
    const serialized = JSON.stringify(result);

    expect(serialized.includes(PROMPT_TEXT)).toBe(false);
  });

  it('does not include workspace file contents in plugin entries', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: 'assets/mm/planning',
      dependencies: []
    };

    const result = materializeClaudeSkillPlugins([skill], CATALOG_ROOT);
    const serialized = JSON.stringify(result);

    expect(serialized.includes(WORKSPACE_CONTENT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: ClaudeSkillMaterializationError
// ---------------------------------------------------------------------------

describe('materializeClaudeSkillPlugins — error handling', () => {
  it('throws ClaudeSkillMaterializationError for an empty assetPath', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: '   ',
      dependencies: []
    };

    expect(() => materializeClaudeSkillPlugins([skill], CATALOG_ROOT)).toThrow(
      ClaudeSkillMaterializationError
    );
  });

  it('includes safe details in ClaudeSkillMaterializationError — no file contents', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: '   ',
      dependencies: []
    };

    let caught: ClaudeSkillMaterializationError | undefined;
    try {
      materializeClaudeSkillPlugins([skill], CATALOG_ROOT);
    } catch (err) {
      if (err instanceof ClaudeSkillMaterializationError) {
        caught = err;
      }
    }

    expect(caught).toBeDefined();
    expect(caught!.code).toBe('skill_materialization_failed');
    expect(caught!.message).not.toContain(SECRET_TOKEN);
    expect(caught!.message).not.toContain(PROMPT_TEXT);
    expect(caught!.message).not.toContain(WORKSPACE_CONTENT);
    // Safe details include ref and assetPath only
    expect(caught!.details?.ref).toBe('mm:planning');
  });

  it('error name is ClaudeSkillMaterializationError', () => {
    const skill: ResolvedSkill = {
      ref: 'mm:planning',
      assetPath: '',
      dependencies: []
    };

    let caught: Error | undefined;
    try {
      materializeClaudeSkillPlugins([skill], CATALOG_ROOT);
    } catch (err) {
      if (err instanceof Error) caught = err;
    }

    expect(caught?.name).toBe('ClaudeSkillMaterializationError');
  });
});
