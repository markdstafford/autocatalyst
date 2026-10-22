import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { MaterializedSkillIntent } from '@autocatalyst/execution';
import { resolveCatalogAssetPath } from '@autocatalyst/execution';
import { dir, file, type Entry } from '@openai/agents/sandbox';

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

const SKILLS_ROOT = '/workspace/skills';

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
    let hostPath: string;
    try {
      hostPath = resolveCatalogAssetPath(catalogRoot, skill.assetPath);
    } catch {
      // Surface a safe error — do not include file contents or catalog internals
      throw new Error(
        `Skill '${skill.ref}' asset path escapes the catalog boundary and cannot be staged.`
      );
    }

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

/**
 * A skill descriptor for the OpenAI Agents SDK native `skills()` capability:
 * the SKILL.md content is loaded INTO the agent (the SDK exposes it as a real
 * skill with instructions), rather than left as a mounted file the model must
 * remember to read. Uses the installed SDK descriptor contract.
 */
export interface OpenAISkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly scripts?: Record<string, Entry>;
  readonly references?: Record<string, Entry>;
  readonly assets?: Record<string, Entry>;
}

/**
 * Reads each resolved skill's SKILL.md into a descriptor for the SDK `skills()`
 * capability. Safe details only — content is the skill's own authored markdown.
 */
export function buildOpenAISkillDescriptors(
  skills: MaterializedSkillIntent,
  catalogRoot: string
): OpenAISkillDescriptor[] {
  const descriptors: OpenAISkillDescriptor[] = [];
  for (const skill of skills.resolved) {
    let hostPath: string;
    try {
      hostPath = resolveCatalogAssetPath(catalogRoot, skill.assetPath);
    } catch {
      throw new Error(
        `Skill '${skill.ref}' asset path escapes the catalog boundary and cannot be staged.`
      );
    }
    const content = readFileSync(join(hostPath, 'SKILL.md'), 'utf8');
    const scripts = buildSdkEntryMap(join(hostPath, 'scripts'));
    const references = buildSdkEntryMap(join(hostPath, 'references'));
    const assets = buildSdkEntryMap(join(hostPath, 'assets'));
    descriptors.push({
      name: skill.ref,
      description: descriptionFromSkillMarkdown(content) ?? `Runtime skill: ${skill.ref}`,
      content,
      ...(scripts !== undefined ? { scripts } : {}),
      ...(references !== undefined ? { references } : {}),
      ...(assets !== undefined ? { assets } : {})
    });
  }
  return descriptors;
}

function buildSdkEntryMap(directoryPath: string): Record<string, Entry> | undefined {
  if (existsSync(directoryPath) && lstatSync(directoryPath).isSymbolicLink()) {
    throw new Error('Runtime skill references must not contain symbolic links.');
  }
  if (!existsSync(directoryPath) || !lstatSync(directoryPath).isDirectory()) {
    return undefined;
  }

  const entries: Record<string, Entry> = {};
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const sourcePath = join(directoryPath, entry.name);
    const sdkEntry = buildInlineSdkEntry(sourcePath);
    if (sdkEntry !== undefined) entries[entry.name] = sdkEntry;
  }

  return Object.keys(entries).length > 0 ? entries : undefined;
}

function buildInlineSdkEntry(sourcePath: string): Entry | undefined {
  const stats = lstatSync(sourcePath);
  if (stats.isSymbolicLink()) throw new Error('Runtime skill references must not contain symbolic links.');
  if (stats.isDirectory()) {
    const children = buildSdkEntryMap(sourcePath);
    return dir({ children: children ?? {} });
  }
  if (stats.isFile()) {
    return file({ content: readFileSync(sourcePath) });
  }
  return undefined;
}

function descriptionFromSkillMarkdown(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === '---') return undefined;
    if (!line.startsWith('description:')) continue;
    const value = line.slice('description:'.length).trim();
    if (/^[>|][-+]?$/.test(value)) {
      const continuation: string[] = [];
      for (const next of lines.slice(i + 1)) {
        if (next.trim() === '---' || (next.length > 0 && !/^\s/.test(next))) break;
        if (next.trim().length > 0) continuation.push(next.trim());
      }
      return continuation.join(value.startsWith('>') ? ' ' : '\n') || undefined;
    }
    if (value.length === 0) return undefined;
    if (value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}
