#!/usr/bin/env node
// serve-fake wrapper: safely clears the fake state directory (guarded by the
// fake-mode marker file), then starts the production entrypoint in fake mode.
//
// Must run after `control-plane:build` so the compiled dist is present.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safelyClearFakeStateDir } from '../dist/src/fake/serve-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(__dirname, '..');
const mainEntry = resolve(appDir, 'dist/src/main.js');

const DEFAULT_FAKE_STATE_DIR = '.autocatalyst-fake';

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

const forwarded = process.argv.slice(2);
const stateDir = readFlag(forwarded, '--fake-state-dir') ?? DEFAULT_FAKE_STATE_DIR;

try {
  await safelyClearFakeStateDir(stateDir);
} catch (error) {
  process.stderr.write(`serve-fake: ${error.message}\n`);
  process.exit(1);
}

// Always pass --fake-mode and the resolved state dir; forward any other flags
// (e.g. --port, --bearer-token) the caller supplied.
const childArgs = [mainEntry, '--fake-mode', '--fake-state-dir', stateDir];
for (let i = 0; i < forwarded.length; i += 1) {
  const arg = forwarded[i];
  if (arg === '--fake-state-dir') {
    i += 1; // already captured
    continue;
  }
  childArgs.push(arg);
}

const child = spawn(process.execPath, childArgs, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
