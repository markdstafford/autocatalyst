# Bug triage: Notion HTML artifacts in GitHub issue bodies

**Issue:** #59 — fix: clean up Notion HTML in issue body when writing to GitHub
**Type:** bug
**Priority:** P2: medium
**Labels:** bug

---

## Summary

When `getPageMarkdown()` fetches a spec from Notion and that content is used as a GitHub issue body, Notion-specific HTML is passed through verbatim. GitHub does not render Notion's HTML table syntax or discussion span attributes — the result is raw HTML visible in the issue body instead of formatted content. Issue #57 shows the problem: a table appears as `<table header-row="true">...</table>` and inline comment anchors appear as `text`.

## Steps to reproduce

1. Create a spec in Notion that includes a table and Notion-annotated text (comment spans).
2. Trigger a bug or chore triage approval that uses the Notion page content as the GitHub issue body.
3. Open the resulting GitHub issue — the table and span elements render as raw HTML.

## Expected behavior

The GitHub issue body should contain readable content without raw HTML artifacts:
- HTML table tags stripped, with cell content preserved
- Comment span tags stripped, with inner text preserved

## Actual behavior

The issue body contains Notion-specific HTML that GitHub does not render:
- `<table header-row="true"><tr><td>...</td></tr></table>` — Notion's HTML table format
- `text` — Notion inline comment anchors

Both are visible as raw HTML in the rendered issue, as seen in issue #57.

## Root cause

`getPageMarkdown()` in `src/adapters/notion/notion-publisher.ts` (line 103–105) is a thin wrapper over `this.client.pages.getMarkdown(publisher_ref)`, which calls Notion's markdown API endpoint (`pages/${page_id}/markdown`). That API returns markdown that embeds Notion-flavored HTML:

- **Tables:** Notion serializes tables as HTML (`<table header-row="true">`) rather than GFM pipe tables.
- **Comment spans:** Notion includes inline comment anchors as `text`.

The `spec-committer.ts` already applies `stripCommentSpans()` and `prettifyMarkdown()` from `markdown-diff.ts` when committing specs to git — these transforms handle spans and whitespace. However, **neither transform is applied in the path that writes to GitHub issue bodies**, and **there is no existing function to strip HTML generically**.

The only transformation currently in `markdown-diff.ts`:
- `stripCommentSpans(raw)` — strips `` tags, preserving inner text ✅ (git path only)
- `prettifyMarkdown(raw)` — normalizes whitespace and headings ✅ (git path only)
- `extractCommentSpans` / `ensureSpansPreserved` — span preservation during spec revision

Missing:
- **No **`stripHtml()`** function** to remove all HTML tags (preserving inner text) — anywhere in the codebase
- **No post-processing applied in the GitHub issue writing path**

YAML frontmatter stripping is a related but separate concern (noted in the issue as handled by the bug/chore approval handler).

## Affected files

- `src/adapters/notion/markdown-diff.ts` — needs a new `stripHtml(markdown)` function
- `src/adapters/notion/notion-publisher.ts` — <span discussion-urls="discussion://3465d6c2-8761-809e-9e6a-001ce32dc6ed">`getPageMarkdown()` should accept a `stripHtml?: boolean` parameter to give callers control over whether HTML transforms are applied; `stripHtml=true` also fixes spec files on disk that currently inherit Notion HTML
- The code path that passes Notion markdown to `gh issue create/edit` — needs to pass `stripHtml: true` before use

## Suggested approach

Add a `stripHtml?: boolean` parameter to `getPageMarkdown()` in `src/adapters/notion/notion-publisher.ts`:

```typescript
async getPageMarkdown(publisher_ref: PublisherRef, stripHtml = false): Promise<string> {
  const raw = await this.client.pages.getMarkdown(publisher_ref);
  return stripHtml ? stripAllHtml(raw) : raw;
}
```

This gives callers full control:
- Pass `stripHtml: true` when writing to GitHub issue bodies or spec files on disk — both get clean output with no HTML artifacts.
- Omit `stripHtml` (default `false`) for roundtrip use cases (e.g., responding to Notion feedback) where the full Notion markdown with HTML must be preserved.

`stripAllHtml` in `src/adapters/notion/markdown-diff.ts` removes all HTML tags, preserving inner text:

