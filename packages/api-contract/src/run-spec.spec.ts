import { describe, expect, it } from 'vitest';

import {
  runSpecPath,
  getRunSpecSuccessStatusCode,
  runSpecResponseSchema,
  type RunSpecResponse
} from './run-spec.js';

const validArtifact = {
  id: 'art_1',
  runId: 'run_1',
  owner: { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_1', displayName: 'Phoebe' },
  tenant: 'tenant_1',
  kind: 'enhancement_spec' as const,
  canonicalRecord: 'file' as const,
  location: 'context-human/specs/enhancement-spec-review-api-surface.md',
  cachedStatus: 'draft' as const,
  publicationRefs: [],
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z'
};

const validFrontmatter = {
  created: '2026-06-12',
  last_updated: '2026-06-12',
  status: 'implementing' as const,
  issue: 41,
  specced_by: 'autocatalyst'
};

describe('run spec contract', () => {
  it('exports the correct route path', () => {
    expect(runSpecPath).toBe('/v1/runs/:id/spec');
  });

  it('exports the correct success status code', () => {
    expect(getRunSpecSuccessStatusCode).toBe(200);
  });

  it('parses a valid spec response', () => {
    const response: RunSpecResponse = {
      artifact: validArtifact,
      markdown: '---\ncreated: 2026-06-12\n---\n# Title\n',
      frontmatter: validFrontmatter
    };
    const parsed = runSpecResponseSchema.parse(response);
    expect(parsed.artifact.id).toBe('art_1');
    expect(parsed.artifact.cachedStatus).toBe('draft');
    expect(parsed.frontmatter.issue).toBe(41);
  });

  it('rejects a response missing markdown', () => {
    expect(() => runSpecResponseSchema.parse({
      artifact: validArtifact,
      frontmatter: validFrontmatter
    })).toThrow();
  });

  it('rejects extra top-level fields (strict)', () => {
    expect(() => runSpecResponseSchema.parse({
      artifact: validArtifact,
      markdown: '# Hello',
      frontmatter: validFrontmatter,
      cachedStatus: 'draft'
    })).toThrow();
  });

  it('rejects a missing artifact', () => {
    expect(() => runSpecResponseSchema.parse({
      markdown: '# Hello',
      frontmatter: validFrontmatter
    })).toThrow();
  });
});
