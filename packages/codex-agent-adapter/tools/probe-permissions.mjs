// Opt-in local protocol/OS sandbox check. Starts no model turn and needs no API key.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCodexAppServer, codexSandboxPolicy } from '../dist/src/codex-app-server.js';

const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-permissions-')));
const file = path.join(cwd, 'sentinel.txt');
const client = await openCodexAppServer({ binary: process.env.AUTOCATALYST_CODEX_BINARY ?? 'codex', cwd });
try {
  await writeFile(file, 'before');
  const command = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'changed')`];
  const writable = await client.rpc('command/exec', { cwd, command, timeoutMs: 5000,
    sandboxPolicy: codexSandboxPolicy('workspace-write', [cwd]) });
  assert.equal(writable.exitCode, 0, 'Implementer control must actually be able to write.');
  assert.equal(await readFile(file, 'utf8'), 'changed');
  await writeFile(file, 'before');
  const readonly = await client.rpc('command/exec', { cwd, command, timeoutMs: 5000,
    sandboxPolicy: codexSandboxPolicy('read-only', [cwd]) });
  assert.notEqual(readonly.exitCode, 0, 'Reviewer write must be rejected.');
  assert.equal(await readFile(file, 'utf8'), 'before');
  console.log(JSON.stringify({ runtime: '0.160.1', modelTurns: 0, implementerWritePersisted: true, reviewerWriteRejected: true, reviewerFileUnchanged: true }));
} finally { client.close(); await rm(cwd, { recursive: true, force: true }); }
