import { z } from 'zod';
import type { ResultDegradationPolicy, ResultValidationIssue } from './result-tolerance.js';
import {
  reviewerResultSchema,
  specAuthorFrontmatterSchema,
  specAuthorResultSchema
} from '@autocatalyst/api-contract';

export interface StepResultContractDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly step: string;
  readonly schemaId: string;
  readonly schema: TSchema;
  readonly resultFile?: string;
  readonly degradationPolicy?: ResultDegradationPolicy;
}

export interface StepResultContractResolutionFailure {
  readonly status: 'failed';
  readonly code: 'result_contract_missing' | 'result_contract_unknown';
  readonly safeMessage: string;
  readonly issues: readonly ResultValidationIssue[];
}

export type StepResultContractResolution<TSchema extends z.ZodTypeAny = z.ZodTypeAny> =
  | { readonly status: 'resolved'; readonly contract: StepResultContractDefinition<TSchema> }
  | StepResultContractResolutionFailure;

export interface StepResultContractRegistry {
  readonly contracts: readonly StepResultContractDefinition[];
  register(definition: StepResultContractDefinition): StepResultContractRegistry;
  resolve(input: { readonly step: string; readonly schemaId?: string }): StepResultContractResolution;
}

export type StepResultContractResolver = (input: unknown) => StepResultContractResolution | Promise<StepResultContractResolution>;

export function createStepResultContractRegistry(
  definitions: readonly StepResultContractDefinition[] = []
): StepResultContractRegistry {
  const contracts: StepResultContractDefinition[] = [];

  const assertUnique = (definition: StepResultContractDefinition): void => {
    if (contracts.some((existing) => existing.step === definition.step && existing.schemaId === definition.schemaId)) {
      throw new Error(`Duplicate step result contract for step '${definition.step}' and schemaId '${definition.schemaId}'.`);
    }
  };

  const registry: StepResultContractRegistry = {
    get contracts() { return [...contracts]; },
    register(definition) {
      assertUnique(definition);
      contracts.push(definition);
      return registry;
    },
    resolve(input) {
      return resolveStepResultContract({ registry, ...input });
    }
  };

  for (const definition of definitions) registry.register(definition);
  return registry;
}

export function resolveStepResultContract(input: {
  readonly registry: StepResultContractRegistry;
  readonly step: string;
  readonly schemaId?: string;
}): StepResultContractResolution {
  if (input.step.length === 0 || input.schemaId === undefined || input.schemaId.length === 0) {
    return contractFailure('result_contract_missing', 'Missing step result contract selection.');
  }

  const contract = input.registry.contracts.find(
    (candidate) => candidate.step === input.step && candidate.schemaId === input.schemaId
  );
  if (contract === undefined) {
    return contractFailure('result_contract_unknown', 'Unknown step result contract for step and schemaId.');
  }

  return { status: 'resolved', contract };
}

export const SPEC_AUTHOR_SCHEMA_ID = 'autocatalyst.spec_author.v1' as const;
export const SYSTEM_SPEC_AUTHOR_SPECCED_BY = 'autocatalyst' as const;
export const REVIEWER_RESULT_SCHEMA_ID = 'autocatalyst.reviewer_result.v1' as const;

export interface SpecAuthorResultContractOptions {
  readonly trustedSpeccedBy?: string;
}

function assertTrustedSpeccedBy(value: string): string {
  specAuthorFrontmatterSchema.pick({ specced_by: true }).parse({ specced_by: value });
  return value;
}

export function stampSpecAuthorResultIdentity(candidate: unknown, trustedSpeccedBy: string = SYSTEM_SPEC_AUTHOR_SPECCED_BY): unknown {
  const stampedIdentity = assertTrustedSpeccedBy(trustedSpeccedBy);
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return candidate;
  }
  const record = candidate as Record<string, unknown>;
  const frontmatter = record['frontmatter'];
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    return candidate;
  }
  return {
    ...record,
    frontmatter: {
      ...(frontmatter as Record<string, unknown>),
      specced_by: stampedIdentity
    }
  };
}

function createSystemStampedSpecAuthorResultSchema(trustedSpeccedBy: string) {
  return z.preprocess(
    (candidate) => stampSpecAuthorResultIdentity(candidate, trustedSpeccedBy),
    specAuthorResultSchema
  );
}

export function registerSpecAuthorResultContract(
  registry: StepResultContractRegistry,
  options: SpecAuthorResultContractOptions = {}
): StepResultContractRegistry {
  const trustedSpeccedBy = assertTrustedSpeccedBy(options.trustedSpeccedBy ?? SYSTEM_SPEC_AUTHOR_SPECCED_BY);
  return registry.register({
    step: 'spec.author',
    schemaId: SPEC_AUTHOR_SCHEMA_ID,
    schema: createSystemStampedSpecAuthorResultSchema(trustedSpeccedBy),
    resultFile: 'step-result.json'
  });
}

export function registerReviewerResultContract(
  registry: StepResultContractRegistry
): StepResultContractRegistry {
  return registry.register({
    step: 'implementation.build',
    schemaId: REVIEWER_RESULT_SCHEMA_ID,
    schema: reviewerResultSchema,
    resultFile: 'step-result.json'
  });
}

function contractFailure(
  code: StepResultContractResolutionFailure['code'],
  safeMessage: string
): StepResultContractResolutionFailure {
  return {
    status: 'failed',
    code,
    safeMessage,
    issues: [{ code, path: [], message: safeMessage }]
  };
}
