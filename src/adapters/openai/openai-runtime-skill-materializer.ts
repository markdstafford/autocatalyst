import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skills as sdkSkills } from '@openai/agents/sandbox';
import { resolveRuntimeSkillRefs } from '../../core/runtime-skills/catalog.js';
import type { AgentSkillRef } from '../../types/ai.js';

export interface OpenAIRuntimeSkillMaterializerOptions {
  rootDir?: string;
}

export async function materializeOpenAIRuntimeSkills(
  refs: AgentSkillRef[],
  options?: OpenAIRuntimeSkillMaterializerOptions,
): Promise<unknown[]> {
  if (refs.length === 0) return [];

  const resolved = resolveRuntimeSkillRefs(refs, { rootDir: options?.rootDir });

  const skillObjects: Array<{ name: string; description: string; content: string }> = [];

  for (const provider of resolved.providers) {
    for (const skill of provider.skills) {
      const skillMdPath = join(skill.sourcePath, 'SKILL.md');
      const content = readFileSync(skillMdPath, 'utf-8');
      skillObjects.push({
        name: skill.ref,
        description: `Runtime skill: ${skill.ref}`,
        content,
      });
    }
  }

  return [sdkSkills({ skills: skillObjects })];
}
