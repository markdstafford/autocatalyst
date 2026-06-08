import { describe, expect, it } from 'vitest';
import { principalDiagnosticResponseSchema, principalKindSchema, principalSchema } from './principal.js';

describe('principal contract schemas', () => {
  it('accepts supported principal kinds and a diagnostic response', () => {
    expect(principalKindSchema.options).toEqual(['human', 'model', 'system']);
    expect(
      principalDiagnosticResponseSchema.parse({
        principal: {
          id: 'principal_dev_human',
          kind: 'human',
          tenantId: 'tenant_dev',
          displayName: 'Development Principal'
        }
      })
    ).toEqual({
      principal: {
        id: 'principal_dev_human',
        kind: 'human',
        tenantId: 'tenant_dev',
        displayName: 'Development Principal'
      }
    });
  });

  it('rejects invalid principal kinds', () => {
    expect(() =>
      principalSchema.parse({ id: 'principal_bad', kind: 'robot', tenantId: 'tenant_dev' })
    ).toThrow();
  });
});
