import { describe, expect, it } from 'vitest';
import {
  parseSpecFrontmatter,
  renderSpecFrontmatter,
  validateCommittedSpecFrontmatter,
  SpecFrontmatterError,
  renderCommittedSpecMarkdown
} from './spec-frontmatter.js';

const frontmatter = {
  created: '2026-06-11',
  last_updated: '2026-06-11',
  status: 'draft' as const,
  issue: 39,
  specced_by: 'autocatalyst'
} as const;

describe('spec frontmatter helpers', () => {
  it('renders a YAML frontmatter block with required fields in order', () => {
    const rendered = renderSpecFrontmatter(frontmatter);
    expect(rendered).toBe([
      '---',
      'created: 2026-06-11',
      'last_updated: 2026-06-11',
      'status: draft',
      'issue: 39',
      'specced_by: autocatalyst',
      '---',
      ''
    ].join('\n'));
  });

  it('parses a valid Markdown frontmatter block', () => {
    const rendered = renderSpecFrontmatter(frontmatter);
    const parsed = parseSpecFrontmatter(`${rendered}# Body\n`);
    expect(parsed).toEqual(frontmatter);
  });

  it('round-trips frontmatter through render and parse', () => {
    const rendered = renderSpecFrontmatter(frontmatter);
    const parsed = parseSpecFrontmatter(rendered);
    expect(parsed).toEqual(frontmatter);
  });

  it('rejects Markdown without a frontmatter block', () => {
    expect(() => parseSpecFrontmatter('# Body only')).toThrow(SpecFrontmatterError);
  });

  it('throws spec_frontmatter_missing for missing frontmatter', () => {
    try {
      parseSpecFrontmatter('# Body only');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecFrontmatterError);
      expect((error as SpecFrontmatterError).code).toBe('spec_frontmatter_missing');
    }
  });

  it('throws spec_frontmatter_invalid for invalid fields', () => {
    expect(() => validateCommittedSpecFrontmatter({ ...frontmatter, issue: '39' })).toThrow(SpecFrontmatterError);
    try {
      validateCommittedSpecFrontmatter({ ...frontmatter, issue: '39' });
    } catch (error) {
      expect((error as SpecFrontmatterError).code).toBe('spec_frontmatter_invalid');
    }
  });

  it('validates and returns the frontmatter when valid', () => {
    const result = validateCommittedSpecFrontmatter(frontmatter);
    expect(result).toEqual(frontmatter);
  });

  it('renders optional fields when present', () => {
    const withOptional = {
      ...frontmatter,
      implemented_by: 'mark-stafford'
    };
    const rendered = renderSpecFrontmatter(withOptional);
    expect(rendered).toContain('implemented_by: mark-stafford');
  });

  it('omits undefined optional fields', () => {
    const rendered = renderSpecFrontmatter(frontmatter);
    expect(rendered).not.toContain('implemented_by');
    expect(rendered).not.toContain('supersedes');
  });
});

describe('renderCommittedSpecMarkdown', () => {
  it('renders exactly one frontmatter block followed by body', () => {
    const markdown = renderCommittedSpecMarkdown({ frontmatter, body: '# Body\n' });
    const dashMatches = markdown.match(/^---$/gmu);
    expect(dashMatches).toHaveLength(2);
    expect(markdown).toContain('\n---\n# Body\n');
  });

  it('rejects body content that starts with its own frontmatter block', () => {
    expect(() => renderCommittedSpecMarkdown({
      frontmatter,
      body: '---\nstatus: draft\n---\n# Body'
    })).toThrow();
    try {
      renderCommittedSpecMarkdown({ frontmatter, body: '---\nstatus: draft\n---\n# Body' });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('spec_body_contains_frontmatter');
    }
  });

  it('requires initial committed status draft when requireDraftStatus is true', () => {
    expect(() => renderCommittedSpecMarkdown({
      frontmatter: { ...frontmatter, status: 'approved' as const },
      body: '# Body',
      requireDraftStatus: true
    })).toThrow();
    try {
      renderCommittedSpecMarkdown({
        frontmatter: { ...frontmatter, status: 'approved' as const },
        body: '# Body',
        requireDraftStatus: true
      });
    } catch (error) {
      expect((error as { code?: string }).code).toBe('spec_frontmatter_invalid');
    }
  });

  it('does not require draft status when requireDraftStatus is not set', () => {
    expect(() => renderCommittedSpecMarkdown({
      frontmatter: { ...frontmatter, status: 'approved' as const },
      body: '# Body'
    })).not.toThrow();
  });

  it('validates the rendered bytes by round-tripping the frontmatter', () => {
    const markdown = renderCommittedSpecMarkdown({ frontmatter, body: '# My spec\n\nSome content.' });
    // The result should be parseable
    expect(() => parseSpecFrontmatter(markdown)).not.toThrow();
  });

  it('appends trailing newline to body if missing', () => {
    const markdown = renderCommittedSpecMarkdown({ frontmatter, body: '# Body without newline' });
    expect(markdown.endsWith('\n')).toBe(true);
  });
});
