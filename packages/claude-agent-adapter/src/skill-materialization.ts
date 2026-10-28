import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedSkill } from '@autocatalyst/api-contract';
import { resolveCatalogAssetPath } from '@autocatalyst/execution';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
export type ClaudeSkillPlugin = SdkPluginConfig;

export class ClaudeSkillMaterializationError extends Error {
  readonly code = 'skill_materialization_failed';
  constructor() {
    super('Runtime skills could not be materialized as local Claude plugins.');
    this.name = 'ClaudeSkillMaterializationError';
  }
}

export interface ClaudeSkillMaterialization {
  readonly plugins: ClaudeSkillPlugin[];
  cleanup(): void;
}

/** Materialize one SDK local plugin per namespace, retaining every skill's references. */
export function materializeClaudeSkillPlugins(
  skills: readonly ResolvedSkill[],
  catalogRoot: string
): ClaudeSkillMaterialization {
  if (skills.length === 0) return { plugins: [], cleanup() {} };
  // Validate all references and source paths before creating any temporary files.
  const sources = skills.map((skill) => {
    const match = /^([a-zA-Z0-9_-]+):([a-zA-Z0-9_-]+)$/.exec(skill.ref);
    if (match === null || skill.assetPath.trim().length === 0) throw new ClaudeSkillMaterializationError();
    try {
      return {
        namespace: match[1]!, name: match[2]!,
        canonicalMM: match[1] === 'mm' && skill.assetPath === `assets/mm/plugins/mm/skills/${match[2]}`,
        source: resolveCatalogAssetPath(catalogRoot, skill.assetPath)
      };
    } catch {
      throw new ClaudeSkillMaterializationError();
    }
  });
  // A namespace must use one layout, so generic skills cannot overwrite canonical files.
  if (sources.some((source) => source.canonicalMM) && sources.some((source) => source.namespace === 'mm' && !source.canonicalMM)) {
    throw new ClaudeSkillMaterializationError();
  }
  const copyTree = (source: string, destination: string): void => {
    cpSync(source, destination, {
      recursive: true,
      filter: (candidate) => {
        if (lstatSync(candidate).isSymbolicLink()) throw new ClaudeSkillMaterializationError();
        return true;
      }
    });
  };
  const root = mkdtempSync(join(tmpdir(), 'autocatalyst-claude-skills-'));
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const namespaces = [...new Set(sources.map((source) => source.namespace))];
    const plugins: ClaudeSkillPlugin[] = namespaces.map((namespace) => {
      if (sources.some((source) => source.namespace === namespace && source.canonicalMM)) {
        // Preserve the COMPLETE selected upstream tree, including the supplemental
        // docs four levels above skills/planning. Discover skills in the original
        // plugin root, using its unchanged canonical plugin manifest.
        const bundleRoot = join(root, namespace);
        copyTree(resolveCatalogAssetPath(catalogRoot, 'assets/mm'), bundleRoot);
        return { type: 'local', path: join(bundleRoot, 'plugins/mm') };
      }
      const pluginRoot = join(root, namespace);
      mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
      writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: namespace, version: '0.0.0' }));
      return { type: 'local', path: pluginRoot };
    });
    for (const { namespace, name, source, canonicalMM } of sources) {
      if (!canonicalMM) copyTree(source, join(root, namespace, 'skills', name));
    }
    return { plugins, cleanup };
  } catch {
    cleanup();
    throw new ClaudeSkillMaterializationError();
  }
}
