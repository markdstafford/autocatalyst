import type { ResultToleranceEvent, StepResultValidationFailureCode } from './result-tolerance.js';
import {
  IMPLEMENTER_DISPOSITIONS_SCHEMA_ID,
  PR_FINALIZE_SCHEMA_ID,
  REVIEWER_RESULT_SCHEMA_ID,
  SPEC_AUTHOR_SCHEMA_ID,
  stampSpecAuthorResultIdentity,
  type SpecAuthorResultContractOptions
} from './result-contracts.js';

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

export function createResultNormalizerRegistry(normalizers: readonly ResultNormalizer[] = defaultResultNormalizers): ResultNormalizerRegistry {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value as object) as unknown;
  return proto === Object.prototype || proto === null;
}

const allowedModelSpecFrontmatterKeys = new Set(['implemented_by', 'supersedes', 'superseded_by']);
const systemOwnedSpecFrontmatterKeys = new Set(['created', 'last_updated', 'status', 'issue', 'specced_by']);

function sanitizeSpecAuthorFrontmatter(candidate: unknown): unknown {
  if (!isPlainObject(candidate)) return candidate;
  const frontmatter = candidate['frontmatter'];
  if (!isPlainObject(frontmatter)) return candidate;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (systemOwnedSpecFrontmatterKeys.has(key)) continue;
    if (!allowedModelSpecFrontmatterKeys.has(key)) continue;
    if (value === null) continue;
    sanitized[key] = value;
  }

  return { ...candidate, frontmatter: sanitized };
}

export function createSpecAuthorFrontmatterNormalizer(
  options: SpecAuthorResultContractOptions = {}
): ResultNormalizer {
  return {
    id: 'spec-author-frontmatter-contract',
    description: 'Drops model-owned stray frontmatter, removes optional nulls, and stamps system-owned spec frontmatter.',
    normalize(input) {
      if (input.schemaId !== SPEC_AUTHOR_SCHEMA_ID) return { status: 'unchanged' };
      const sanitized = sanitizeSpecAuthorFrontmatter(input.candidate);
      const stamped = stampSpecAuthorResultIdentity(sanitized, options);
      if (stamped === input.candidate) return { status: 'unchanged' };
      return {
        status: 'changed',
        candidate: stamped,
        message: 'Normalized spec.author frontmatter to the system-owned contract.'
      };
    }
  };
}

function hasOnlyKeys(candidate: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(candidate).every((key) => allowed.has(key));
}

export const prFinalizeCleanResultNormalizer: ResultNormalizer = {
  id: 'pr-finalize-clean-result',
  description: 'Normalizes deterministic clean pr.finalize omission-only results.',
  normalize(input) {
    if (input.schemaId !== PR_FINALIZE_SCHEMA_ID) return { status: 'unchanged' };
    if (!isPlainObject(input.candidate)) return { status: 'unchanged' };

    const candidate = input.candidate;
    const keys = Object.keys(candidate);
    if (keys.length === 0) {
      return {
        status: 'changed',
        candidate: { directive: 'advance', findings: [] },
        message: 'Normalized empty pr.finalize result to clean advance.'
      };
    }

    if (keys.length === 1 && Array.isArray(candidate['findings']) && candidate['findings'].length === 0) {
      return {
        status: 'changed',
        candidate: { directive: 'advance', findings: [] },
        message: 'Normalized empty pr.finalize findings to clean advance.'
      };
    }

    if (hasOnlyKeys(candidate, ['validationSummary']) && Array.isArray(candidate['validationSummary']) && candidate['validationSummary'].length === 0) {
      return {
        status: 'changed',
        candidate: { directive: 'advance', validationSummary: [], findings: [] },
        message: 'Normalized omission-only pr.finalize result to clean advance.'
      };
    }

    return { status: 'unchanged' };
  }
};

