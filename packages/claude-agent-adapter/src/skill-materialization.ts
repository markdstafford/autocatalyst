import path from 'node:path';

import type { ResolvedSkill } from '@autocatalyst/api-contract';

// ---------------------------------------------------------------------------
// Claude SDK skill/plugin shape
//
// The @anthropic-ai/claude-agent-sdk receives skills via `options.skills` as
// an array of plugin descriptor objects. Each descriptor contains:
//   - `type`:  always `'claudecode'` — identifies the plugin kind.
//   - `path`:  absolute filesystem path to the skill's root directory.
//
// This shape is verified against the current adapter behavior in
// `claude-agent-adapter.ts` where `options: { skills: [...] }` is forwarded.
// The helper documents this provider-specific mapping so callers do not need
// to know SDK internals. If the SDK shape changes, only this file needs
// updating.
// ---------------------------------------------------------------------------

/**
 * A single Claude Agent SDK skill plugin descriptor.
 * The adapter passes an array of these inside `options.skills`.
 */
export interface ClaudeSkillPlugin {
  readonly type: 'claudecode';
  readonly path: string;
}

// ---------------------------------------------------------------------------
// Materialization error
// ---------------------------------------------------------------------------

export type ClaudeSkillMaterializationErrorCode = 'skill_materialization_failed';

/**
 * Thrown when a resolved skill cannot be represented as a Claude SDK plugin.
 * Safe details include only skill refs and catalog-relative paths — never
 * file contents, prompt text, credentials, or provider payloads.
 */
export class ClaudeSkillMaterializationError extends Error {
  readonly code: ClaudeSkillMaterializationErrorCode;
  readonly details?: { readonly ref: string; readonly assetPath: string; readonly reason: string };

  constructor(
    code: ClaudeSkillMaterializationErrorCode,
    message: string,
    details?: { readonly ref: string; readonly assetPath: string; readonly reason: string }
  ) {
    super(message);
    this.name = 'ClaudeSkillMaterializationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------------------
// materializeClaudeSkillPlugins
// ---------------------------------------------------------------------------

/**
 * Converts provider-neutral resolved skill entries into the verified Claude
 * Agent SDK plugin descriptor array expected by `options.skills`.
 *
 * This is a pure transformation — no async, no filesystem access. Path
 * resolution uses `path.resolve(catalogRoot, skill.assetPath)`. Containment
 * checks and asset existence checks are the responsibility of the execution
 * materializer (`validateMaterializedSkills`), which must run before any
 * adapter call.
 *
 * @param skills    Resolved skill entries from `MaterializedExecutionEnvironment.skills.resolved`.
 * @param catalogRoot  Absolute path to the runtime skills catalog root. Used to
 *                     resolve catalog-relative `assetPath` values to absolute paths.
 * @returns An array of `ClaudeSkillPlugin` entries ready to pass as `options.skills`.
 *          Returns `[]` when `skills` is empty.
 *
 * @throws `ClaudeSkillMaterializationError` with code `'skill_materialization_failed'`
 *         if an `assetPath` entry is empty or path resolution yields an empty string.
 */
export function materializeClaudeSkillPlugins(
  skills: readonly ResolvedSkill[],
  catalogRoot: string
): ClaudeSkillPlugin[] {
  if (skills.length === 0) {
    return [];
  }

  return skills.map((skill) => {
    if (skill.assetPath.trim().length === 0) {
      throw new ClaudeSkillMaterializationError(
        'skill_materialization_failed',
        `Skill '${skill.ref}' has an empty assetPath and cannot be materialized as a Claude plugin.`,
        { ref: skill.ref, assetPath: skill.assetPath, reason: 'empty_asset_path' }
      );
    }

    const absolutePath = path.resolve(catalogRoot, skill.assetPath);

    return {
      type: 'claudecode' as const,
      path: absolutePath
    };
  });
}
