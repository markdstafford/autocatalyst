/**
 * Fixed fixture issues served by the scripted GitHub issue tracker.
 *
 * Issue numbering is stable across restarts:
 *   1  feature     → spec-review scenario
 *   2  enhancement → implementation-review scenario
 *   3  bug         → pr-open scenario
 *   4  chore       → merged scenario
 *   5  (unlabeled) → no default run
 *   6  feature     → failed scenario
 *   7  feature     → spare labeled
 *   8  enhancement → spare labeled
 *   9  bug         → spare labeled
 *   10 chore       → spare labeled
 *   11 (unlabeled) → spare unlabeled
 */

export interface FakeFixtureIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: 'OPEN' | 'CLOSED';
}

export const FAKE_FIXTURE_ISSUES: readonly FakeFixtureIssue[] = [
  {
    number: 1,
    title: 'Add tenant name uniqueness',
    body: 'As an operator I want tenant names to be unique so that lookups are unambiguous.',
    labels: ['feature'],
    state: 'OPEN'
  },
  {
    number: 2,
    title: 'Improve tenant name trimming',
    body: 'Enhance tenant name handling so leading and trailing spaces are trimmed.',
    labels: ['enhancement'],
    state: 'OPEN'
  },
  {
    number: 3,
    title: 'Fix cascade on tenant deletion',
    body: 'Deleting a tenant should cascade to child records without leaving orphans.',
    labels: ['bug'],
    state: 'OPEN'
  },
  {
    number: 4,
    title: 'Chore: tidy fixture metadata',
    body: 'Housekeeping task that touches no business logic.',
    labels: ['chore'],
    state: 'OPEN'
  },
  {
    number: 5,
    title: 'Unlabeled discussion issue',
    body: 'This issue has no work-kind label and should not start a default run.',
    labels: [],
    state: 'OPEN'
  },
  {
    number: 6,
    title: 'Feature that fails during spec authoring',
    body: 'Used by the failed scenario to exercise the failure path at spec.author.',
    labels: ['feature'],
    state: 'OPEN'
  },
  {
    number: 7,
    title: 'Spare feature issue',
    body: 'Spare labeled feature issue for ad-hoc seeding.',
    labels: ['feature'],
    state: 'OPEN'
  },
  {
    number: 8,
    title: 'Spare enhancement issue',
    body: 'Spare labeled enhancement issue for ad-hoc seeding.',
    labels: ['enhancement'],
    state: 'OPEN'
  },
  {
    number: 9,
    title: 'Spare bug issue',
    body: 'Spare labeled bug issue for ad-hoc seeding.',
    labels: ['bug'],
    state: 'OPEN'
  },
  {
    number: 10,
    title: 'Spare chore issue',
    body: 'Spare labeled chore issue for ad-hoc seeding.',
    labels: ['chore'],
    state: 'OPEN'
  },
  {
    number: 11,
    title: 'Spare unlabeled issue',
    body: 'Spare unlabeled issue with no default run.',
    labels: [],
    state: 'OPEN'
  }
];
