import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimeSkillCatalogEntry {
  readonly ref: string;
  readonly assetPath: string;
  readonly dependencies: readonly string[];
  readonly description?: string;
}

export const runtimeSkillsCatalogRoot = path.dirname(fileURLToPath(import.meta.url));

// Canonical paths and dependencies are pinned in scripts/micromanager-selection.json.
// Files under assets/mm retain their paths relative to the upstream repository.
export const runtimeSkillsCatalog = [
  {
    ref: 'mm:planning',
    assetPath: 'assets/mm/plugins/mm/skills/planning',
    dependencies: ['mm:writing-guidelines'],
    description: 'Micromanager planning workflow for Autocatalyst spec authoring.'
  },
  {
    ref: 'mm:writing-guidelines',
    assetPath: 'assets/mm/plugins/mm/skills/writing-guidelines',
    dependencies: [],
    description: 'Writing guidance used when drafting planning artifacts.'
  }
] as const satisfies readonly RuntimeSkillCatalogEntry[];
