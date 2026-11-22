import { expect, type Page } from '@playwright/test';

/** Select the first rendered occurrence of `needle` inside the spec document and open the composer. */
export async function selectAndComment(page: Page, needle: string, body: string): Promise<void> {
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
