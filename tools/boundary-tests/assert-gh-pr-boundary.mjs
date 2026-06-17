import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

// Production source files/directories allowed to contain gh pr commands or executeGh/GhExec* usage.
// To add a new adapter that legitimately uses gh pr commands, add its src/ path here.
const ALLOWED_PATHS = [
  'packages/github-code-host-adapter/src/',
  'packages/github-issue-tracker-adapter/src/gh-exec.ts',
  'packages/github-issue-tracker-adapter/src/github-issue-tracker.ts',
  'packages/github-issue-tracker-adapter/src/index.ts',
];

// gh pr command strings that indicate direct CLI usage outside the adapter boundary
const GH_PR_PATTERNS = [
  "'pr create'",
  '"pr create"',
  "'pr view'",
  '"pr view"',
  "'pr list'",
  '"pr list"',
  "'pr edit'",
  '"pr edit"',
  "'pr merge'",
  '"pr merge"',
];

// executeGh/GhExec* symbols that should only be used within the allowed adapter packages
const EXEC_PATTERNS = [
  'executeGh',
  'GhExecError',
  'GhExecInput',
  'GhExecResult',
];

function getAllTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    // Skip boundary test fixtures
    if (full.includes('tools/boundary-tests/fixtures')) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...getAllTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.live.spec.ts')) {
      files.push(full);
    }
  }
  return files;
}

function isAllowed(relative) {
  return ALLOWED_PATHS.some(allowed => relative.startsWith(allowed) || relative === allowed);
}

const srcDirs = [
  resolve(root, 'packages'),
  resolve(root, 'apps'),
];

let violations = 0;
const allFiles = srcDirs.flatMap(d => getAllTsFiles(d));

for (const file of allFiles) {
  const relative = file.replace(root + '/', '');
  if (isAllowed(relative)) continue;

  const content = readFileSync(file, 'utf8');

  const hasGhPr = GH_PR_PATTERNS.some(p => content.includes(p));
  const hasExecSymbol = EXEC_PATTERNS.some(p => content.includes(p));

  if (hasGhPr || hasExecSymbol) {
    console.error(`VIOLATION: ${relative} contains gh pr command or executeGh/GhExec* usage outside the allowed adapter path`);
    violations++;
  }
}

if (violations > 0) {
  process.exit(1);
}

console.log('GH PR boundary test passed: no production PR commands or executeGh usage bypass the adapter.');
