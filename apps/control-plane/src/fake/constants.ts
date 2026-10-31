/**
 * Shared constants for deterministic fake mode. These are documented local test
 * values only (see docs/operators/fake-mode.md). Nothing here is a real secret.
 */

/** Development tenant used for startup composition and all fake fixtures. */
export const FAKE_TENANT = 'tenant_dev';

/** Value of the fake credential secret. Documented test value. */
export const FAKE_SECRET_VALUE = 'fake-token';

/** Pull request numbering starts here on fresh fake state. */
export const FAKE_PULL_REQUEST_START_NUMBER = 101;

/** Fixture project values created on fresh fake-mode startup. */
export const FAKE_FIXTURE_PROJECT = {
  displayName: 'Fixture app',
  repoUrl: 'https://github.com/autocatalyst-fixtures/demo-app',
  hostRepository: {
    provider: 'github',
    owner: 'autocatalyst-fixtures',
    name: 'demo-app'
  },
  issueTrackerProvider: 'github',
  codeHostProvider: 'github'
} as const;

/** The five named seed scenarios in documented order. */
export const FAKE_SCENARIOS = ['spec-review', 'implementation-review', 'pr-open', 'merged', 'failed'] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export interface FakeScenarioDefinition {
  readonly scenario: FakeScenario;
  readonly issueNumber: number;
  readonly workKind: 'feature' | 'enhancement' | 'bug' | 'chore';
  /** The run step the scenario stops at after seeding. */
  readonly stopStep: string;
}

export const FAKE_SCENARIO_DEFINITIONS: Readonly<Record<FakeScenario, FakeScenarioDefinition>> = {
  'spec-review': { scenario: 'spec-review', issueNumber: 1, workKind: 'feature', stopStep: 'spec.human_review' },
  'implementation-review': { scenario: 'implementation-review', issueNumber: 2, workKind: 'enhancement', stopStep: 'implementation.human_review' },
  'pr-open': { scenario: 'pr-open', issueNumber: 3, workKind: 'bug', stopStep: 'pr.human_review' },
  merged: { scenario: 'merged', issueNumber: 4, workKind: 'chore', stopStep: 'done' },
  failed: { scenario: 'failed', issueNumber: 6, workKind: 'feature', stopStep: 'failed' }
};

// ---------------------------------------------------------------------------
// Deterministic scripted spec content (feature / enhancement spec.author)
// ---------------------------------------------------------------------------

/** Emoji rendered immediately before passage A. */
export const SPEC_EMOJI = '✨';

/** Passage literals the scripted first spec must contain exactly. */
export const SPEC_PASSAGE_A = 'A. Names must be unique within a tenant.';
export const SPEC_PASSAGE_B = 'B. Deletion cascades to every child record.';
export const SPEC_PASSAGE_C = 'C. Timestamps use ISO-8601 in UTC.';
export const SPEC_PASSAGE_D = 'D. All identifiers are opaque strings.';

/** Source text the revision inserts immediately before passage A. */
export const SPEC_REVISION_INSERT = '- A name is trimmed of leading and trailing spaces.\n';

/** Heading that precedes passage B and is removed by the revision. */
export const SPEC_OPEN_QUESTIONS_HEADING = '## Open questions';

/**
 * Build the first-pass spec body for a feature/enhancement run.
 *
 * Layout invariant (so the revision offsets are deterministic):
 *   - Passages C and D appear BEFORE passage A.
 *   - The emoji + passage A appear next.
 *   - The `Open questions` heading + passage B appear AFTER passage A.
 *
 * The revision inserts text before passage A (shifting only A and everything
 * after it) and removes passage B + its heading (after A). Passages C and D,
 * which precede the insertion point, therefore do not move.
 */
export function buildFirstSpecBody(title: string): string {
  return [
    `# ${title}`,
    '',
    'This fixture specification exercises the deterministic fake-mode scripted author.',
    '',
    'It contains structured markdown so client and browser checks have realistic content.',
    '',
    '| Field | Type |',
    '| --- | --- |',
    '| name | string |',
    '| createdAt | string |',
    '',
    '- First requirement bullet.',
    '- Second requirement bullet.',
    '',
    '```ts',
    'const fixture = { name: "demo" };',
    '```',
    '',
    SPEC_PASSAGE_C,
    '',
    SPEC_PASSAGE_D,
    '',
    `${SPEC_EMOJI} ${SPEC_PASSAGE_A}`,
    '',
    SPEC_OPEN_QUESTIONS_HEADING,
    '',
    SPEC_PASSAGE_B,
    '',
    'Pass 1.'
  ].join('\n');
}

/** Build the revised spec body (second pass) deterministically. */
export function buildRevisedSpecBody(title: string): string {
  return [
    `# ${title}`,
    '',
    'This fixture specification exercises the deterministic fake-mode scripted author.',
    '',
    'It contains structured markdown so client and browser checks have realistic content.',
    '',
    '| Field | Type |',
    '| --- | --- |',
    '| name | string |',
    '| createdAt | string |',
    '',
    '- First requirement bullet.',
    '- Second requirement bullet.',
    '',
    '```ts',
    'const fixture = { name: "demo" };',
    '```',
    '',
    SPEC_PASSAGE_C,
    '',
    SPEC_PASSAGE_D,
    '',
    // Inserted source text, immediately before the emoji + passage A.
    SPEC_REVISION_INSERT.replace(/\n$/u, ''),
    `${SPEC_EMOJI} ${SPEC_PASSAGE_A}`,
    '',
    'Pass 2.'
  ].join('\n');
}

/**
 * Build the spec body for a given 1-based spec.author pass.
 * Pass 1 → first spec. Pass 2 → revised spec. Pass 3+ → revised spec whose
 * only change is the final line naming the pass number.
 */
export function buildSpecBodyForPass(title: string, pass: number): string {
  if (pass <= 1) {
    return buildFirstSpecBody(title);
  }
  if (pass === 2) {
    return buildRevisedSpecBody(title);
  }
  return buildRevisedSpecBody(title).replace(/Pass 2\.$/u, `Pass ${pass}.`);
}
