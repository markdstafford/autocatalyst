import { describe, it, expect } from 'vitest';
import { validateAltitudeContract } from './altitude-contract-validator.js';

function makeReader(files: Record<string, string | null>): (p: string) => Promise<string | null> {
  return async (path: string) => (path in files ? files[path] : null);
}

describe('validateAltitudeContract', () => {
  const baseSha = 'deadbeef';

  it('returns no findings for an interface declaration only', async () => {
    const text = `export interface Foo { a: number; b(): void; }`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('returns no findings for a type alias', async () => {
    const text = `export type Foo = { a: number };`;
    const findings = await validateAltitudeContract({
      altitude: 'layout',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('returns no findings for type-only imports', async () => {
    const text = `import type { Foo } from './foo.js';\nexport type Bar = Foo;`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/bar.ts'],
      readFileAtRef: makeReader({ 'src/bar.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('returns no findings for declare function', async () => {
    const text = `export declare function foo(a: number): string;`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('blocks test files at early altitudes', async () => {
    const text = `export type Foo = { a: number };`;
    const findings = await validateAltitudeContract({
      altitude: 'layout',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.spec.ts'],
      readFileAtRef: makeReader({ 'src/foo.spec.ts': text })
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].blocking).toBe(true);
    expect(findings[0].severity).toBe('blocker');
    expect(findings[0].source).toBe('altitude_contract');
    expect(findings[0].deterministicKey).toContain('is_test_file');
  });

  it('blocks .tsx files at early altitudes', async () => {
    const text = `export const Foo = () => null;`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.tsx'],
      readFileAtRef: makeReader({ 'src/foo.tsx': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('is_jsx_file'))).toBe(true);
  });

  it('blocks non-TypeScript source files', async () => {
    const findings = await validateAltitudeContract({
      altitude: 'layout',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.js'],
      readFileAtRef: makeReader({ 'src/foo.js': 'module.exports = 1;' })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('non_ts_source'))).toBe(true);
  });

  it('blocks function with body', async () => {
    const text = `export function add(a: number, b: number): number { return a + b; }`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/add.ts'],
      readFileAtRef: makeReader({ 'src/add.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('has_function_body'))).toBe(true);
  });

  it('blocks arrow function with body assigned to const', async () => {
    const text = `export const foo = (a: number) => a + 1;`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.blocking)).toBe(true);
  });

  it('blocks class with method body', async () => {
    const text = `export class Foo { greet(): string { return 'hi'; } }`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.blocking)).toBe(true);
  });

  it('allows class declared as ambient', async () => {
    const text = `export declare class Foo { greet(): string; }`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('allows class with only signatures', async () => {
    const text = `export abstract class Foo { abstract greet(): string; }`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('blocks top-level const with initializer', async () => {
    const text = `export const x = 5;`;
    const findings = await validateAltitudeContract({
      altitude: 'layout',
      headCommitSha: baseSha,
      changedFiles: ['src/x.ts'],
      readFileAtRef: makeReader({ 'src/x.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('top_level_initializer'))).toBe(true);
  });

  it('allows declare const', async () => {
    const text = `export declare const x: number;`;
    const findings = await validateAltitudeContract({
      altitude: 'layout',
      headCommitSha: baseSha,
      changedFiles: ['src/x.ts'],
      readFileAtRef: makeReader({ 'src/x.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('blocks side-effect imports', async () => {
    const text = `import './side-effect.js';\nexport type Foo = number;`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('side_effect_import'))).toBe(true);
  });

  it('blocks runtime enum', async () => {
    const text = `export enum Color { Red, Blue }`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/color.ts'],
      readFileAtRef: makeReader({ 'src/color.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('runtime_enum'))).toBe(true);
  });

  it('allows declare enum', async () => {
    const text = `export declare enum Color { Red, Blue }`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/color.ts'],
      readFileAtRef: makeReader({ 'src/color.ts': text })
    });
    expect(findings).toEqual([]);
  });

  it('blocks top-level executable expression statement', async () => {
    const text = `console.log('hi');\nexport type Foo = number;`;
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/foo.ts'],
      readFileAtRef: makeReader({ 'src/foo.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('top_level_statement'))).toBe(true);
  });

  it('blocks files inside __tests__', async () => {
    const text = `export type Foo = number;`;
    const findings = await validateAltitudeContract({
      altitude: 'layout',
      headCommitSha: baseSha,
      changedFiles: ['src/__tests__/foo.ts'],
      readFileAtRef: makeReader({ 'src/__tests__/foo.ts': text })
    });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some(f => f.deterministicKey?.includes('is_test_file'))).toBe(true);
  });

  it('skips deleted files (readFileAtRef returns null)', async () => {
    const findings = await validateAltitudeContract({
      altitude: 'public_api',
      headCommitSha: baseSha,
      changedFiles: ['src/gone.ts'],
      readFileAtRef: makeReader({ 'src/gone.ts': null })
    });
    expect(findings).toEqual([]);
  });

  it('produces deterministic keys with consistent format', async () => {
    const text = `export const x = 1;`;
    const findings = await validateAltitudeContract({
      altitude: 'layout',
      headCommitSha: baseSha,
      changedFiles: ['src/x.ts'],
      readFileAtRef: makeReader({ 'src/x.ts': text })
    });
    expect(findings[0].deterministicKey).toMatch(/^altitude_contract:layout:src\/x\.ts:/);
    expect(findings[0].signature).toBe(findings[0].deterministicKey);
    expect(findings[0].sourcePath).toBe('src/x.ts');
    expect(findings[0].altitude).toBe('layout');
  });
});
