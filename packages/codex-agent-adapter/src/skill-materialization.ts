import type { ResolvedSkill } from '@autocatalyst/api-contract';
import { resolveCatalogAssetPath } from '@autocatalyst/execution';

// ---------------------------------------------------------------------------
// Codex skill delivery
//
// The Codex app-server has no first-class plugin array like the Claude SDK. The
// supported Codex-visible mechanism is to mount each resolved skill's catalog
// directory into the session workspace and name those directories in the system
// prompt so the agent can discover and read them. This helper performs the pure
// (no-filesystem, no-async) transformation from provider-neutral resolved skills
// into Codex skill mounts, a delivered-ref list, and a safe system-prompt hint.
//
// Path resolution uses `resolveCatalogAssetPath` from `@autocatalyst/execution`,
// which enforces catalog boundary containment (no traversal, no escaped
// symlinks). The adapter must not depend on personal host skills, plugins, or
// non-catalog paths.
// ---------------------------------------------------------------------------

/** The sandbox root under which skill directories are mounted for the agent. */
export const CODEX_SKILL_SANDBOX_ROOT = '/workspace/.codex-skills';

export interface CodexSkillMount {
  readonly ref: string;
  /** Absolute host path to the skill directory in the runtime catalog. */
  readonly hostPath: string;
  /** Read-only sandbox path the agent is told to look in. */
  readonly sandboxPath: string;
}

export interface CodexSkillMaterialization {
  readonly mounts: readonly CodexSkillMount[];
  /** Skill identifiers actually delivered to Codex (for diagnostics). */
  readonly delivered: readonly string[];
  /** Safe system-prompt hint naming the delivered skills; empty when none. */
  readonly systemPromptHint: string;
}

export type CodexSkillMaterializationErrorCode = 'skill_materialization_failed';

/**
 * Thrown when a resolved skill cannot be represented as a Codex skill mount.
 * Safe details include only skill refs and catalog-relative paths — never file
 * contents, prompt text, credentials, or provider payloads.
 */
export class CodexSkillMaterializationError extends Error {
  readonly code: CodexSkillMaterializationErrorCode;
  readonly details?: { readonly ref: string; readonly assetPath: string; readonly reason: string };

  constructor(
    code: CodexSkillMaterializationErrorCode,
    message: string,
    details?: { readonly ref: string; readonly assetPath: string; readonly reason: string }
  ) {
    super(message);
    this.name = 'CodexSkillMaterializationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function sandboxPathForRef(ref: string): string {
  // Colons are not path separators; map ref 'mm:planning' -> 'mm__planning'.
  const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, '__');
  return `${CODEX_SKILL_SANDBOX_ROOT}/${safeRef}`;
}

/**
 * Converts provider-neutral resolved skill entries into Codex skill mounts and a
 * safe system-prompt hint. Pure transformation — no async, no filesystem access.
 *
 * @throws {@link CodexSkillMaterializationError} with code
 * `'skill_materialization_failed'` if an `assetPath` entry is empty or path
 * resolution escapes the catalog boundary.
 */
export function materializeCodexSkills(
  skills: readonly ResolvedSkill[],
  catalogRoot: string
): CodexSkillMaterialization {
  if (skills.length === 0) {
    return { mounts: [], delivered: [], systemPromptHint: '' };
  }

  const mounts: CodexSkillMount[] = skills.map((skill) => {
    if (skill.assetPath.trim().length === 0) {
      throw new CodexSkillMaterializationError(
        'skill_materialization_failed',
        `Skill '${skill.ref}' has an empty assetPath and cannot be materialized as a Codex skill.`,
        { ref: skill.ref, assetPath: skill.assetPath, reason: 'empty_asset_path' }
      );
    }

    let hostPath: string;
    try {
      hostPath = resolveCatalogAssetPath(catalogRoot, skill.assetPath);
    } catch {
      throw new CodexSkillMaterializationError(
        'skill_materialization_failed',
        `Skill '${skill.ref}' asset path escapes the catalog boundary.`,
        { ref: skill.ref, assetPath: skill.assetPath, reason: 'asset_path_outside_catalog' }
      );
    }

    return { ref: skill.ref, hostPath, sandboxPath: sandboxPathForRef(skill.ref) };
  });

  const delivered = mounts.map((mount) => mount.ref);
  const lines = mounts.map((mount) => `- ${mount.ref}: ${mount.sandboxPath}`);
  const systemPromptHint = [
    'The following Autocatalyst runtime skills are mounted read-only for this session.',
    'Read a skill directory before using it:',
    ...lines
  ].join('\n');

  return { mounts, delivered, systemPromptHint };
}
