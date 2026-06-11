import { specAuthorFrontmatterSchema, type SpecAuthorFrontmatter } from '@autocatalyst/api-contract';

export type SpecFrontmatterErrorCode = 'spec_frontmatter_missing' | 'spec_frontmatter_invalid' | 'spec_body_contains_frontmatter';

export class SpecFrontmatterError extends Error {
  readonly code: SpecFrontmatterErrorCode;
  constructor(code: SpecFrontmatterErrorCode, message: string) {
    super(message);
    this.name = 'SpecFrontmatterError';
    this.code = code;
  }
}

const orderedKeys = [
  'created',
  'last_updated',
  'status',
  'issue',
  'specced_by',
  'implemented_by',
  'supersedes',
  'superseded_by'
] as const;

export function validateCommittedSpecFrontmatter(value: unknown): SpecAuthorFrontmatter {
  const parsed = specAuthorFrontmatterSchema.safeParse(value);
  if (!parsed.success) {
    throw new SpecFrontmatterError('spec_frontmatter_invalid', 'Spec frontmatter failed validation.');
  }
  return parsed.data;
}

export function renderSpecFrontmatter(frontmatter: SpecAuthorFrontmatter): string {
  const validated = validateCommittedSpecFrontmatter(frontmatter);
  const lines: string[] = ['---'];
  for (const key of orderedKeys) {
    const value = validated[key];
    if (value !== undefined) {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

export type SpecMarkdownRenderErrorCode = SpecFrontmatterErrorCode | 'spec_body_contains_frontmatter';

export interface RenderCommittedSpecMarkdownInput {
  readonly frontmatter: SpecAuthorFrontmatter;
  readonly body: string;
  readonly requireDraftStatus?: boolean;
}

export function renderCommittedSpecMarkdown(input: RenderCommittedSpecMarkdownInput): string {
  const validated = validateCommittedSpecFrontmatter(input.frontmatter);
  if (input.requireDraftStatus === true && validated.status !== 'draft') {
    throw new SpecFrontmatterError('spec_frontmatter_invalid', 'Initial spec authoring status must be draft.');
  }
  const firstBodyLine = input.body.split('\n')[0] ?? '';
  if (/^---\s*$/u.test(firstBodyLine)) {
    throw new SpecFrontmatterError('spec_body_contains_frontmatter', 'Spec body must not contain a frontmatter block.');
  }
  const body = input.body.endsWith('\n') ? input.body : `${input.body}\n`;
  const markdown = `${renderSpecFrontmatter(validated)}${body}`;
  // Validate the rendered bytes by round-tripping
  parseSpecFrontmatter(markdown);
  return markdown;
}

export function parseSpecFrontmatter(markdown: string): SpecAuthorFrontmatter {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(markdown);
  if (match === null) {
    throw new SpecFrontmatterError('spec_frontmatter_missing', 'Spec frontmatter block is missing.');
  }
  const raw: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new SpecFrontmatterError('spec_frontmatter_invalid', 'Spec frontmatter contains an invalid line.');
    }
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    raw[key] = key === 'issue' ? Number(rawValue) : rawValue;
  }
  return validateCommittedSpecFrontmatter(raw);
}
