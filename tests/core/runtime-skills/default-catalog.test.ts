import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import { findRuntimeSkillsRoot, resolveRuntimeSkillRefs } from '../../../src/core/runtime-skills/catalog.js';

describe('default runtime-skills catalog', () => {
  test('resolves all route-required skills from the committed catalog', () => {
    const resolved = resolveRuntimeSkillRefs([
      'mm:planning',
      'mm:issue-triage',
      'superpowers:writing-plans',
      'superpowers:subagent-driven-development',
    ]);

    expect(resolved.providers.map(provider => provider.id)).toEqual(['mm', 'superpowers']);
    expect(resolved.providers[0].skills.map(skill => skill.ref)).toEqual([
      'mm:planning',
      'mm:writing-guidelines',
      'mm:issue-triage',
    ]);
    expect(resolved.providers[1].skills.map(skill => skill.ref)).toEqual([
      'superpowers:writing-plans',
      'superpowers:subagent-driven-development',
      'superpowers:requesting-code-review',
      'superpowers:finishing-a-development-branch',
      'superpowers:test-driven-development',
    ]);
  });

  test('finds committed catalog by walking up from compiled module locations', () => {
    expect(findRuntimeSkillsRoot(join(process.cwd(), 'dist', 'core', 'runtime-skills'))).toBe(
      join(process.cwd(), 'runtime-skills'),
    );
  });
});
