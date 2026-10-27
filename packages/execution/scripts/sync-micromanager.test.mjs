import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyTree } from './sync-micromanager.mjs';

const canonicalRoot = fileURLToPath(new URL('../src/skills/assets/mm/', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(canonicalRoot, 'SOURCE.json'), 'utf8'));
const template = 'plugins/mm/skills/planning/references/templates/enhancement.md';

function fixture(check) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-fidelity-test-'));
  try {
    cpSync(canonicalRoot, dir, { recursive: true });
    check(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('accepts the complete pinned tree including supplemental and hidden files', () => {
  verifyTree(canonicalRoot, manifest);
  assert.ok(manifest.files['.eng-docs/specs/enhancement-spec-lifecycle-state.md']);
  assert.ok(manifest.files['plugins/mm/.claude-plugin/plugin.json']);
});

test('rejects independently edited canonical templates', () => fixture((dir) => {
  writeFileSync(path.join(dir, template), '# Replacement template');
  assert.throws(() => verifyTree(dir, manifest), /content mismatch/);
}));

test('rejects missing nested resources', () => fixture((dir) => {
  rmSync(path.join(dir, template));
  assert.throws(() => verifyTree(dir, manifest), /Missing or unexpected/);
}));

test('rejects added substitute files', () => fixture((dir) => {
  writeFileSync(path.join(dir, 'enhancement-spec.md'), '# Substitute');
  assert.throws(() => verifyTree(dir, manifest), /Missing or unexpected/);
}));

test('rejects provenance changed together with a corrupted copy', () => fixture((dir) => {
  const content = '# Replacement template';
  writeFileSync(path.join(dir, template), content);
  const changed = structuredClone(manifest);
  changed.files[template] = createHash('sha256').update(content).digest('hex');
  writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify(changed, null, 2) + '\n');
  assert.throws(() => verifyTree(dir, manifest), /content mismatch/);
}));

test('rejects symlink resources', () => fixture((dir) => {
  rmSync(path.join(dir, template));
  symlinkSync(path.join(canonicalRoot, template), path.join(dir, template));
  assert.throws(() => verifyTree(dir, manifest), /Unexpected symlink/);
}));

test('rejects incomplete dist trees even when entrypoint files exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-dist-test-'));
  try {
    mkdirSync(path.join(dir, 'plugins/mm/skills/planning'), { recursive: true });
    cpSync(path.join(canonicalRoot, 'plugins/mm/skills/planning/SKILL.md'), path.join(dir, 'plugins/mm/skills/planning/SKILL.md'));
    assert.throws(() => verifyTree(dir, manifest), /Missing or unexpected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
