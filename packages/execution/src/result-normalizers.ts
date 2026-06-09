import type { ResultToleranceEvent, StepResultValidationFailureCode } from './result-tolerance.js';

export interface ResultNormalizerInput {
  readonly candidate: unknown;
  readonly runId?: string;
  readonly step: string;
  readonly schemaId: string;
  readonly attempt: number;
}

export type ResultNormalizerOutcome =
  | { readonly status: 'unchanged' }
  | { readonly status: 'changed'; readonly candidate: unknown; readonly message: string }
  | { readonly status: 'ambiguous'; readonly message: string };

export interface ResultNormalizer {
  readonly id: string;
  readonly description: string;
  normalize(input: ResultNormalizerInput): ResultNormalizerOutcome;
}

export interface FilenameAliasNormalizerOptions {
  readonly id: string;
  readonly description?: string;
  readonly path: readonly (string | number)[];
  readonly aliases: Readonly<Record<string, string>>;
}

export interface UrlWrappedIdentifierNormalizerOptions {
  readonly id: string;
  readonly description?: string;
  readonly path: readonly (string | number)[];
  readonly allowedOrigins?: readonly string[];
  readonly identifierPattern: RegExp;
}

export interface ResultNormalizerRegistry {
  readonly normalizers: readonly ResultNormalizer[];
  register(normalizer: ResultNormalizer): ResultNormalizerRegistry;
  normalize(input: ResultNormalizerInput): {
    candidate: unknown;
    events: readonly ResultToleranceEvent[];
    normalized: boolean;
    ambiguous: boolean;
    failed: boolean;
  };
}

export function createResultNormalizerRegistry(normalizers: readonly ResultNormalizer[] = []): ResultNormalizerRegistry {
  const items: ResultNormalizer[] = [];

  const assertUnique = (normalizer: ResultNormalizer): void => {
    if (items.some((existing) => existing.id === normalizer.id)) {
      throw new Error(`Duplicate normalizer id '${normalizer.id}'.`);
    }
  };

  const registry: ResultNormalizerRegistry = {
    get normalizers() { return [...items]; },
    register(normalizer) {
      assertUnique(normalizer);
      items.push(normalizer);
      return registry;
    },
    normalize(input) {
      let candidate = input.candidate;
      const events: ResultToleranceEvent[] = [];
      let normalized = false;
      let ambiguous = false;

      for (const normalizer of items) {
        let outcome: ResultNormalizerOutcome;
        try {
          outcome = normalizer.normalize({ ...input, candidate });
        } catch {
          return {
            candidate,
            events: [...events, {
              kind: 'failed',
              code: 'normalizer_failed' as StepResultValidationFailureCode,
              normalizerId: normalizer.id,
              message: 'Normalizer failed.'
            }],
            normalized,
            ambiguous,
            failed: true
          };
        }

        if (outcome.status === 'changed') {
          candidate = outcome.candidate;
          normalized = true;
          events.push({ kind: 'normalized', normalizerId: normalizer.id, message: outcome.message });
        } else if (outcome.status === 'ambiguous') {
          ambiguous = true;
          events.push({ kind: 'ambiguous', code: 'ambiguous_normalization', normalizerId: normalizer.id, message: outcome.message });
        }
      }

      return { candidate, events, normalized, ambiguous, failed: false };
    }
  };

  for (const normalizer of normalizers) registry.register(normalizer);
  return registry;
}

export const defaultResultNormalizers: readonly ResultNormalizer[] = [];

export function createFilenameAliasNormalizer(options: FilenameAliasNormalizerOptions): ResultNormalizer {
  if (Object.keys(options.aliases).length === 0) {
    throw new Error('Filename alias normalizer requires at least one alias mapping.');
  }
  return {
    id: options.id,
    description: options.description ?? `Filename alias normalizer for field at path '${options.path.join('.')}'.`,
    normalize(input) {
      const value = getAtPath(input.candidate, options.path);
      if (typeof value !== 'string') return { status: 'unchanged' };
      const canonical = options.aliases[value];
      if (canonical === undefined) return { status: 'unchanged' };
      return {
        status: 'changed',
        candidate: setAtPath(input.candidate, options.path, canonical),
        message: `Mapped filename alias '${value}' to '${canonical}'.`
      };
    }
  };
}

export function createUrlWrappedIdentifierNormalizer(options: UrlWrappedIdentifierNormalizerOptions): ResultNormalizer {
  return {
    id: options.id,
    description: options.description ?? `URL-wrapped identifier normalizer for field at path '${options.path.join('.')}'.`,
    normalize(input) {
      const value = getAtPath(input.candidate, options.path);
      if (typeof value !== 'string') return { status: 'unchanged' };

      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return { status: 'unchanged' };
      }

      if (options.allowedOrigins !== undefined && !options.allowedOrigins.includes(url.origin)) {
        return { status: 'unchanged' };
      }

      const matches = [...value.matchAll(new RegExp(options.identifierPattern.source, options.identifierPattern.flags.includes('g') ? options.identifierPattern.flags : options.identifierPattern.flags + 'g'))];
      if (matches.length !== 1) {
        return { status: 'ambiguous', message: 'URL contains multiple or no matching identifiers.' };
      }
      const match = matches[0];
      const captured = match[1];
      if (captured === undefined) return { status: 'unchanged' };
      return {
        status: 'changed',
        candidate: setAtPath(input.candidate, options.path, captured),
        message: 'Extracted identifier from URL.'
      };
    }
  };
}

function getAtPath(input: unknown, path: readonly (string | number)[]): unknown {
  let current = input;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) return undefined;
      current = current[segment];
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current) || !(segment in current)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current;
}

function setAtPath(input: unknown, path: readonly (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...tail] = path;
  if (typeof head === 'number') {
    const source = Array.isArray(input) ? input : [];
    const next = [...source];
    next[head] = setAtPath(next[head], tail, value);
    return next;
  }
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return { ...source, [head as string]: setAtPath(source[head as string], tail, value) };
}
