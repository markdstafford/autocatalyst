/**
 * Spec review end-to-end coverage against fake mode on the production path.
 *
 * Seeds the spec-review scenario, opens the built client served by its own fake control plane,
 * and exercises the real anchored-comment flow: render the scripted spec, create comments on the
 * four fixture passages by selecting rendered text and using the composer, verify the stored
 * anchors through the SDK (getRunSpec + listRunFeedback), reload, add a no-anchor comment through
 * the API, request changes, and verify the server-reconciled moved / stale behaviour and that each
 * marker's style reflects its reconciled status.
 *
 * No test routes around the API, writes browser storage, or makes a model call.
 */
import { expect, test, FIXTURE_TOKEN } from './fixtures/connected.js';
import type { Browser, Page } from '@playwright/test';

// Fixture literals, kept in sync with apps/control-plane/src/fake/constants.ts. Duplicated because a
// scope:web e2e may not import from the control-plane app.
const SPEC_EMOJI = '🚀';
const PASSAGE_A = 'A. Names must be unique within a tenant.';
const PASSAGE_B = 'B. Deletion cascades to every child record.';
const TABLE_CELL = 'createdAt';
const CODE_LINE = 'const fixture = { name: "demo" };';
const SAFE_LINK_URL = 'https://github.com/autocatalyst-fixtures/demo-app';
const SAFE_LINK_LABEL = 'the fixture repository';
const UNSAFE_LINK_LABEL = 'this unsafe link';

const AUTH = { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' } as const;

interface FeedbackAnchor {
  kind: string;
  from?: number;
  to?: number;
  quotedText?: string;
  stale?: boolean;
}
interface FeedbackItem {
  id: string;
  status: string;
  body: string;
  anchor?: FeedbackAnchor;
}

/** Count distinct anchored comments (one marker may render several client-rect boxes under one id). */
async function distinctMarkerCount(page: Page): Promise<number> {
  const ids = await page
    .locator('[data-marker-for]')
    .evaluateAll((els) => new Set(els.map((el) => el.getAttribute('data-marker-for'))).size);
  return ids;
}

async function openSpecTab(browser: Browser, connectedStatePath: string, url: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: connectedStatePath });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('tab', { name: 'Spec' }).click();
  await expect(page.getByTestId('spec-document')).toBeVisible();
  return { page, close: () => context.close() };
}

async function getSpec(baseUrl: string, runId: string): Promise<{ markdown: string; artifactId: string }> {
  const response = await fetch(`${baseUrl}/v1/runs/${runId}/spec`, { headers: AUTH });
  if (!response.ok) {
    throw new Error(`getRunSpec failed: ${response.status}`);
  }
  const json = (await response.json()) as { markdown: string; artifact: { id: string } };
  return { markdown: json.markdown, artifactId: json.artifact.id };
}

async function listFeedback(baseUrl: string, runId: string): Promise<FeedbackItem[]> {
  const response = await fetch(`${baseUrl}/v1/runs/${runId}/feedback`, { headers: AUTH });
  if (!response.ok) {
    throw new Error(`listRunFeedback failed: ${response.status}`);
  }
  return ((await response.json()) as { feedback: FeedbackItem[] }).feedback;
}

/** Code-point index of the first occurrence of `needle` in `text`. */
function cpIndexOf(text: string, needle: string): number {
  const utf16 = text.indexOf(needle);
  return utf16 < 0 ? -1 : [...text.slice(0, utf16)].length;
}

/** Select the first rendered occurrence of `needle` inside the spec document and open the composer. */
async function selectAndComment(page: Page, needle: string, body: string): Promise<void> {
  const selected = await page.evaluate((text) => {
    const doc = document.querySelector('[data-spec-document]');
    if (doc === null) {
      return false;
    }
    // Concatenate the rendered text nodes (a code line is split across Shiki token spans), find the
    // needle in the concatenation, then map its start/end back to (node, offset) boundaries.
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
    const nodes: Array<{ node: Text; start: number }> = [];
    let whole = '';
    let current = walker.nextNode();
    while (current !== null) {
      const node = current as Text;
      nodes.push({ node, start: whole.length });
      whole += node.data;
      current = walker.nextNode();
    }
    const index = whole.indexOf(text);
    if (index < 0) {
      return false;
    }
    const locate = (offset: number, strict: boolean): { node: Text; offset: number } => {
      for (const entry of nodes) {
        const end = entry.start + entry.node.data.length;
        if (strict ? offset < end : offset <= end) {
          return { node: entry.node, offset: offset - entry.start };
        }
      }
      const last = nodes[nodes.length - 1]!;
      return { node: last.node, offset: last.node.data.length };
    };
    const start = locate(index, true);
    const end = locate(index + text.length, false);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return true;
  }, needle);
  expect(selected, `selectable text: ${needle}`).toBe(true);

  await expect(page.getByTestId('composer')).toBeVisible();
  await page.getByTestId('composer-textarea').fill(body);
  await page.getByTestId('composer-submit').click();
  await expect(page.getByTestId('composer')).toBeHidden();
}

