import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateStepResult } from './result-tolerance.js';
import { DirectProviderProtocolError, DirectResultValidationError } from './direct-provider-adapter.js';
import type { ResolvedAgentRunnerProfile } from './agent-provider-adapter.js';

describe('direct provider adapter contracts', () => {
  it('validates a direct candidate with existing result tolerance', async () => {
    const schema = z.object({ intent: z.enum(['implement', 'review']) }).strict();
    const validation = await validateStepResult({
      runId: 'run_1',
      step: 'classify_intent',
      schemaId: 'intent-result',
      schema,
      candidate: { intent: 'review' },
      maxCorrectionAttempts: 0
    });
    expect(validation.status).toBe('valid');
  });

  it('returns a safe validation failure for malformed direct candidates', async () => {
    const schema = z.object({ intent: z.enum(['implement', 'review']) }).strict();
    const validation = await validateStepResult({
      runId: 'run_1',
      step: 'classify_intent',
      schemaId: 'intent-result',
      schema,
      candidate: { intent: 'delete_credentials' },
      maxCorrectionAttempts: 0
    });
    expect(validation.status).toBe('failed');
    if (validation.status === 'failed') {
      expect(validation.safeMessage).toBeDefined();
      expect(JSON.stringify(validation)).not.toContain('sk-test-secret');
    }
  });

  it('DirectProviderProtocolError has expected shape', () => {
    const err = new DirectProviderProtocolError('missing_candidate', 'No candidate found.', { schemaId: 'test' });
    expect(err.name).toBe('DirectProviderProtocolError');
    expect(err.code).toBe('missing_candidate');
    expect(err.safeDetails).toEqual({ schemaId: 'test' });
  });

  it('DirectResultValidationError has expected shape', () => {
    const err = new DirectResultValidationError('schema_validation_failed', 'Schema failed.', { step: 'classify' });
    expect(err.name).toBe('DirectResultValidationError');
    expect(err.code).toBe('schema_validation_failed');
  });

  it('ResolvedAgentRunnerProfile accepts mode field', () => {
    const profile: ResolvedAgentRunnerProfile = {
      mode: 'agent',
      providerKind: 'anthropic',
      adapterId: 'claude-agent-sdk',
      profileName: 'claude-implementer',
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'process_environment'
    };
    expect(profile.mode).toBe('agent');

    const directProfile: ResolvedAgentRunnerProfile = {
      ...profile,
      mode: 'direct',
      adapterId: 'anthropic-direct',
      connectionMechanism: 'fetch_transport'
    };
    expect(directProfile.mode).toBe('direct');
  });
});
