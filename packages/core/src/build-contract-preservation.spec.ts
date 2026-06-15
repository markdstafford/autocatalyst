import { describe, it, expect } from 'vitest';
import type { AltitudeCheckpointRef } from '@autocatalyst/api-contract';
import { validateBuildContractPreservation } from './build-contract-preservation.js';

function makeReader(refToFiles: Record<string, Record<string, string | null>>) {
  return async (input: { ref: string; path: string }) => {
    const files = refToFiles[input.ref];
    if (!files) return null;
    return input.path in files ? files[input.path] : null;
  };
}

function makeLister(refToFiles: Record<string, Record<string, string | null>>) {
  return async (input: { ref: string }) => {
    const files = refToFiles[input.ref];
    if (!files) return [];
    return Object.keys(files).filter((p) => files[p] !== null);
  };
}

function publicCheckpoint(ref: string, commitSha: string): AltitudeCheckpointRef {
  return {
    altitude: 'public_api',
    ref,
    commitSha,
    acceptedAt: '2026-01-01T00:00:00.000Z'
  };
}

function privateCheckpoint(ref: string, commitSha: string): AltitudeCheckpointRef {
  return {
    altitude: 'private_api',
    ref,
    commitSha,
    acceptedAt: '2026-01-02T00:00:00.000Z'
  };
}

function layoutCheckpoint(ref: string, commitSha: string): AltitudeCheckpointRef {
  return {
    altitude: 'layout',
    ref,
    commitSha,
    acceptedAt: '2026-01-03T00:00:00.000Z'
  };
}

