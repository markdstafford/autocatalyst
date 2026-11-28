import type {
  SaveTestingGuideResultsRequest, TestResult, TestResultItem, TestResultOutcome, TestingGuide, TestingGuideItem, TestingGuideResults
} from '@autocatalyst/api-contract';

import type { TestingGuideRepository, TestResultRepository } from './domain-repositories.js';

export function deriveTestResultOutcome(items: readonly TestResultItem[]): Exclude<TestResultOutcome, 'blocked'> {
  if (items.some(item => item.outcome === 'failed')) return 'failed';
  return items.some(item => item.outcome === 'passed') ? 'passed' : 'inconclusive';
}

export function seedTestingGuidePass(guide: TestingGuide, prior?: Pick<TestResult, 'items'>): TestResultItem[] {
  const byId = new Map(prior?.items.map(item => [item.id, item]));
  return guide.items.map(({ id }) => {
    const item = byId.get(id);
    if (item === undefined || item.outcome === 'failed') return { id };
    return {
      id,
      ...(item.outcome === undefined ? {} : { outcome: item.outcome }),
      ...(item.note === undefined ? {} : { note: item.note })
    };
  });
}

export async function loadLatestFinalTestingPass(
  scope: { readonly runId: string; readonly tenant: string },
  guides: TestingGuideRepository,
  results: TestResultRepository
): Promise<{ guide: TestingGuide; result: TestResult } | null> {
  const result = await results.findLatestFinalByRun(scope.runId);
  if (result === null) return null;
  if (result.guideRevision === undefined) throw new Error('Final testing pass has no guide revision.');
  const guide = await guides.findByRunAndRevision({ ...scope, revision: result.guideRevision });
  if (guide === null) throw new Error('Recorded testing guide revision is missing.');
  return { guide, result };
}

export function testingGuidePassView(guide: TestingGuide, result?: TestResult, prior?: TestResult): TestingGuideResults {
  const stored = new Map(result?.items.map(item => [item.id, item]));
  const items = result === undefined ? seedTestingGuidePass(guide, prior)
    : guide.items.map(({ id }) => stored.get(id) ?? { id });
  return {
    guideRevision: guide.revision,
    state: result?.state ?? 'working',
    outcome: deriveTestResultOutcome(items),
    items,
    ...(result === undefined ? {} : { testResultId: result.id })
  };
}

export async function readWorkingTestingGuidePass(
  guide: TestingGuide, gateStepId: string, tenant: string, guides: TestingGuideRepository, results: TestResultRepository
): Promise<TestingGuideResults> {
  const working = await results.findWorkingByRun(guide.runId);
  if (working?.gateStepId === gateStepId && working.guideRevision === guide.revision) {
    return testingGuidePassView(guide, working);
  }
  const previous = await loadLatestFinalTestingPass({ runId: guide.runId, tenant }, guides, results);
  return testingGuidePassView(guide, undefined, previous?.result);
}

export function patchTestingGuideItems(
  current: readonly TestResultItem[], patch: SaveTestingGuideResultsRequest['items']
): TestResultItem[] {
  const byId = new Map(patch.map(item => [item.id, item]));
  return current.map(item => {
    const edit = byId.get(item.id);
    if (edit === undefined) return item;
    return {
      id: item.id,
      ...(edit.outcome === null ? {} : { outcome: edit.outcome }),
      ...(edit.note === null ? {} : { note: edit.note })
    };
  });
}

export function failedTestingItemFeedbackBody(item: TestingGuideItem, note?: string): string {
  if (note !== undefined && note.trim().length > 0) return note;
  return item.expected === undefined ? item.text : `${item.text}\n\nExpected: ${item.expected}`;
}

export interface TestingNote {
  readonly text: string;
  readonly outcome: 'passed' | 'unanswered';
  readonly note: string;
}

export function testingNotesForPass({ guide, result }: { guide: TestingGuide; result: TestResult }): TestingNote[] {
  const byId = new Map(result.items.map(item => [item.id, item]));
  return guide.items.flatMap(({ id, text }): TestingNote[] => {
    const item = byId.get(id);
    if (item?.note === undefined || item.outcome === 'failed' || item.feedbackId !== undefined) return [];
    return [{ text, outcome: item.outcome ?? 'unanswered', note: item.note }];
  });
}