export const reviewerResultNormalizer: ResultNormalizer = {
  id: 'reviewer-result-clean-review',
  description: 'Normalizes the reviewer-authored "no findings" near miss; never fabricates a verdict from an empty result.',
  normalize(input) {
    if (input.schemaId !== REVIEWER_RESULT_SCHEMA_ID) return { status: 'unchanged' };
    if (!isPlainObject(input.candidate)) return { status: 'unchanged' };

    // An empty object is left unchanged on purpose: it means the reviewer never
    // authored a verdict, which must surface as a real fault during schema
    // validation — not be fabricated into a satisfied review.
    const keys = Object.keys(input.candidate);
    if (keys.length === 1 && Object.prototype.hasOwnProperty.call(input.candidate, 'findings')) {
      const findings = input.candidate['findings'];
      if (Array.isArray(findings) && findings.length === 0) {
        return {
          status: 'changed',
          candidate: { status: 'satisfied', findings: [] },
          message: 'Normalized empty reviewer findings to satisfied clean review.'
        };
      }
    }

    return { status: 'unchanged' };
  }
};

export const reviewerNullFindingsNormalizer: ResultNormalizer = {
  id: 'reviewer-null-findings-strip',
  description: 'Strips null findings from reviewer results returned by OpenAI strict-mode structured output.',
  normalize(input) {
    if (input.schemaId !== REVIEWER_RESULT_SCHEMA_ID) return { status: 'unchanged' };
    if (!isPlainObject(input.candidate)) return { status: 'unchanged' };
    if (!Object.prototype.hasOwnProperty.call(input.candidate, 'findings') || input.candidate['findings'] !== null) {
      return { status: 'unchanged' };
    }
    const { findings: _discarded, ...rest } = input.candidate;
    return {
      status: 'changed',
      candidate: rest,
      message: 'Stripped null findings from reviewer result.'
    };
  }
};

export const implementerDispositionsNullStripNormalizer: ResultNormalizer = {
  id: 'implementer-dispositions-null-strip',
  description: 'Strips null dispositions from implementer disposition results returned by OpenAI strict-mode structured output.',
  normalize(input) {
    if (input.schemaId !== IMPLEMENTER_DISPOSITIONS_SCHEMA_ID) return { status: 'unchanged' };
    if (!isPlainObject(input.candidate)) return { status: 'unchanged' };
    if (!Object.prototype.hasOwnProperty.call(input.candidate, 'dispositions') || input.candidate['dispositions'] !== null) {
      return { status: 'unchanged' };
    }
    const { dispositions: _discarded, ...rest } = input.candidate;
    return {
      status: 'changed',
      candidate: rest,
      message: 'Stripped null dispositions from implementer dispositions result.'
    };
  }
};

export const prFinalizeNullStripNormalizer: ResultNormalizer = {
  id: 'pr-finalize-null-strip',
  description: 'Strips null optional fields from pr.finalize results returned by OpenAI strict-mode structured output.',
  normalize(input) {
    if (input.schemaId !== PR_FINALIZE_SCHEMA_ID) return { status: 'unchanged' };
    if (!isPlainObject(input.candidate)) return { status: 'unchanged' };
    const nullableFields = ['reconciledSummary', 'titleSubject', 'validationSummary'] as const;
    const stripped: string[] = [];
    const result: Record<string, unknown> = { ...input.candidate };
    for (const field of nullableFields) {
      if (Object.prototype.hasOwnProperty.call(result, field) && result[field] === null) {
        delete result[field];
        stripped.push(field);
      }
    }
    if (stripped.length === 0) return { status: 'unchanged' };
    return {
      status: 'changed',
      candidate: result,
      message: `Stripped null optional fields from pr.finalize result: ${stripped.join(', ')}.`
    };
  }
};

export const defaultResultNormalizers: readonly ResultNormalizer[] = [reviewerResultNormalizer];

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
  // Build the global version of the pattern once at construction time
  const globalPattern = new RegExp(
    options.identifierPattern.source,
    options.identifierPattern.flags.includes('g') ? options.identifierPattern.flags : options.identifierPattern.flags + 'g'
  );
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

      // Reset lastIndex for stateful global regexes
      globalPattern.lastIndex = 0;
      const matches = [...value.matchAll(globalPattern)];
      if (matches.length !== 1) {
        return { status: 'ambiguous', message: 'URL contains multiple or no matching identifiers.' };
      }
      const match = matches[0]!;
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
