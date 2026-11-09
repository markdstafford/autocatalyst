/**
 * Spec-gate end-to-end coverage against fake mode on the production path.
 *
 * Seeds the spec-review scenario, opens the built client served by its own fake control plane
 * (authenticated through the connected storage-state fixture — the real Connection page, no injected
 * token), and exercises the real "decide a spec gate and track comments" flow through the production
 * UI: the one pane-bar decision button (Approve / Request changes (N)) and its confirm popover, the
 * footer comment counts and previous/next navigation, the full-screen expand overlay, and the
 * design-system geometry of the decision button and the footer detail-pane zone.
 *
 * Runs advance only through the real `replies` endpoint (the same call `replyToRun` makes) or by
 * activating the production decision button. No test routes around the API, writes browser storage, or
 * makes a model call. The scripted fake agent revises the spec deterministically on request_changes,
 * so the revision's effect on comments is observed through the real reconciled UI/state, never faked.
 */
import { expect, test, FIXTURE_TOKEN } from './fixtures/connected.js';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';

// Fixture literals, kept in sync with apps/control-plane/src/fake/constants.ts. Duplicated because a
// scope:web e2e may not import from the control-plane app.
const PASSAGE_A = 'A. Names must be unique within a tenant.';
const PASSAGE_B = 'B. Deletion cascades to every child record.';
const PASSAGE_C = 'C. Timestamps use ISO-8601 in UTC.';

const AUTH = { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' } as const;
const EDGE = 0.5;
/** The literal pane padding the design system states (pane bar horizontal padding, px-3 = 12px). */
const PANE_PADDING_PX = 12;

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

async function openSpecTab(
  browser: Browser,
  connectedStatePath: string,
  url: string,
  contextOptions: BrowserContextOptions = {}
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: connectedStatePath, ...contextOptions });
  const page = await context.newPage();
  await page.goto(url);
  await page.getByRole('tab', { name: 'Spec' }).click();
  await expect(page.getByTestId('spec-document')).toBeVisible();
  return { page, close: () => context.close() };
}

async function getSpec(baseUrl: string, runId: string): Promise<{ markdown: string }> {
  const response = await fetch(`${baseUrl}/v1/runs/${runId}/spec`, { headers: AUTH });
  if (!response.ok) {
    throw new Error(`getRunSpec failed: ${response.status}`);
  }
  const json = (await response.json()) as { markdown: string };
  return { markdown: json.markdown };
}

async function listFeedback(baseUrl: string, runId: string): Promise<FeedbackItem[]> {
  const response = await fetch(`${baseUrl}/v1/runs/${runId}/feedback`, { headers: AUTH });
  if (!response.ok) {
    throw new Error(`listRunFeedback failed: ${response.status}`);
  }
  return ((await response.json()) as { feedback: FeedbackItem[] }).feedback;
}

