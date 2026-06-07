import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

function runEslint(fixture) {
  return spawnSync(
    process.execPath,
    [
      resolve(root, 'node_modules/eslint/bin/eslint.js'),
      resolve(root, 'tools/boundary-tests/fixtures', fixture),
      '--config',
      resolve(root, 'eslint.config.mjs'),
      '--no-error-on-unmatched-pattern'
    ],
    {
      cwd: root,
      encoding: 'utf8'
    }
  );
}

const valid = runEslint('valid-control-plane-import.ts');
if (valid.status !== 0) {
  process.stderr.write(valid.stdout);
  process.stderr.write(valid.stderr);
  throw new Error('Expected public @autocatalyst/execution import to pass ESLint.');
}

const invalid = runEslint('invalid-execution-internal-import.ts');
const invalidOutput = `${invalid.stdout}\n${invalid.stderr}`;
if (invalid.status === 0) {
  throw new Error('Expected @autocatalyst/execution/src/* import to fail ESLint.');
}

if (!invalidOutput.includes('no-restricted-imports')) {
  process.stderr.write(invalidOutput);
  throw new Error('Expected failure to come from no-restricted-imports.');
}

if (!invalidOutput.includes('public entry point')) {
  process.stderr.write(invalidOutput);
  throw new Error('Expected failure message to mention the public entry point.');
}

console.log('Execution boundary test passed: public import accepted, internal import rejected.');
