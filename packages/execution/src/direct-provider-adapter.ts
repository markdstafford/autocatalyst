import type { z } from 'zod';
import type { ModelIdentity } from '@autocatalyst/api-contract';

import type {
  AgentConnection,
  AgentConnectionTelemetryContext,
  AgentTokenUsage,
  ProviderConnectionMechanism,
  ResolvedAgentRunnerProfile
} from './agent-provider-adapter.js';
import type { ProviderCapabilityDegradation } from './request-alteration.js';
import type { ResultCorrectionRequester } from './result-correction.js';
import type { ResultNormalizer, ResultNormalizerRegistry } from './result-normalizers.js';
import type { ResultDegradationPolicy, StepResultValidationFailureCode } from './result-tolerance.js';
import type { StepResultValidationOutcome, StepResultValidationSuccess } from './result-tolerance.js';

export type { StepResultValidationOutcome as DirectResultValidationOutcome };
export type { StepResultValidationSuccess as DirectResultValidationSuccess };

export interface DirectResultValidationConfig<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly schemaId: string;
  readonly schema: TSchema;
  readonly step?: string;
  readonly normalizers?: ResultNormalizerRegistry | readonly ResultNormalizer[];
  readonly correctionRequester?: ResultCorrectionRequester;
  readonly maxCorrectionAttempts?: number;
  readonly degradationPolicy?: ResultDegradationPolicy;
}

export interface DirectCallRequest<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly purpose: string;
  readonly input: unknown;
  readonly resultValidation: DirectResultValidationConfig<TSchema>;
}

export interface DirectProviderCallInput<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly call: DirectCallRequest<TSchema>;
  readonly profile: ResolvedAgentRunnerProfile;
  readonly connection: AgentConnection;
  readonly telemetryContext: AgentConnectionTelemetryContext;
}

export interface DirectProviderCallMetadata {
  readonly outcome: 'succeeded';
  readonly tokenUsage: AgentTokenUsage;
  readonly degradedCapabilities: readonly ProviderCapabilityDegradation[];
  readonly model?: ModelIdentity;
  readonly purpose?: string;
}

export interface DirectProviderCallResult {
  readonly candidate: unknown;
  readonly metadata: DirectProviderCallMetadata;
}

export interface DirectProviderAdapter {
  readonly providerKind: string;
  readonly adapterId: string;
  readonly supportedConnectionMechanism: ProviderConnectionMechanism;
  call(input: DirectProviderCallInput): Promise<DirectProviderCallResult>;
  close?(): Promise<void>;
}

export type DirectProviderProtocolErrorCode =
  | 'missing_candidate'
  | 'invalid_direct_metadata'
  | 'structured_result_missing'
  | 'structured_result_malformed'
  | 'multiple_structured_candidates'
  | 'extra_structured_output';

export class DirectProviderProtocolError extends Error {
  constructor(
    public readonly code: DirectProviderProtocolErrorCode,
    message: string,
    public readonly safeDetails?: unknown
  ) {
    super(message);
    this.name = 'DirectProviderProtocolError';
  }
}

export class DirectResultValidationError extends Error {
  constructor(
    public readonly code: StepResultValidationFailureCode,
    message: string,
    public readonly safeDetails?: unknown
  ) {
    super(message);
    this.name = 'DirectResultValidationError';
  }
}
