import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentPluginConfig } from '../../types/ai.js';

export type ClaudeCodePluginId = 'mm' | 'superpowers';

export interface ClaudeCodePluginResolverOptions {
  homeDir?: string;
}

export function resolveClaudeCodePlugins(
  ids: ClaudeCodePluginId[],
  options?: ClaudeCodePluginResolverOptions,
): AgentPluginConfig[] {
  return ids.map(id => ({ type: 'local', path: resolveClaudeCodePluginPath(id, options) }));
}

function resolveClaudeCodePluginPath(
  id: ClaudeCodePluginId,
  options?: ClaudeCodePluginResolverOptions,
): string {
  const home = options?.homeDir ?? homedir();
  for (const candidate of candidateRoots(home, id)) {
    const pluginPath = findPluginPath(candidate);
    if (pluginPath) return pluginPath;
  }

  throw new Error(
    `Required Claude Code plugin "${id}" was not found. Install it or configure explicit plugin loading before running this agent task.`,
  );
}

function candidateRoots(home: string, id: ClaudeCodePluginId): string[] {
  if (id === 'mm') {
    return [
      join(home, '.claude', 'plugins', 'cache', 'micromanager', 'mm'),
      join(home, '.claude', 'plugins', 'marketplaces', 'micromanager', 'plugins', 'mm'),
    ];
  }

  return [
    join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers'),
    join(home, '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', 'plugins', 'superpowers'),
  ];
}

function findPluginPath(candidate: string): string | undefined {
  if (hasPluginManifest(candidate)) return candidate;
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) return undefined;

  const versionDirs = readdirSync(candidate, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(candidate, entry.name))
    .filter(hasPluginManifest)
    .sort(compareVersionPathDesc);

  return versionDirs[0];
}

function hasPluginManifest(pluginPath: string): boolean {
  return existsSync(join(pluginPath, '.claude-plugin', 'plugin.json'));
}

function compareVersionPathDesc(left: string, right: string): number {
  return compareVersionsDesc(basename(left), basename(right));
}

function compareVersionsDesc(left: string, right: string): number {
  const leftParts = left.split('.').map(part => Number(part));
  const rightParts = right.split('.').map(part => Number(part));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let i = 0; i < length; i += 1) {
    const leftPart = Number.isFinite(leftParts[i]) ? leftParts[i] : 0;
    const rightPart = Number.isFinite(rightParts[i]) ? rightParts[i] : 0;
    if (leftPart !== rightPart) return rightPart - leftPart;
  }

  return right.localeCompare(left);
}