```typescript
/**
 * Strip all HTML tags from Notion-flavored markdown, preserving inner text.
 * Handles <table>, , and any other Notion HTML artifacts.
 */
export function stripAllHtml(raw: string): string {
  return raw.replace(/<[^>]*>/g, '');
}
```

This subsumes `stripCommentSpans` behavior (which only targeted `<span discussion-urls>` tags) and handles Notion table HTML as well, with no need for a table-specific parser.

## Task list

1. **Add `stripAllHtml` to `markdown-diff.ts`** — Implement and export `stripAllHtml(raw: string): string` in `src/adapters/notion/markdown-diff.ts` using the regex approach described above.
2. **Update `getPageMarkdown` signature** — Add optional `stripHtml?: boolean` parameter (default `false`) to `getPageMarkdown()` in `src/adapters/notion/notion-publisher.ts`; apply `stripAllHtml(raw)` when `true`.
3. **Update the GitHub issue write callsite** — Locate the code that passes Notion markdown to `gh issue create/edit` and update it to call `getPageMarkdown(ref, true)`.
4. **Update the spec file write callsite** — Locate the code that writes spec content to disk and update it to call `getPageMarkdown(ref, true)`.
5. **Write unit tests for `stripAllHtml`** — Cover: table tags, span tags, passthrough (no HTML), self-closing tags, empty string.
6. **Write integration tests for `getPageMarkdown`** — Cover: `stripHtml=true` returns content with no HTML; `stripHtml=false` (default) leaves HTML intact.
7. **Run regression suite** — Confirm all existing `spec-committer.ts` tests pass and `stripCommentSpans` behavior is unaffected.

## Testing <span discussion-urls="discussion://3465d6c2-8761-8038-aa71-001c4d1f4e70">requirements

### Implementation tasks

- [x] Add `stripAllHtml(raw: string): string` export to `src/adapters/notion/markdown-diff.ts`
- [x] Add `stripHtml?: boolean` parameter (default `false`) to `getPageMarkdown()` in `src/adapters/notion/notion-publisher.ts`
- [x] Update the GitHub issue write path to call `getPageMarkdown(ref, true)`
- [x] Update the spec file write path to call `getPageMarkdown(ref, true)`
- [x] Confirm `stripCommentSpans` call in `spec-committer.ts` is unaffected (no regression)

### Unit tests: `stripAllHtml`

- [ ] Removes `<table header-row="true">`, `<tr>`, `<td>` tags, preserving cell text
- [ ] Removes `` tags, preserving inner text
- [ ] Passes through content with no HTML unchanged
- [ ] Handles self-closing tags (e.g., `<br/>`) without leaving artifacts
- [ ] Returns empty string for empty input

### Integration tests: `getPageMarkdown`

- [ ] `getPageMarkdown(ref, true)` returns content with no HTML tags
- [ ] `getPageMarkdown(ref, false)` (or no second arg) returns raw Notion markdown with HTML intact

### End-to-end verification

- [ ] `stripAllHtml` applied to the actual issue #57 body produces no remaining `<table` or `<span discussion-urls` tags
- [ ] A GitHub issue created from a Notion page containing a table renders without raw HTML

### Regression

- [x] `stripCommentSpans` behavior in the spec-committer path is unchanged
- [x] Existing spec-committer tests still pass

---

*Original report by @markdstafford*
> fix: clean up Notion HTML in issue body when writing to GitHub
>
> When a bug or chore triage is approved, `getPageMarkdown()` returns Notion-flavored content
> that includes Notion-specific HTML artifacts that render poorly in GitHub issues:
> - `<table header-row="true">` — Notion's HTML table format instead of standard markdown tables
> - `<span discussion-urls="discussion://...">` — Notion-specific span attributes
> - Possibly other Notion HTML artifacts
>
> Issue #57 is an example: the `### Part 2` table and `Testing requirements` section rendered as raw HTML.

## Orphaned comments

- <span discussion-urls="discussion://3465d6c2-8761-80da-92ad-001cee9e0212">**`convertHtmlTables`**
- **Option B — call **
- **`cleanForGitHub()`**
- ** only at the write-to-GitHub callsite**
