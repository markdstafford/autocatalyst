import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RuntimeSkillCatalogEntry {
  readonly ref: string;
  readonly assetPath: string;
  readonly dependencies: readonly string[];
  readonly description?: string;
}

export const runtimeSkillsCatalogRoot = path.dirname(fileURLToPath(import.meta.url));

export const runtimeSkillsCatalog = [
  {
    ref: 'mm:planning',
    assetPath: 'assets/mm/planning',
    dependencies: ['mm:writing-guidelines'],
    description: 'Micromanager planning workflow for Autocatalyst spec authoring.'
  },
  {
    ref: 'mm:writing-guidelines',
    assetPath: 'assets/mm/writing-guidelines',
    dependencies: [],
    description: 'Writing guidance used when drafting planning artifacts.'
  }
] as const satisfies readonly RuntimeSkillCatalogEntry[];