/** Count distinct anchored comments (one marker may render several client-rect boxes under one id). */
async function distinctMarkerCount(page: Page): Promise<number> {
  return page
    .locator('[data-marker-for]')
    .evaluateAll((els) => new Set(els.map((el) => el.getAttribute('data-marker-for'))).size);
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

test.describe('spec gate', () => {
  test('requests changes, takes the scripted revision, then approves into the implementation gate', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openSpecTab(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      // Nothing is open yet: the gate's primary action is Approve.
      await expect(page.getByTestId('spec-gate-decision')).toHaveText('Approve');
      await expect(page.getByTestId('spec-comment-counts')).toHaveText('0 open, 0 resolved');

      // Comment on passage A — a passage the revision keeps (it moves forward and comes back addressed).
      await selectAndComment(page, PASSAGE_A, 'Clarify uniqueness scope.');

      // The decision changes in place to Request changes (1) and the footer tracks the open count.
      await expect(page.getByTestId('spec-gate-decision')).toHaveText('Request changes (1)');
      await expect(page.getByTestId('spec-comment-counts')).toHaveText('1 open, 0 resolved');

      // Activate the decision and confirm in the popover; the run leaves the gate so the button hides.
      await page.getByTestId('spec-gate-decision').click();
      await page.getByTestId('spec-gate-decision-confirm').click();
      await expect(page.getByTestId('spec-gate-decision')).toBeHidden({ timeout: 30_000 });

      // Wait until the revision has fully settled on the server: passage B (and its heading) removed,
      // and the surviving passage-A comment transitioned off `open` (addressed-after-revision, which
      // lags the spec write). Snapshotting before this settles would read a half-applied state.
      await expect
        .poll(
          async () => {
            const spec = await getSpec(fakeServer.baseUrl, runId);
            if (spec.markdown.includes(PASSAGE_B)) {
              return false;
            }
            const fb = await listFeedback(fakeServer.baseUrl, runId);
            const a = fb.find((item) => item.anchor?.quotedText === PASSAGE_A);
            return a !== undefined && a.anchor?.stale !== true && a.status !== 'open';
          },
          { timeout: 90_000 }
        )
        .toBe(true);

      // Back at the gate: the decision reads Approve again and the revision's addressed comment shows.
      await page.reload();
      await page.getByRole('tab', { name: 'Spec' }).click();
      await expect(page.getByTestId('spec-document')).toBeVisible();
      await expect(page.getByTestId('spec-gate-decision')).toHaveText('Approve');
      // The surviving passage-A card is now addressed.
      const cardA = page.locator('[data-card-for]').filter({ hasText: PASSAGE_A });
      await expect(cardA.getByTestId('status-chip')).toHaveText('addressed');

      // Open the approve popover: because the connected operator authored the now-addressed comment,
      // the co-confirmation copy is shown.
      await page.getByTestId('spec-gate-decision').click();
      await expect(page.getByTestId('spec-gate-decision-copy')).toBeVisible();

      // Confirm the approve; the run advances past spec review into the implementation gate. The pane
      // state reflects implementation (see run-detail.spec.ts `approve` assertions).
      await page.getByRole('tab', { name: 'Summary' }).click();
      await page.getByTestId('spec-gate-decision').click();
      await page.getByTestId('spec-gate-decision-confirm').click();
      await expect(page.getByTestId('pane-summary-step')).toContainText('implementation', { timeout: 30_000 });
    } finally {
      await close();
    }
  });

  test('navigates comments in document order with edge-disabled previous/next', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openSpecTab(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      // Two anchored comments on two passages. In the fixture layout passage C precedes passage A, so
      // document order is [C, A].
      await selectAndComment(page, PASSAGE_C, 'Which timezone library?');
      await selectAndComment(page, PASSAGE_A, 'Clarify uniqueness scope.');
      await expect.poll(() => distinctMarkerCount(page)).toBe(2);

      await expect(page.getByTestId('spec-gate-decision')).toHaveText('Request changes (2)');
      await expect(page.getByTestId('spec-comment-counts')).toHaveText('2 open, 0 resolved');

      // Resolve the anchored comment ids in document order (by their marker top).
      const orderedIds = await page.evaluate(() => {
        const seen = new Map<string, number>();
        for (const el of Array.from(document.querySelectorAll('[data-marker-for]'))) {
          const id = el.getAttribute('data-marker-for');
          if (id === null) {
            continue;
          }
          const top = (el as HTMLElement).getBoundingClientRect().top;
          if (!seen.has(id) || top < (seen.get(id) as number)) {
            seen.set(id, top);
          }
        }
        return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
      });
      expect(orderedIds.length).toBe(2);

      const prev = page.getByTestId('spec-comment-previous');
      const next = page.getByTestId('spec-comment-next');
      const firstMarker = page.locator(`[data-marker-for="${orderedIds[0]}"]`).first();
      const secondMarker = page.locator(`[data-marker-for="${orderedIds[1]}"]`).first();

      // Before any selection, previous is soft-disabled (nothing selected ⇒ no earlier item).
      await expect(prev).toHaveAttribute('aria-disabled', 'true');

      // Next selects the first comment in document order; its marker becomes selected.
      await next.click();
      await expect(firstMarker).toHaveAttribute('data-marker-style', 'selected');
      // At the first item previous is disabled; next still enabled (a second item remains).
      await expect(prev).toHaveAttribute('aria-disabled', 'true');
      await expect(next).not.toHaveAttribute('aria-disabled', 'true');

      // Next again selects the second (last) comment; the first deselects, the card marks selected.
      await next.click();
      await expect(secondMarker).toHaveAttribute('data-marker-style', 'selected');
      await expect(firstMarker).not.toHaveAttribute('data-marker-style', 'selected');
      await expect(page.locator(`[data-card-for="${orderedIds[1]}"]`)).toHaveAttribute('data-selected', 'true');
      // At the last item next is disabled; previous enabled.
      await expect(next).toHaveAttribute('aria-disabled', 'true');
      await expect(prev).not.toHaveAttribute('aria-disabled', 'true');

      // Previous walks back to the first comment in document order.
      await prev.click();
      await expect(firstMarker).toHaveAttribute('data-marker-style', 'selected');
      await expect(page.locator(`[data-card-for="${orderedIds[0]}"]`)).toHaveAttribute('data-selected', 'true');
      await expect(prev).toHaveAttribute('aria-disabled', 'true');
    } finally {
      await close();
    }
  });

  test('expands to a full-viewport overlay and decides the gate from it', async ({
    browser,
    fakeServer,
    connectedStatePath
  }) => {
    const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
    const { page, close } = await openSpecTab(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`);
    try {
      // Open the full-screen overlay.
      await page.getByTestId('spec-expand').click();
      const overlay = page.getByTestId('spec-overlay');
      await expect(overlay).toBeVisible();

      // The overlay bounding box equals the viewport.
      const box = await overlay.boundingBox();
      const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      expect(box).not.toBeNull();
      if (box !== null) {
        expect(Math.abs(box.x)).toBeLessThanOrEqual(EDGE);
        expect(Math.abs(box.y)).toBeLessThanOrEqual(EDGE);
        expect(Math.abs(box.width - viewport.w)).toBeLessThanOrEqual(EDGE);
        expect(Math.abs(box.height - viewport.h)).toBeLessThanOrEqual(EDGE);
      }

      // The overlay carries its own comment counts and gate decision.
      await expect(overlay.getByTestId('spec-comment-counts')).toHaveText('0 open, 0 resolved');
      await expect(overlay.getByTestId('spec-gate-decision')).toHaveText('Approve');

      // Escape once closes a confirm popover opened in the overlay; a second Escape closes the overlay.
      await overlay.getByTestId('spec-gate-decision').click();
      await expect(page.getByTestId('spec-gate-decision-confirm')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('spec-gate-decision-confirm')).toBeHidden();
      await expect(overlay).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(overlay).toBeHidden();

      // Reopen and make the Approve decision from the overlay; it has the same effect as the pane — the
      // run advances past the spec gate, so the overlay's decision button disappears.
      await page.getByTestId('spec-expand').click();
      const reopened = page.getByTestId('spec-overlay');
      await expect(reopened).toBeVisible();
      await reopened.getByTestId('spec-gate-decision').click();
      // The confirm popover now portals into a container INSIDE the focus-trapped overlay dialog, so a
      // real operator's pointer click lands — the modal layer no longer treats it as inert and swallows
      // the click. Activate it with a normal click to prove the end-to-end pointer path.
      const overlayConfirm = page.getByTestId('spec-gate-decision-confirm');
      await expect(overlayConfirm).toBeVisible();
      await overlayConfirm.click();
      await expect(reopened.getByTestId('spec-gate-decision')).toBeHidden({ timeout: 30_000 });

      // Close the overlay and confirm the pane advanced past spec review into implementation.
      await reopened.getByTestId('spec-overlay-close').click();
      await expect(page.getByTestId('spec-overlay')).toBeHidden();
      await page.getByRole('tab', { name: 'Summary' }).click();
      await expect(page.getByTestId('pane-summary-step')).toContainText('implementation', { timeout: 30_000 });
    } finally {
      await close();
    }
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`spec gate geometry (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('aligns the decision button and the footer detail-pane zone with the pane', async ({
      browser,
      fakeServer,
      connectedStatePath
    }) => {
      const { runId } = await fakeServer.seed({ scenario: 'spec-review' });
      const { page, close } = await openSpecTab(browser, connectedStatePath, `${fakeServer.baseUrl}/runs/${runId}`, {
        colorScheme: scheme
      });
      try {
        await expect(page.getByTestId('spec-gate-decision')).toHaveText('Approve');

        const assertGeometry = async (): Promise<void> => {
          const pane = await page.getByRole('complementary', { name: 'Run detail' }).boundingBox();
          const bar = await page.getByTestId('pane-bar').boundingBox();
          const decision = await page.getByTestId('spec-gate-decision').boundingBox();
          const footerZone = await page.getByRole('group', { name: 'Detail pane' }).boundingBox();
          expect(pane && bar && decision && footerZone).toBeTruthy();
          if (pane && bar && decision && footerZone) {
            // The decision button's right edge is one pane padding (12px) from the pane's right edge.
            expect(Math.abs(pane.x + pane.width - (decision.x + decision.width) - PANE_PADDING_PX)).toBeLessThanOrEqual(EDGE);
            // The decision button's vertical center aligns with the pane bar's vertical center.
            expect(Math.abs(decision.y + decision.height / 2 - (bar.y + bar.height / 2))).toBeLessThanOrEqual(EDGE);
            // The footer detail-pane zone's left edge equals the pane's left edge.
            expect(Math.abs(footerZone.x - pane.x)).toBeLessThanOrEqual(EDGE);
          }
        };

        // Sidebar open (default).
        await assertGeometry();

        // Sidebar closed: the pane keeps its alignment as the main area reflows.
        await page.getByRole('button', { name: 'Toggle sidebar' }).click();
        await page.waitForTimeout(300);
        await assertGeometry();
      } finally {
        await close();
      }
    });
  });
}