test.describe('spec review', () => {
  test('renders the scripted spec with document structure and highlighted code', async ({ browser, fakeServer, connectedStatePath }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openSpecTab(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      const doc = page.getByTestId('spec-document');
      await expect(doc.locator('h1')).toBeVisible();
      await expect(doc.locator('thead th', { hasText: 'Field' })).toBeVisible();
      await expect(doc.locator('li', { hasText: 'First requirement bullet.' })).toBeVisible();
      // Shiki highlights the code block into coloured token spans.
      await expect(doc.locator('code[data-spec-code] span[style]').first()).toBeVisible();

      // The safe https link renders as a real anchor; the unsafe-scheme link renders as plain text
      // (its label is present, but there is no anchor carrying a javascript: href).
      const safeLink = doc.locator(`a[href="${SAFE_LINK_URL}"]`);
      await expect(safeLink).toHaveText(SAFE_LINK_LABEL);
      await expect(safeLink).toHaveAttribute('rel', /noopener/);
      await expect(doc).toContainText(UNSAFE_LINK_LABEL);
      await expect(doc.locator('a', { hasText: UNSAFE_LINK_LABEL })).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test('creates anchored comments whose stored offsets are code points, then survives reload and request_changes', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openSpecTab(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      // Create a comment on each of the four fixture passages through the composer.
      await selectAndComment(page, PASSAGE_A, 'Clarify uniqueness scope.');
      await selectAndComment(page, PASSAGE_B, 'Does deletion really cascade?');
      await selectAndComment(page, TABLE_CELL, 'What is the createdAt format?');
      await selectAndComment(page, CODE_LINE, 'Rename the fixture variable.');

      await expect.poll(() => distinctMarkerCount(page)).toBe(4);

      // Verify the stored anchors through the SDK: code-point offsets, exact quotes.
      const { markdown } = await getSpec(fakeServer.baseUrl, runId);
      const feedback = await listFeedback(fakeServer.baseUrl, runId);
      const byQuote = new Map(feedback.map((item) => [item.anchor?.quotedText, item]));

      for (const passage of [PASSAGE_A, PASSAGE_B, TABLE_CELL, CODE_LINE]) {
        const item = byQuote.get(passage);
        expect(item, `feedback for ${passage}`).toBeDefined();
        const anchor = item?.anchor;
        expect(anchor?.kind).toBe('artifact_range');
        expect(anchor?.from).toBe(cpIndexOf(markdown, passage));
        expect(anchor?.to).toBe(cpIndexOf(markdown, passage) + [...passage].length);
        expect(anchor?.quotedText).toBe(passage);
      }

      // Passage A follows an astral emoji, so its code-point `from` is one lower than its UTF-16 index.
      const aFrom = byQuote.get(PASSAGE_A)?.anchor?.from ?? -1;
      expect(markdown.slice(0, markdown.indexOf(SPEC_EMOJI))).not.toContain(SPEC_EMOJI);
      expect(aFrom).toBe(markdown.indexOf(PASSAGE_A) - 1);

      // Reload: all four anchored comments come back from the SDK.
      await page.reload();
      await page.getByRole('tab', { name: 'Spec' }).click();
      await expect(page.getByTestId('spec-document')).toBeVisible();
      await expect.poll(() => distinctMarkerCount(page)).toBe(4);

      // An SDK-created comment with no anchor lands in the no-range group.
      const noAnchor = await fetch(`${fakeServer.baseUrl}/v1/runs/${runId}/feedback`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ target: 'artifact', title: 'General note', body: 'A general spec note with no range.' })
      });
      expect(noAnchor.ok).toBe(true);
      await page.reload();
      await page.getByRole('tab', { name: 'Spec' }).click();
      await expect(page.getByTestId('comment-group-no-range')).toBeVisible();

      // Request changes over the open feedback; the run revises the spec and returns to review.
      const reply = await fetch(`${fakeServer.baseUrl}/v1/runs/${runId}/replies`, {
        method: 'POST',
        headers: AUTH,
        body: JSON.stringify({ kind: 'request_changes' })
      });
      expect(reply.ok).toBe(true);

      // Wait until the revision has fully settled on the server: the spec is revised (passage B
      // removed), passage B's anchor is reconciled stale, and the addressed-after-revision status
      // transition (which lags the spec write) has landed on the surviving anchors. Snapshotting
      // before this settles would read a half-applied state.
      await expect
        .poll(
          async () => {
            const spec = await getSpec(fakeServer.baseUrl, runId);
            if (spec.markdown.includes(PASSAGE_B)) {
              return false;
            }
            const fb = await listFeedback(fakeServer.baseUrl, runId);
            const byQuoteNow = new Map(fb.map((item) => [item.anchor?.quotedText, item]));
            const survivorsNow = fb.filter((item) => item.anchor?.kind === 'artifact_range' && item.anchor.stale !== true);
            return (
              byQuoteNow.get(PASSAGE_B)?.anchor?.stale === true &&
              survivorsNow.length >= 3 &&
              survivorsNow.every((item) => item.status !== 'open')
            );
          },
          { timeout: 90_000 }
        )
        .toBe(true);

      const revised = await getSpec(fakeServer.baseUrl, runId);
      const revisedFeedback = await listFeedback(fakeServer.baseUrl, runId);
      const revisedByQuote = new Map(revisedFeedback.map((item) => [item.anchor?.quotedText, item]));

      // Passage A moved forward (its code-point from grew) and is not stale; B is stale.
      expect(revisedByQuote.get(PASSAGE_A)?.anchor?.stale).not.toBe(true);
      expect(revisedByQuote.get(PASSAGE_A)?.anchor?.from).toBe(cpIndexOf(revised.markdown, PASSAGE_A));
      expect(revisedByQuote.get(PASSAGE_A)?.anchor?.from).toBeGreaterThan(aFrom);
      expect(revisedByQuote.get(PASSAGE_B)?.anchor?.stale).toBe(true);
      // createdAt and the code line sit before the insertion point, so they stay anchored.
      expect(revisedByQuote.get(TABLE_CELL)?.anchor?.stale).not.toBe(true);
      expect(revisedByQuote.get(CODE_LINE)?.anchor?.stale).not.toBe(true);

      // In the UI after reload: B shows in the stale group, the survivors keep markers, and each
      // marker's style matches the reconciled status. The revision addressed the delivered feedback,
      // so the survivors draw the resolved style (color + underline, not color only).
      await page.reload();
      await page.getByRole('tab', { name: 'Spec' }).click();
      await expect(page.getByTestId('spec-document')).toBeVisible();
      await expect(page.getByTestId('comment-group-stale')).toContainText(PASSAGE_B);

      const anchoredSurvivors = revisedFeedback.filter(
        (item) => item.anchor?.kind === 'artifact_range' && item.anchor.stale !== true
      );
      expect(anchoredSurvivors.length).toBeGreaterThanOrEqual(3);
      await expect.poll(() => distinctMarkerCount(page)).toBe(anchoredSurvivors.length);

      for (const item of anchoredSurvivors) {
        const expectedStyle = item.status === 'open' ? 'open' : 'resolved';
        await expect(page.locator(`[data-marker-for="${item.id}"]`).first()).toHaveAttribute('data-marker-style', expectedStyle);
      }
    } finally {
      await close();
    }
  });

  test('applies the design-system geometry for the reading column, tables, code, and comments', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openSpecTab(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      // Comment column width equals --width-comment-column (11rem ~ 176px).
      const columnWidth = await page.getByTestId('comment-column').evaluate((el) => el.getBoundingClientRect().width);
      expect(Math.round(columnWidth)).toBe(176);

      // Table cells carry a border.
      const cellBorder = await page
        .locator('[data-spec-document] tbody td')
        .first()
        .evaluate((el) => getComputedStyle(el).borderBottomWidth);
      expect(parseFloat(cellBorder)).toBeGreaterThan(0);

      // Code block has an outline/border and a 4px (--radius-sm) radius.
      const codeBox = page.locator('[data-spec-document] pre').first();
      const radius = await codeBox.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      const borderWidth = await codeBox.evaluate((el) => getComputedStyle(el).borderTopWidth);
      expect(radius).toBe('4px');
      expect(parseFloat(borderWidth)).toBeGreaterThan(0);

      // Create two comments on different blocks and assert their cards do not overlap.
      await selectAndComment(page, TABLE_CELL, 'First comment.');
      await selectAndComment(page, PASSAGE_A, 'Second comment.');
      const cards = page.locator('[data-card-for]');
      await expect(cards).toHaveCount(2);
      const boxes = await cards.evaluateAll((els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        })
      );
      const sorted = [...boxes].sort((a, b) => a.top - b.top);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i]!.top).toBeGreaterThanOrEqual(sorted[i - 1]!.bottom - 0.5);
      }
    } finally {
      await close();
    }
  });
});
