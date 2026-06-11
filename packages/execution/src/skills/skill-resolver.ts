import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolvedSkillSchema, skillRefSchema, type ResolvedSkill, type SkillIntent } from '@autocatalyst/api-contract';

import { runtimeSkillsCatalog, runtimeSkillsCatalogRoot, type RuntimeSkillCatalogEntry } from './catalog.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type SkillCatalogResolutionErrorCode =
  | 'catalog_entry_malformed'
  | 'skill_ref_invalid'
  | 'skill_not_found'
  | 'skill_dependency_missing'
  | 'skill_dependency_cycle'
  | 'skill_asset_missing'
  | 'skill_asset_outside_catalog';

export class SkillCatalogResolutionError extends Error {
  readonly code: SkillCatalogResolutionErrorCode;
  readonly safeDetails?: Readonly<Record<string, unknown>>;

  constructor(code: SkillCatalogResolutionErrorCode, message: string, safeDetails?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'SkillCatalogResolutionError';
    this.code = code;
    if (safeDetails !== undefined) this.safeDetails = safeDetails;
  }
}

// ---------------------------------------------------------------------------
// Catalog entry schema (mirrors resolvedSkillSchema but for catalog input)
// ---------------------------------------------------------------------------

import { z } from 'zod';

const catalogEntrySchema = z.object({
  ref: skillRefSchema,
  assetPath: z.string().min(1),
  dependencies: z.array(skillRefSchema),
  description: z.string().min(1).optional()
}).strict();

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ValidateSkillCatalogInput {
  readonly catalog?: readonly RuntimeSkillCatalogEntry[];
  readonly catalogRoot?: string;
}

export interface ValidatedRuntimeSkillCatalogEntry extends ResolvedSkill {
  readonly absoluteAssetPath: string;
}

export interface ResolveSkillsOptions extends ValidateSkillCatalogInput {}

// ---------------------------------------------------------------------------
// Containment helper
// ---------------------------------------------------------------------------

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveCatalogAssetPath(catalogRoot: string, assetPath: string): string {
  const root = path.resolve(catalogRoot);
  const absoluteAssetPath = path.resolve(root, assetPath);
  if (!isInsideRoot(root, absoluteAssetPath)) {
    throw new SkillCatalogResolutionError(
      'skill_asset_outside_catalog',
      'Skill asset path escapes the runtime skills catalog.',
      { assetPath }
    );
  }
  return absoluteAssetPath;
}

// ---------------------------------------------------------------------------
// Catalog validation
// ---------------------------------------------------------------------------

export async function validateSkillCatalog(
  input: ValidateSkillCatalogInput = {}
): Promise<readonly ValidatedRuntimeSkillCatalogEntry[]> {
  const catalog = input.catalog ?? runtimeSkillsCatalog;
  const catalogRoot = input.catalogRoot ?? runtimeSkillsCatalogRoot;
  const parsed: RuntimeSkillCatalogEntry[] = [];

  for (const entry of catalog) {
    const result = catalogEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new SkillCatalogResolutionError(
        'catalog_entry_malformed',
        'Skill catalog entry is malformed.',
        { ref: typeof entry.ref === 'string' ? entry.ref : undefined }
      );
    }
    parsed.push(result.data);
  }

  const refs = new Set<string>();
  for (const entry of parsed) {
    if (refs.has(entry.ref)) {
      throw new SkillCatalogResolutionError(
        'catalog_entry_malformed',
        'Duplicate skill catalog ref.',
        { ref: entry.ref }
      );
    }
    refs.add(entry.ref);
  }

  for (const entry of parsed) {
    for (const dependency of entry.dependencies) {
      if (!refs.has(dependency)) {
        throw new SkillCatalogResolutionError(
          'skill_dependency_missing',
          'Skill dependency ref is not present in the catalog.',
          { ref: entry.ref, dependency }
        );
      }
    }
  }

  const validated: ValidatedRuntimeSkillCatalogEntry[] = [];
  for (const entry of parsed) {
    let absoluteAssetPath: string;
    try {
      absoluteAssetPath = resolveCatalogAssetPath(catalogRoot, entry.assetPath);
    } catch (error) {
      if (error instanceof SkillCatalogResolutionError) throw error;
      throw new SkillCatalogResolutionError(
        'skill_asset_outside_catalog',
        'Skill asset path resolution failed.',
        { ref: entry.ref, assetPath: entry.assetPath }
      );
    }
    try {
      const stats = await stat(absoluteAssetPath);
      if (!stats.isDirectory() && !stats.isFile()) {
        throw new SkillCatalogResolutionError(
          'skill_asset_missing',
          'Skill asset path is not a file or directory.',
          { ref: entry.ref, assetPath: entry.assetPath }
        );
      }
      await access(absoluteAssetPath);
    } catch (error) {
      if (error instanceof SkillCatalogResolutionError) throw error;
      throw new SkillCatalogResolutionError(
        'skill_asset_missing',
        'Skill asset path does not exist.',
        { ref: entry.ref, assetPath: entry.assetPath }
      );
    }
    validated.push({ ...entry, absoluteAssetPath });
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Transitive skill resolution
// ---------------------------------------------------------------------------

export async function resolveSkills(
  requestedRefs: readonly string[],
  options: ResolveSkillsOptions = {}
): Promise<SkillIntent> {
  const requested: string[] = [];
  const requestedSet = new Set<string>();
  for (const ref of requestedRefs) {
    const parsed = skillRefSchema.safeParse(ref);
    if (!parsed.success) {
      throw new SkillCatalogResolutionError(
        'skill_ref_invalid',
        'Requested skill ref is invalid.',
        { ref }
      );
    }
    if (!requestedSet.has(parsed.data)) {
      requestedSet.add(parsed.data);
      requested.push(parsed.data);
    }
  }

  const validated = await validateSkillCatalog(options);
  const byRef = new Map(validated.map((entry) => [entry.ref, entry] as const));
  const visited = new Set<string>();
  const active = new Set<string>();
  const resolved: ResolvedSkill[] = [];

  function visit(ref: string, requestedBy?: string): void {
    const entry = byRef.get(ref);
    if (entry === undefined) {
      throw new SkillCatalogResolutionError(
        requestedBy === undefined ? 'skill_not_found' : 'skill_dependency_missing',
        requestedBy === undefined
          ? 'Requested skill ref is not present in the catalog.'
          : 'Dependency skill ref is not present in the catalog.',
        requestedBy === undefined
          ? { ref }
          : { ref: requestedBy, dependency: ref }
      );
    }
    if (active.has(ref)) {
      throw new SkillCatalogResolutionError(
        'skill_dependency_cycle',
        'Skill dependency cycle detected.',
        { ref, activeRefs: [...active] }
      );
    }
    if (visited.has(ref)) return;

    active.add(ref);
    for (const dependency of entry.dependencies) {
      visit(dependency, entry.ref);
    }
    active.delete(ref);
    visited.add(ref);

    const resolvedEntry = resolvedSkillSchema.parse({
      ref: entry.ref,
      assetPath: entry.assetPath,
      dependencies: [...entry.dependencies],
      ...(entry.description !== undefined ? { description: entry.description } : {})
    });
    resolved.push(resolvedEntry);
  }

  for (const ref of requested) {
    visit(ref);
  }
  return { requested, resolved };
}
