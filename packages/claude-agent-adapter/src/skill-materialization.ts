import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedSkill } from '@autocatalyst/api-contract';
import { resolveCatalogAssetPath } from '@autocatalyst/execution';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';

export class ClaudeSkillMaterializationError extends Error {
  readonly code = 'skill_materialization_failed';
  constructor() {
    super('Runtime skills could not be materialized as local Claude plugins.');
    this.name = 'ClaudeSkillMaterializationError';
  }
}

export interface ClaudeSkillMaterialization {
  readonly plugins: SdkPluginConfig[];
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
      return { namespace: match[1]!, name: match[2]!, source: resolveCatalogAssetPath(catalogRoot, skill.assetPath) };
    } catch {
      throw new ClaudeSkillMaterializationError();
    }
  });
  const root = mkdtempSync(join(tmpdir(), 'autocatalyst-claude-skills-'));
  const cleanup = (): void => rmSync(root, { recursive: true, force: true });
  try {
    const namespaces = [...new Set(sources.map((source) => source.namespace))];
    const plugins: SdkPluginConfig[] = namespaces.map((namespace) => {
      const pluginRoot = join(root, namespace);
      mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
      writeFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: namespace, version: '0.0.0' }));
      return { type: 'local', path: pluginRoot };
    });
    for (const { namespace, name, source } of sources) {
      cpSync(source, join(root, namespace, 'skills', name), {
        recursive: true,
        filter: (candidate) => {
          if (lstatSync(candidate).isSymbolicLink()) throw new ClaudeSkillMaterializationError();
          return true;
        }
      });
    }
    return { plugins, cleanup };
  } catch {
    cleanup();
    throw new ClaudeSkillMaterializationError();
  }
}
