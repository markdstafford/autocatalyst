import type { ResolvedSkill } from '@autocatalyst/api-contract';
import { resolveCatalogAssetPath } from '@autocatalyst/execution';

// ---------------------------------------------------------------------------
// Codex skill delivery
//
// Native Codex skill inputs use real SKILL.md paths in the runtime-owned catalog.
// The transport verifies those paths exist and disables host skill discovery.
// No virtual /workspace mount is claimed: app-server works in the actual run repo.
// ---------------------------------------------------------------------------

export interface CodexSkillMount {
  readonly ref: string;
  /** Absolute host path to the skill directory in the runtime catalog. */
  readonly hostPath: string;
  /** Real Codex-visible catalog path; retained alongside hostPath for diagnostics. */
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

    return { ref: skill.ref, hostPath, sandboxPath: hostPath };
  });

  const delivered = mounts.map((mount) => mount.ref);
  const lines = mounts.map((mount) => `- ${mount.ref}: ${mount.sandboxPath}`);
  const systemPromptHint = [
    'The following Autocatalyst runtime skills are provided as native skill inputs for this session.',
    'Read a skill directory before using it:',
    ...lines
  ].join('\n');

  return { mounts, delivered, systemPromptHint };
}
