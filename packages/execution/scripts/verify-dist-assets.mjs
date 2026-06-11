/**
 * Post-build verification: asserts that skill catalog assets were copied into dist.
 * Run via: pnpm nx verify-dist-assets execution
 * (or as part of CI after pnpm nx build execution)
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const distSkillsRoot = path.join(workspaceRoot, 'packages/execution/dist/src/skills');

const expectedAssets = [
  'assets/mm/planning/SKILL.md',
  'assets/mm/writing-guidelines/SKILL.md',
  'assets/mm/SOURCE.json',
];

let ok = true;
for (const rel of expectedAssets) {
  const full = path.join(distSkillsRoot, rel);
  try {
    statSync(full);
  } catch {
    console.error(`MISSING dist asset: ${full}`);
    ok = false;
  }
}

if (ok) {
  console.log('dist skills assets OK');
} else {
  console.error(
    '\nBuild is missing skill catalog assets in dist/src/skills/assets/.\n' +
    'Ensure packages/execution/project.json declares assets in the build target.'
  );
  process.exit(1);
}
