/**
 * Spec-capable work-kind tests: the classification for every create work kind, and a
 * source-level parity check against `specArtifactKindForRun` in
 * `packages/core/src/control-plane-service.ts` so the two cannot drift.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SPEC_CAPABLE_WORK_KINDS, isSpecCapableWorkKind } from './run-spec-kinds.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// runs -> src -> web -> apps -> <repo root>
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const SERVICE_FILE = join(REPO_ROOT, 'packages/core/src/control-plane-service.ts');

describe('isSpecCapableWorkKind', () => {
  it('accepts feature and enhancement', () => {
    expect(isSpecCapableWorkKind('feature')).toBe(true);
    expect(isSpecCapableWorkKind('enhancement')).toBe(true);
  });

  it.each(['bug', 'chore', 'file_issue', 'question'])(
    'rejects %s (no API-served spec)',
    (workKind) => {
      expect(isSpecCapableWorkKind(workKind)).toBe(false);
    }
  );
});

describe('parity with specArtifactKindForRun', () => {
  it('maps exactly the same work kinds to a spec artifact', () => {
    const source = readFileSync(SERVICE_FILE, 'utf-8');
    const start = source.indexOf('function specArtifactKindForRun');
    expect(start, 'specArtifactKindForRun should exist in control-plane-service.ts').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('\n}', start);
    const body = source.slice(start, end);

    // Collect every work kind the control-plane function maps to a non-null spec kind.
    const mapped = new Set<string>();
    const pattern = /workKind === '([^']+)'/gu;
    let match: RegExpExecArray | null = pattern.exec(body);
    while (match !== null) {
      if (match[1] !== undefined) {
        mapped.add(match[1]);
      }
      match = pattern.exec(body);
    }

    expect([...mapped].sort()).toEqual([...SPEC_CAPABLE_WORK_KINDS].sort());
  });
});
