import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentSkillNamespace, AgentSkillRef } from '../../types/ai.js';

export interface RuntimeSkillCatalogOptions {
  rootDir?: string;
}

export interface ResolvedRuntimeSkill {
  ref: AgentSkillRef;
  name: string;
  path: string;
  sourcePath: string;
}

export interface ResolvedRuntimeSkillProvider {
  id: AgentSkillNamespace;
  sourceDir: string;
  pluginManifestPath: string;
  extraFilePaths: string[];
  skills: ResolvedRuntimeSkill[];
}

export interface ResolvedRuntimeSkills {
  rootDir: string;
  providers: ResolvedRuntimeSkillProvider[];
}

interface RuntimeSkillsManifest {
  providers?: Record<string, RuntimeSkillsProviderManifest>;
}

interface RuntimeSkillsProviderManifest {
  source?: string;
  plugin_manifest?: string;
  extra_files?: string[];
  skills?: Record<string, RuntimeSkillManifestEntry>;
}

interface RuntimeSkillManifestEntry {
  path?: string;
  dependencies?: AgentSkillRef[];
}

const DEFAULT_RUNTIME_SKILLS_DIR = 'runtime-skills';

export function resolveRuntimeSkillRefs(
  refs: AgentSkillRef[],
  options?: RuntimeSkillCatalogOptions,
): ResolvedRuntimeSkills {
  const rootDir = options?.rootDir ? resolve(options.rootDir) : defaultRuntimeSkillsRoot();
  const manifest = readManifest(rootDir);
  const resolvedByProvider = new Map<AgentSkillNamespace, ResolvedRuntimeSkillProvider>();
  const seen = new Set<AgentSkillRef>();

  for (const ref of refs) {
    resolveSkill(ref, manifest, rootDir, resolvedByProvider, seen);
  }

  return {
    rootDir,
    providers: Array.from(resolvedByProvider.values()),
  };
}

function resolveSkill(
  ref: AgentSkillRef,
  manifest: RuntimeSkillsManifest,
  rootDir: string,
  resolvedByProvider: Map<AgentSkillNamespace, ResolvedRuntimeSkillProvider>,
  seen: Set<AgentSkillRef>,
): void {
  if (seen.has(ref)) return;
  seen.add(ref);

  const { namespace, skillName } = parseSkillRef(ref);
  const providerManifest = manifest.providers?.[namespace];
  const skillManifest = providerManifest?.skills?.[skillName];
  if (!providerManifest || !skillManifest) {
    throw new Error(`Runtime skill "${ref}" is not declared in runtime-skills/manifest.yaml`);
  }

  const provider = ensureResolvedProvider(namespace, providerManifest, rootDir, resolvedByProvider);
  const skillPath = requiredPath(skillManifest.path, `Runtime skill "${ref}" is missing path`);
  const sourcePath = join(provider.sourceDir, skillPath);
  const skillMarkdownPath = join(sourcePath, 'SKILL.md');
  if (!existsSync(skillMarkdownPath)) {
    throw new Error(`Runtime skill "${ref}" is missing SKILL.md at ${skillMarkdownPath}`);
  }

  provider.skills.push({
    ref,
    name: skillName,
    path: skillPath,
    sourcePath,
  });

  for (const dependency of skillManifest.dependencies ?? []) {
    resolveSkill(dependency, manifest, rootDir, resolvedByProvider, seen);
  }
}

function ensureResolvedProvider(
  id: AgentSkillNamespace,
  manifest: RuntimeSkillsProviderManifest,
  rootDir: string,
  resolvedByProvider: Map<AgentSkillNamespace, ResolvedRuntimeSkillProvider>,
): ResolvedRuntimeSkillProvider {
  const existing = resolvedByProvider.get(id);
  if (existing) return existing;

  const source = requiredPath(manifest.source, `Runtime skill provider "${id}" is missing source`);
  const pluginManifest = requiredPath(manifest.plugin_manifest, `Runtime skill provider "${id}" is missing plugin_manifest`);
  const sourceDir = join(rootDir, source);
  const pluginManifestPath = join(sourceDir, pluginManifest);
  if (!existsSync(pluginManifestPath)) {
    throw new Error(`Runtime skill provider "${id}" is missing plugin manifest at ${pluginManifestPath}`);
  }

  const extraFilePaths = (manifest.extra_files ?? []).map(file => {
    const filePath = join(sourceDir, file);
    if (!existsSync(filePath)) {
      throw new Error(`Runtime skill provider "${id}" is missing declared file at ${filePath}`);
    }
    return filePath;
  });

  const resolvedProvider: ResolvedRuntimeSkillProvider = {
    id,
    sourceDir,
    pluginManifestPath,
    extraFilePaths,
    skills: [],
  };
  resolvedByProvider.set(id, resolvedProvider);
  return resolvedProvider;
}

function readManifest(rootDir: string): RuntimeSkillsManifest {
  const manifestPath = join(rootDir, 'manifest.yaml');
  if (!existsSync(manifestPath)) {
    throw new Error(`runtime-skills/manifest.yaml not found at ${manifestPath}`);
  }
  return parseYaml(readFileSync(manifestPath, 'utf-8')) as RuntimeSkillsManifest;
}

function defaultRuntimeSkillsRoot(): string {
  for (const startDir of [import.meta.dirname, process.cwd()]) {
    const found = findRuntimeSkillsRoot(startDir);
    if (found) return found;
  }
  return resolve(DEFAULT_RUNTIME_SKILLS_DIR);
}

export function findRuntimeSkillsRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, DEFAULT_RUNTIME_SKILLS_DIR);
    if (existsSync(join(candidate, 'manifest.yaml'))) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function parseSkillRef(ref: AgentSkillRef): { namespace: AgentSkillNamespace; skillName: string } {
  const [namespace, skillName] = ref.split(':') as [AgentSkillNamespace, string];
  return { namespace, skillName };
}

function requiredPath(value: string | undefined, message: string): string {
  if (!value || value.trim() === '') throw new Error(message);
  return value;
}
