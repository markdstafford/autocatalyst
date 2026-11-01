/**
 * Build-time guard against Node-only imports leaking into a browser bundle.
 *
 * The web app resolves `@autocatalyst/sdk` and `@autocatalyst/api-contract` from
 * source (see the Vite aliases), so a Node-only import hidden inside a workspace
 * package would otherwise be bundled into a browser chunk and fail only at
 * runtime. This guard inspects every emitted JavaScript chunk and fails the
 * build when it finds an import or require of a `node:`-scheme module.
 *
 * The detector is a pure function so it can be unit-tested without running a
 * full Vite build; the plugin wrapper applies it to the real emitted bundle.
 */
import type { Plugin } from 'vite';

/** One offending `node:` reference found in a chunk. */
export interface NodeImportViolation {
  readonly fileName: string;
  readonly specifier: string;
}

// Matches `node:`-scheme specifiers reached through any module syntax a bundle
// can emit: static `import`/`export ... from`, dynamic `import()`, and `require()`.
const NODE_SPECIFIER = String.raw`['"](node:[^'"]+)['"]`;
const NODE_IMPORT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bfrom\s*${NODE_SPECIFIER}`, 'g'),
  new RegExp(String.raw`\bimport\s*${NODE_SPECIFIER}`, 'g'),
  new RegExp(String.raw`\bimport\s*\(\s*${NODE_SPECIFIER}`, 'g'),
  new RegExp(String.raw`\brequire\s*\(\s*${NODE_SPECIFIER}`, 'g')
];

/**
 * Return every `node:` import/require specifier found in `code`. Empty when the
 * chunk is browser-safe. Deduplicated per specifier so one offending module is
 * reported once.
 */
export function findNodeImports(code: string): string[] {
  const found = new Set<string>();
  for (const pattern of NODE_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(code);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined) {
        found.add(specifier);
      }
      match = pattern.exec(code);
    }
  }
  return [...found];
}

/**
 * Scan a map of emitted chunk file names to code and return all violations.
 */
export function scanChunksForNodeImports(
  chunks: ReadonlyArray<{ readonly fileName: string; readonly code: string }>
): NodeImportViolation[] {
  const violations: NodeImportViolation[] = [];
  for (const chunk of chunks) {
    for (const specifier of findNodeImports(chunk.code)) {
      violations.push({ fileName: chunk.fileName, specifier });
    }
  }
  return violations;
}

/**
 * Format violations into a single error message naming each offending chunk and
 * specifier.
 */
export function formatNodeImportError(violations: readonly NodeImportViolation[]): string {
  const lines = violations.map((v) => `  - ${v.fileName} imports ${v.specifier}`);
  return [
    'Browser bundle contains Node-only imports; these must not reach the client:',
    ...lines
  ].join('\n');
}

/**
 * Vite plugin that fails the production build when an emitted browser chunk
 * imports a `node:`-scheme module.
 */
export function nodeImportGuard(): Plugin {
  return {
    name: 'autocatalyst-node-import-guard',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks: Array<{ fileName: string; code: string }> = [];
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          chunks.push({ fileName: item.fileName, code: item.code });
        }
      }
      const violations = scanChunksForNodeImports(chunks);
      if (violations.length > 0) {
        this.error(formatNodeImportError(violations));
      }
    }
  };
}
