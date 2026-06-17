import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

// Production source files allowed to contain 'gh issue view'
const ALLOWED_PATHS = [
  'packages/github-issue-tracker-adapter/src/gh-exec.ts',
  'packages/github-issue-tracker-adapter/src/github-issue-tracker.ts',
];

function getAllTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.live.spec.ts')) {
      files.push(full);
    }
  }
  return files;
}

const srcDirs = [
  resolve(root, 'packages'),
  resolve(root, 'apps'),
];

let violations = 0;
const allFiles = srcDirs.flatMap(d => getAllTsFiles(d));

for (const file of allFiles) {
  const relative = file.replace(root + '/', '');
  if (ALLOWED_PATHS.includes(relative)) continue;

  const content = readFileSync(file, 'utf8');
  if (content.includes('gh issue view') || content.includes("'gh', ['issue'") || content.includes('"gh", ["issue"')) {
    console.error(`VIOLATION: ${relative} contains gh issue view outside the allowed adapter path`);
    violations++;
  }
}

if (violations > 0) {
  process.exit(1);
}

console.log('GH issue read boundary test passed: no production issue reads bypass the adapter/helper.');
