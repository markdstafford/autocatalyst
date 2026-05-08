import { cp, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { resolveRuntimeSkillRefs } from '../../core/runtime-skills/catalog.js';
import type { AgentPluginConfig, AgentSkillRef } from '../../types/ai.js';

export interface ClaudeRuntimeSkillMaterializerOptions {
  rootDir?: string;
  materializedRoot?: string;
}

export async function materializeClaudeRuntimeSkillPlugins(
  refs: AgentSkillRef[],
  options?: ClaudeRuntimeSkillMaterializerOptions,
): Promise<AgentPluginConfig[]> {
  if (refs.length === 0) return [];

  const resolved = resolveRuntimeSkillRefs(refs, { rootDir: options?.rootDir });
  const materializedRoot = options?.materializedRoot
    ?? await mkdtemp(join(tmpdir(), 'autocatalyst-runtime-skills-'));
  const plugins: AgentPluginConfig[] = [];

  for (const provider of resolved.providers) {
    const pluginRoot = join(materializedRoot, provider.id);
    await copyIntoPlugin(provider.pluginManifestPath, provider.sourceDir, pluginRoot);
    for (const extraFilePath of provider.extraFilePaths) {
      await copyIntoPlugin(extraFilePath, provider.sourceDir, pluginRoot);
    }
    for (const skill of provider.skills) {
      await cp(skill.sourcePath, join(pluginRoot, skill.path), { recursive: true });
    }
    plugins.push({ type: 'local', path: pluginRoot });
  }

  return plugins;
}

async function copyIntoPlugin(sourcePath: string, sourceRoot: string, pluginRoot: string): Promise<void> {
  const targetPath = join(pluginRoot, relative(sourceRoot, sourcePath));
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(sourcePath, targetPath, { recursive: true });
}
