import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { ProviderProtocolError } from './agent-provider-adapter.js';
import type { StepResultContractDefinition } from './result-contracts.js';
import {
  assertSerializableStructuredResult,
  createStructuredAgentResultCapture
} from './structured-result-capture.js';

const stubSchema = z.object({ value: z.string() });

const stubContract: StepResultContractDefinition = {
  step: 'test.step',
  schemaId: 'test.schema.v1',
  schema: stubSchema,
  resultFile: 'step-result.json'
};

describe('createStructuredAgentResultCapture', () => {
  it('returns skipped with reason mode_none when mode is none', () => {
    const result = createStructuredAgentResultCapture({ mode: 'none' });
    expect(result).toEqual({ status: 'skipped', reason: 'mode_none' });
  });

  it('returns skipped with reason no_contract when mode is scratch_file and no contract provided', () => {
    const result = createStructuredAgentResultCapture({ mode: 'scratch_file' });
    expect(result).toEqual({ status: 'skipped', reason: 'no_contract' });
  });

  it('returns capture on success with valid contract and resultFile', () => {
    const result = createStructuredAgentResultCapture({
      mode: 'scratch_file',
      step: 'test.step',
      contract: stubContract
    });
    expect(result).toMatchObject({
      status: 'capture',
      capture: {
        step: 'test.step',
        schemaId: 'test.schema.v1',
        resultFile: 'step-result.json',
        required: true
      }
    });
    expect((result as { status: 'capture'; capture: { schema: unknown } }).capture.schema).toBe(stubSchema);
  });

  it('returns failed with code result_file_missing when contract has no resultFile', () => {
    const contractWithoutResultFile: StepResultContractDefinition = {
      step: 'test.step',
      schemaId: 'test.schema.v1',
      schema: stubSchema
    };
    const result = createStructuredAgentResultCapture({
      mode: 'scratch_file',
      contract: contractWithoutResultFile
    });
    expect(result).toMatchObject({ status: 'failed', code: 'result_file_missing' });
  });

  it('returns failed with code step_result_contract_unknown when step does not match contract.step', () => {
    const result = createStructuredAgentResultCapture({
      mode: 'scratch_file',
      step: 'other.step',
      contract: stubContract
    });
    expect(result).toMatchObject({ status: 'failed', code: 'step_result_contract_unknown' });
  });

  it('returns skipped with reason no_contract when contract schemaId is "any"', () => {
    const contract = {
      step: 'some.step',
      schemaId: 'any',
      schema: z.unknown(),
      resultFile: 'step-result.json'
    };
    const result = createStructuredAgentResultCapture({ mode: 'scratch_file', contract });
    expect(result).toEqual({ status: 'skipped', reason: 'no_contract' });
  });

  it('returns capture when step is not provided (no step mismatch check)', () => {
    const result = createStructuredAgentResultCapture({
      mode: 'scratch_file',
      contract: stubContract
    });
    expect(result).toMatchObject({ status: 'capture' });
  });
});

describe('assertSerializableStructuredResult', () => {
  it('accepts plain objects', () => {
    expect(() => assertSerializableStructuredResult({ key: 'value', count: 42 })).not.toThrow();
  });

  it('accepts numbers', () => {
    expect(() => assertSerializableStructuredResult(42)).not.toThrow();
  });

  it('accepts strings', () => {
    expect(() => assertSerializableStructuredResult('hello')).not.toThrow();
  });

  it('accepts null', () => {
    expect(() => assertSerializableStructuredResult(null)).not.toThrow();
  });

  it('accepts arrays', () => {
    expect(() => assertSerializableStructuredResult([1, 2, 3])).not.toThrow();
  });

  it('throws ProviderProtocolError with code structured_result_invalid for undefined', () => {
    expect(() => assertSerializableStructuredResult(undefined)).toThrow(ProviderProtocolError);
    try {
      assertSerializableStructuredResult(undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderProtocolError);
      expect((error as ProviderProtocolError).code).toBe('structured_result_invalid');
    }
  });

  it('throws ProviderProtocolError with code structured_result_invalid for circular objects', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => assertSerializableStructuredResult(circular)).toThrow(ProviderProtocolError);
    try {
      assertSerializableStructuredResult(circular);
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderProtocolError);
      expect((error as ProviderProtocolError).code).toBe('structured_result_invalid');
    }
  });
});
