import path from 'node:path';

import type { MaterializedSkillIntent } from '@autocatalyst/execution';

export interface OpenAISkillMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

export interface OpenAISkillMaterialization {
  readonly skillsRoot: string;
  readonly mounts: readonly OpenAISkillMount[];
  readonly manifest: Readonly<Record<string, string>>; // ref → sandbox SKILL.md path
  readonly systemPromptHint: string;
}

const SKILLS_ROOT = '/skills';

/**
 * Derives the sandbox-visible directory path for a skill from its ref.
 * Ref format: `<namespace>:<name>` → `/skills/<namespace>/<name>`
 */
function sandboxDirFromRef(ref: string): string {
  const colonIndex = ref.indexOf(':');
  if (colonIndex === -1) {
    // Fallback: treat entire ref as a single path segment (should not happen per schema).
    return `${SKILLS_ROOT}/${ref}`;
  }
  const namespace = ref.slice(0, colonIndex);
  const name = ref.slice(colonIndex + 1);
  return `${SKILLS_ROOT}/${namespace}/${name}`;
}

/**
 * Materializes resolved runtime skills into a shape consumable by the OpenAI
 * agent sandbox: sandbox mounts, a ref→SKILL.md manifest, and a system-prompt
 * hint that tells the agent where to find and load the staged skills.
 *
 * Safe details only — no file contents, credentials, or provider responses.
 */
export function materializeOpenAISkillFiles(
  skills: MaterializedSkillIntent,
  catalogRoot: string
): OpenAISkillMaterialization {
  if (skills.resolved.length === 0) {
    return {
      skillsRoot: SKILLS_ROOT,
      mounts: [],
      manifest: {},
      systemPromptHint: ''
    };
  }

  const mounts: OpenAISkillMount[] = [];
  const manifest: Record<string, string> = {};

  for (const skill of skills.resolved) {
    const sandboxDir = sandboxDirFromRef(skill.ref);
    const sandboxSkillMdPath = `${sandboxDir}/SKILL.md`;
    const hostPath = path.resolve(catalogRoot, skill.assetPath);

    mounts.push({ hostPath, sandboxPath: sandboxDir });
    manifest[skill.ref] = sandboxSkillMdPath;
  }

  const skillList = Object.entries(manifest)
    .map(([ref, skillMdPath]) => `${ref} (${skillMdPath})`)
    .join(', ');

  const systemPromptHint =
    `Runtime skills are staged in this session. Skills root: ${SKILLS_ROOT}. ` +
    `Available skills: ${skillList}. ` +
    `Load and apply the skills declared in your session context.`;

  return {
    skillsRoot: SKILLS_ROOT,
    mounts,
    manifest,
    systemPromptHint
  };
}
