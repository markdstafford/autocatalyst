/**
 * Tests for the browser-bundle Node-import guard. These exercise the pure
 * detector the Vite plugin uses, proving it catches an injected `node:` import
 * across every module syntax a bundle can emit, and that it leaves browser-safe
 * chunks alone. (The plugin's end-to-end "a clean build passes" behavior is
 * covered by the real build in built-output.spec.ts.)
 */
import { describe, expect, it } from 'vitest';

import {
  findNodeImports,
  formatNodeImportError,
  scanChunksForNodeImports
} from './node-import-guard.js';

describe('findNodeImports', () => {
  it('detects a static import of a node: module', () => {
    expect(findNodeImports(`import { readFile } from "node:fs";`)).toEqual(['node:fs']);
  });

  it('detects a dynamic import of a node: module', () => {
    expect(findNodeImports(`const p = import('node:path');`)).toEqual(['node:path']);
  });

  it('detects a require of a node: module', () => {
    expect(findNodeImports(`const os = require("node:os");`)).toEqual(['node:os']);
  });

  it('deduplicates repeated specifiers', () => {
    const code = `import "node:fs"; const x = require('node:fs');`;
    expect(findNodeImports(code)).toEqual(['node:fs']);
  });

  it('returns nothing for a browser-safe chunk', () => {
    const code = `import React from "react"; export const x = 1;`;
    expect(findNodeImports(code)).toEqual([]);
  });
});

describe('scanChunksForNodeImports', () => {
  it('rejects a chunk with an injected Node-only import', () => {
    const violations = scanChunksForNodeImports([
      { fileName: 'assets/app-abc123.js', code: `import { createServer } from "node:http";` },
      { fileName: 'assets/safe-def456.js', code: `export const ok = true;` }
    ]);
    expect(violations).toEqual([{ fileName: 'assets/app-abc123.js', specifier: 'node:http' }]);
  });

  it('returns no violations when every chunk is browser-safe', () => {
    const violations = scanChunksForNodeImports([
      { fileName: 'assets/app-abc123.js', code: `export const ok = true;` }
    ]);
    expect(violations).toEqual([]);
  });
});

describe('formatNodeImportError', () => {
  it('names each offending chunk and specifier', () => {
    const message = formatNodeImportError([
      { fileName: 'assets/app-abc123.js', specifier: 'node:http' }
    ]);
    expect(message).toContain('assets/app-abc123.js');
    expect(message).toContain('node:http');
  });
});
