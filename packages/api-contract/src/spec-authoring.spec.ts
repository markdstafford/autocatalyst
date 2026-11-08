import { describe, expect, it } from 'vitest';
import {
  specArtifactKindSchema,
  specAuthorFrontmatterSchema,
  specAuthorResultSchema
} from './spec-authoring.js';

const validFrontmatter = {
  created: '2026-06-11',
  last_updated: '2026-06-11',
  status: 'draft',
  issue: 39,
  specced_by: 'autocatalyst'
} as const;

describe('spec authoring schemas', () => {
  it('accepts a narrow feature spec author result', () => {
    expect(specAuthorResultSchema.parse({
      kind: 'feature_spec',
      slug: 'artifact-feedback-gate',
      relativePath: 'context-human/specs/feature-artifact-feedback-gate.md',
      frontmatter: validFrontmatter,
      body: '# Feature: Artifact feedback gate\n\n## Goals\n\n- Produce a durable spec.'
    })).toMatchObject({ kind: 'feature_spec' });
  });

  it('does not carry anchor offsets in the spec author output contract (ADR-033)', () => {
    // The spec author never emits or maintains anchor offsets; they are a control-plane concern.
    // The result schema is strict, so an anchor/offset field must be rejected, and the accepted
    // shape must expose no anchor-related keys.
    const valid = specAuthorResultSchema.parse({
      kind: 'feature_spec',
      slug: 'no-anchors',
      relativePath: 'context-human/specs/feature-no-anchors.md',
      frontmatter: validFrontmatter,
      body: '# Feature: No anchors\n\n## Goals\n\n- Keep offsets out of the author contract.'
    });
    expect(Object.keys(valid)).not.toContain('anchor');
    expect(Object.keys(valid)).not.toContain('anchors');
    expect(Object.keys(valid.frontmatter)).not.toContain('anchor');
    expect(() => specAuthorResultSchema.parse({
      kind: 'feature_spec',
      slug: 'no-anchors',
      relativePath: 'context-human/specs/feature-no-anchors.md',
      frontmatter: validFrontmatter,
      body: '# Feature: No anchors\n\n## Goals\n\n- x',
      anchors: [{ from: 0, to: 5 }]
    })).toThrow();
  });

  it('accepts autocatalyst as a service specced_by identity', () => {
    expect(specAuthorFrontmatterSchema.parse(validFrontmatter).specced_by).toBe('autocatalyst');
  });

  it('accepts a human GitHub username as specced_by', () => {
    expect(specAuthorFrontmatterSchema.parse({ ...validFrontmatter, specced_by: 'mark-stafford' }).specced_by).toBe('mark-stafford');
  });

  it('rejects string issue values', () => {
    expect(() => specAuthorFrontmatterSchema.parse({ ...validFrontmatter, issue: '39' })).toThrow();
  });

  it('rejects unsupported statuses', () => {
    expect(() => specAuthorFrontmatterSchema.parse({ ...validFrontmatter, status: 'ready_for_review' })).toThrow();
  });

  it('rejects empty body content', () => {
    expect(() => specAuthorResultSchema.parse({
      kind: 'feature_spec',
      slug: 'artifact-feedback-gate',
      relativePath: 'context-human/specs/feature-artifact-feedback-gate.md',
      frontmatter: validFrontmatter,
      body: '   '
    })).toThrow();
  });

  it('rejects malformed slugs (spaces)', () => {
    expect(() => specAuthorResultSchema.parse({
      kind: 'feature_spec',
      slug: 'Artifact Feedback Gate',
      relativePath: 'context-human/specs/feature-Artifact Feedback Gate.md',
      frontmatter: validFrontmatter,
      body: '# Body'
    })).toThrow();
  });

  it('rejects unknown spec artifact kinds', () => {
    expect(() => specArtifactKindSchema.parse('bug_triage')).toThrow();
  });

  it('rejects invalid committed specced_by identities', () => {
    expect(() => specAuthorFrontmatterSchema.parse({
      ...validFrontmatter,
      specced_by: 'autocatalyst:mm:planning'
    })).toThrow();
  });

  it('rejects enhancement result with feature path', () => {
    expect(() => specAuthorResultSchema.parse({
      kind: 'enhancement_spec',
      slug: 'my-enhancement',
      relativePath: 'context-human/specs/feature-my-enhancement.md',
      frontmatter: { ...validFrontmatter },
      body: '# Body'
    })).toThrow();
  });

  it('accepts enhancement result with enhancement path', () => {
    expect(specAuthorResultSchema.parse({
      kind: 'enhancement_spec',
      slug: 'my-enhancement',
      relativePath: 'context-human/specs/enhancement-my-enhancement.md',
      frontmatter: { ...validFrontmatter },
      body: '# Body'
    })).toMatchObject({ kind: 'enhancement_spec' });
  });
});
