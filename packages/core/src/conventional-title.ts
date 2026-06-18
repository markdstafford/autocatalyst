export function getConventionalTitleType(workKind: string): 'feat' | 'fix' | 'chore' | null {
  switch (workKind) {
    case 'feature':
    case 'enhancement':
      return 'feat';
    case 'bug':
      return 'fix';
    case 'chore':
      return 'chore';
    default:
      return null;
  }
}

export function normalizeConventionalSubject(subject: string): string {
  // Trim whitespace and remove line breaks
  let normalized = subject.replace(/[\r\n]+/g, ' ').trim();
  // Strip Markdown heading markers (# ## ### etc.)
  normalized = normalized.replace(/^#+\s+/u, '');
  // Strip list markers (- * + at start)
  normalized = normalized.replace(/^[-*+]\s+/u, '');
  // Strip trailing punctuation (periods, exclamation, etc. but not question marks)
  normalized = normalized.replace(/[.!]+$/u, '');
  // Lowercase only the first ASCII letter
  if (normalized.length > 0 && /^[A-Z]/u.test(normalized)) {
    normalized = normalized.charAt(0).toLowerCase() + normalized.slice(1);
  }
  // Collapse internal whitespace
  normalized = normalized.replace(/\s+/gu, ' ').trim();
  // Truncate to 72 characters without cutting a word when practical
  if (normalized.length > 72) {
    const truncated = normalized.slice(0, 72);
    const lastSpace = truncated.lastIndexOf(' ');
    normalized = lastSpace > 40 ? truncated.slice(0, lastSpace) : truncated;
  }
  return normalized;
}

export function formatConventionalTitle(type: 'feat' | 'fix' | 'chore', subject: string): string {
  const normalized = normalizeConventionalSubject(subject);
  if (!type || !normalized) {
    throw new Error('Conventional title requires a non-empty type and subject.');
  }
  return `${type}: ${normalized}`;
}

function extractFirstSentenceOrHeading(text: string): string | null {
  if (!text) return null;
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // If it's a heading, extract the heading text
    const headingMatch = /^#+\s+(.+)/u.exec(trimmed);
    if (headingMatch) return (headingMatch[1] ?? '').trim();
    // Otherwise use the first sentence (up to . or end of first line)
    const sentenceEnd = trimmed.indexOf('.');
    if (sentenceEnd > 0) return trimmed.slice(0, sentenceEnd + 1);
    return trimmed;
  }
  return null;
}

export interface DeriveConventionalTitleInput {
  readonly workKind: string;
  readonly titleSubject?: string | null;
  readonly reconciledSummary?: string | null;
  readonly cumulativeSummary?: string | null;
  readonly changedFiles?: readonly string[];
}

function normalizeTitlePath(path: string): string | null {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
  if (normalized.length === 0 || normalized.startsWith('/')) return null;
  if (normalized.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  return normalized;
}

export function deriveChangedPathSubject(changedFiles: readonly string[]): string | null {
  const paths = [...new Set(changedFiles.map(normalizeTitlePath).filter((path): path is string => path !== null))]
    .sort((a, b) => a.localeCompare(b));
  if (paths.length === 0) return null;
  if (paths.length === 1) return `update ${paths[0]!}`;

  const packageNames = new Set<string>();
  const topLevel = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    topLevel.add(parts[0]!);
    if (parts[0] === 'packages' && parts[1] !== undefined) packageNames.add(parts[1]);
  }
  if (topLevel.size === 1 && topLevel.has('packages') && packageNames.size === 1) {
    const packageName = [...packageNames][0]!;
    if (paths.some((path) => path.includes('pr-') || path.includes('pull-request'))) {
      return `update ${packageName} PR content handling`;
    }
    return `update ${packageName} package changes`;
  }
  if (topLevel.size <= 2) return `update ${[...topLevel].sort().join(' and ')} changes`;
  return 'update changed implementation files';
}

export function deriveConventionalTitle(input: DeriveConventionalTitleInput): string | null {
  const type = getConventionalTitleType(input.workKind);
  if (type === null) return null;

  // Fallback subject source order:
  // 1. titleSubject
  // 2. first sentence/heading from reconciledSummary
  // 3. first sentence/heading from cumulativeSummary
  // 4. derived from changedFiles
  // 5. 'complete approved implementation'
  let subject: string | null = null;
  if (input.titleSubject && input.titleSubject.trim()) {
    subject = input.titleSubject.trim();
  } else if (input.reconciledSummary) {
    subject = extractFirstSentenceOrHeading(input.reconciledSummary);
  }
  if (!subject && input.cumulativeSummary) {
    subject = extractFirstSentenceOrHeading(input.cumulativeSummary);
  }
  if (!subject && input.changedFiles !== undefined) {
    subject = deriveChangedPathSubject(input.changedFiles);
  }
  if (!subject) {
    subject = 'complete approved implementation';
  }

  return formatConventionalTitle(type, subject);
}