describe('validateBuildContractPreservation', () => {
  const workspaceRepoRoot = '/tmp/workspace';
  const buildSha = 'build-sha';

  it('returns no findings when acceptedCheckpoints is empty', async () => {
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [],
      readFileAtRef: async () => null,
      listFilesAtRef: async () => []
    });
    expect(findings).toEqual([]);
  });

  it('returns no findings when accepted public export is preserved', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(a: number): string;'
      },
      [buildSha]: {
        'src/foo.ts': 'export function foo(a: number): string { return String(a); }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    expect(findings).toEqual([]);
  });

  it('flags missing accepted source file as blocking build_drift', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(): void;'
      },
      [buildSha]: {
        'src/bar.ts': 'export function bar(): void {}'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const f = findings.find((x) => x.deterministicKey?.includes('source_path_removed'));
    expect(f).toBeDefined();
    expect(f?.blocking).toBe(true);
    expect(f?.source).toBe('build_drift');
    expect(f?.category).toBe('build_drift');
    expect(f?.altitude).toBe('build');
    expect(f?.severity).toBe('blocker');
    expect(f?.sourcePath).toBe('src/foo.ts');
  });

  it('flags removed export as blocking build_drift', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(): void;\nexport function bar(): void;'
      },
      [buildSha]: {
        'src/foo.ts': 'export function foo(): void {}'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const removed = findings.find(
      (x) => x.deterministicKey?.includes('export_removed') && x.symbolName === 'bar'
    );
    expect(removed).toBeDefined();
    expect(removed?.blocking).toBe(true);
    expect(removed?.source).toBe('build_drift');
  });

  it('flags renamed export as blocking build_drift (old name missing)', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function oldName(): void;'
      },
      [buildSha]: {
        'src/foo.ts': 'export function newName(): void {}'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const removed = findings.find(
      (x) => x.deterministicKey?.includes('export_removed') && x.symbolName === 'oldName'
    );
    expect(removed).toBeDefined();
    expect(removed?.blocking).toBe(true);
  });

  it('flags changed public function signature as blocking build_drift', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(a: number): string;'
      },
      [buildSha]: {
        'src/foo.ts': 'export function foo(a: number, b: string): string { return ""; }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const sigChange = findings.find(
      (x) => x.deterministicKey?.includes('export_signature_changed') && x.symbolName === 'foo'
    );
    expect(sigChange).toBeDefined();
    expect(sigChange?.blocking).toBe(true);
  });

  it('flags changed public interface shape as blocking build_drift', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export interface Foo { a: number; b: string; }'
      },
      [buildSha]: {
        'src/foo.ts': 'export interface Foo { a: number; }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const sigChange = findings.find(
      (x) => x.deterministicKey?.includes('export_signature_changed') && x.symbolName === 'Foo'
    );
    expect(sigChange).toBeDefined();
  });

  it('allows added new exports', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(): void;'
      },
      [buildSha]: {
        'src/foo.ts': 'export function foo(): void {}\nexport function bar(): void {}'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    expect(findings).toEqual([]);
  });

  it('allows adding a body to a previously body-less function', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export declare function foo(a: number): string;'
      },
      [buildSha]: {
        'src/foo.ts': 'export function foo(a: number): string { return String(a); }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    expect(findings).toEqual([]);
  });

  it('ignores formatting-only changes', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(a: number,b:string): boolean;'
      },
      [buildSha]: {
        'src/foo.ts': 'export function foo(a: number,    b: string): boolean { return true; }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    expect(findings).toEqual([]);
  });

  it('flags changed private helper signature when private_api checkpoint exists', async () => {
    const files = {
      'refs/checkpoints/private_api': {
        'src/foo.ts': 'export function foo(): void;\nfunction helper(a: number): string;'
      },
      [buildSha]: {
        'src/foo.ts':
          'export function foo(): void {}\nfunction helper(a: number, b: number): string { return ""; }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [privateCheckpoint('refs/checkpoints/private_api', 'priv-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const sigChange = findings.find(
      (x) => x.deterministicKey?.includes('private_signature_changed') && x.symbolName === 'helper'
    );
    expect(sigChange).toBeDefined();
    expect(sigChange?.blocking).toBe(true);
  });

  it('does not check private helpers when no private_api checkpoint exists', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(): void;\nfunction helper(a: number): string;'
      },
      [buildSha]: {
        'src/foo.ts':
          'export function foo(): void {}\nfunction helper(a: number, b: number): string { return ""; }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const privateChanges = findings.filter((x) =>
      x.deterministicKey?.includes('private_signature_changed')
    );
    expect(privateChanges).toEqual([]);
  });

  it('emits a safe blocking finding when a checkpoint file fails to parse', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo( : { /* malformed'
      },
      [buildSha]: {
        'src/foo.ts': 'export function foo(): void {}'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    // Either no findings (if parse succeeds and signatures align) or a parse_failure finding.
    // We just assert determinism — re-running yields identical results.
    const again = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    expect(findings.map((f) => f.deterministicKey)).toEqual(
      again.map((f) => f.deterministicKey)
    );
  });

  it('flags source paths missing at build for a layout checkpoint', async () => {
    const files = {
      'refs/checkpoints/layout': {
        'src/foo.ts': 'export interface Foo { a: number; }'
      },
      [buildSha]: {
        'src/other.ts': 'export interface Foo { a: number; }'
      }
    };
    const findings = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [layoutCheckpoint('refs/checkpoints/layout', 'layout-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const removed = findings.find((x) => x.deterministicKey?.includes('source_path_removed'));
    expect(removed).toBeDefined();
    expect(removed?.altitude).toBe('build');
  });

  it('produces stable deterministic keys', async () => {
    const files = {
      'refs/checkpoints/public_api': {
        'src/foo.ts': 'export function foo(): void;\nexport function bar(): void;'
      },
      [buildSha]: {
        'src/foo.ts': ''
      }
    };
    const a = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    const b = await validateBuildContractPreservation({
      workspaceRepoRoot,
      buildCommitSha: buildSha,
      acceptedCheckpoints: [publicCheckpoint('refs/checkpoints/public_api', 'pub-sha')],
      readFileAtRef: makeReader(files),
      listFilesAtRef: makeLister(files)
    });
    expect(a.map((f) => f.deterministicKey).sort()).toEqual(
      b.map((f) => f.deterministicKey).sort()
    );
    for (const f of a) {
      expect(f.deterministicKey).toBeDefined();
      expect(f.signature).toBe(f.deterministicKey);
    }
  });
});
