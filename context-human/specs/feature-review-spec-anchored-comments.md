---
created: 2026-11-08
last_updated: 2026-11-08
status: draft
issue: 137
specced_by: markdstafford
---
# Review a spec with anchored comments

## What

Operators can review a run's spec in the web client's Spec tab as a rendered document and leave comments on the text they select. The selected passage becomes an anchored spec comment that appears beside the relevant text, stays attached across server-reconciled spec revisions when the quote moves, and remains visible as stale when the quote disappears.

This feature turns the Spec tab from a readiness placeholder into the review surface for the spec gate. It renders Markdown safely, highlights code blocks, maps rendered text selections back to source Markdown code-point offsets, creates artifact feedback with source-range anchors, and displays anchored, stale, and unanchored feedback in the comment column. It also updates the fake-mode scripted spec fixture so the end-to-end path can prove code-point behavior with an emoji outside the basic multilingual plane.

## Why

Spec review is the first major human judgment point in the Autocatalyst loop. Without anchored comments, an operator must describe locations indirectly, and the run cannot reliably carry review intent into a revision. Anchored comments let the operator point at the exact passage that needs work while preserving enough quote context for the control plane to validate, repair, or mark the anchor stale.

This also completes the client side of the spec feedback contracts from issues #135 and #136: the pane and live updates exist, the API validates/reconciles anchors, and the web client now provides the readable document and precise anchor creation needed for a real spec review.

## Personas

- **Phoebe: PM** - Reads generated specs for product correctness and comments on passages that need clarification or changed scope.
- **Enzo: Engineer** - Reviews technical details in the spec, including code snippets, tables, and edge cases, and leaves precise feedback before implementation starts.
- **Dani: Designer** - Reviews user-facing flows and wording in the spec, commenting on exact sentences or list items that need UX refinement.

## Narratives

### Comment on a selected passage

Phoebe opens the seeded spec-review run and switches to the Spec tab. The spec appears as a readable document with headings, lists, tables, and highlighted code blocks, while the comment column is empty except for a short hint that selecting text starts a comment.

She selects the paragraph line `A. Names must be unique within a tenant.` that follows the fixture emoji. A compact composer appears after the selection settles, with a temporary highlight over the pending range, the quoted passage, a text area, Comment, and Cancel. She types her concern and submits with Cmd+Enter. Even though focusing the textarea clears the browser's live DOM selection, the composer submits the anchor it captured when it opened. The selected text gets an open marker, and a card appears beside that passage with Phoebe's comment and the exact quote.

### Review comments after a revision

Enzo has several open comments on a spec. He requests changes, and the run revises the spec. When the run returns to spec review, the client reloads the spec and feedback through the SDK instead of trying to repair anchors locally.

The comment on passage A appears beside the same quote at its new offsets. In the scripted fixture, the revision inserts `- A name is trimmed of leading and trailing spaces.` immediately before the emoji plus passage A, without a blank line, so Markdown renders passage A after a soft line break inside the inserted list item. The marker still highlights `A. Names must be unique within a tenant.` and the anchor offsets include the source newline where required. The comment on passage B, `B. Deletion cascades to every child record.`, appears in the stale group because the revision removes it and the `## Open questions` heading. Comments on the `createdAt` table cell and the code line `const fixture = { name: "demo" };` stay anchored where they were because both sit before the insertion point.

### Read comments away from the gate

Dani opens a run that is no longer at spec.human_review. The Spec tab still renders the document and existing comment cards, so she can understand the review history and click between cards and markers.

When she selects text, no composer appears. The tab is read-only outside the spec gate, and there is no general comment box, reply field, Resolve/Reopen control, decision button, footer tally, previous/next comment control, or full-screen overlay in this issue.

## User stories

**Comment on a selected passage**

- Phoebe can read the run's spec as rendered Markdown in the Spec tab.
- Phoebe can select rendered text with a mouse or keyboard and create a comment anchored to the corresponding source Markdown range.
- Phoebe can see the pending selected range while the composer is open, even after the textarea receives focus.
- Phoebe can see an open marker on the selected text and a card beside that text.
- Phoebe can submit from the keyboard and recover from anchor-validation errors without losing her draft text.

**Review comments after a revision**

- Enzo can reopen the Spec tab after a run revision and see moved comments at the offsets returned by the control plane.
- Enzo can see stale comments grouped with their quote when the commented text no longer exists.
- Enzo can distinguish open markers from addressed, resolved, and wont_fix markers while cards show the exact status.
- Enzo can see unanchored or non-range artifact feedback in a separate no-range group.

**Read comments away from the gate**

- Dani can view the spec and existing comments even when the run is not waiting at spec.human_review.
- Dani can select marker text or cards to pair and scroll the corresponding item into view.
- Dani cannot create new spec comments outside the spec gate.

## Goals

- Render the full markdown returned by getRunSpec, including front matter in source offsets but not in the visible document.
- Map valid rendered selections to source Markdown Unicode code-point offsets and quotedText with test coverage for the Markdown constructs and Unicode cases in issue #137, plus soft line breaks.
- Require every client-created spec comment to use an artifact_range anchor and never send anchorless spec comments from the web client.
- Display anchored, stale, and no-range feedback in the Spec tab with design-system marker, card, grouping, and geometry rules.
- Prove the production path in fake mode by creating comments on passage A (`A. Names must be unique within a tenant.`), passage B (`B. Deletion cascades to every child record.`), the table cell `createdAt`, and the code line `const fixture = { name: "demo" };`; reading stored anchors through the SDK; reloading; and verifying server-reconciled moved and stale comments after request_changes.

## Non-goals

- Resolve, reopen, replies, decision buttons, comment counts, footer tallies, previous/next navigation, and full-screen spec view.
- Searching the spec in the client for moved comments; the client trusts returned offsets and stale flags.
- Editing the spec or creating comments that are not anchored to selected text from the web client.
- Rendering diagrams in specs.
- Backend anchor validation or reconciliation changes beyond using the API delivered by #136; the only control-plane-side change in this feature is the deterministic fake fixture emoji used by tests.

## Design spec

### User flows

```mermaid
graph TD
    A[Operator opens Runs] --> B[Select run]
    B --> C[Open Spec tab]
    C --> D{getRunSpec result}
    D -->|200| E[Render spec document and comment column]
    D -->|404| F[Show existing #135 empty state]
    D -->|other error| G[Show inline error with retry]
    E --> H{Run at spec.human_review?}
    H -->|yes| I[Mouse or keyboard selection changes]
    H -->|no| J[Read-only document and comments]
    I --> K[Debounce until selection settles]
    K --> L{Whole selection inside spec document and maps to source range?}
    L -->|yes and <= 2000 JS chars| M[Store anchor and show composer with temporary highlight]
    L -->|no| E
    L -->|too long| N[Composer refusal message; nothing sent]
    M --> O[Textarea focus may clear DOM selection]
    O --> P[Submit using stored anchor]
    P --> Q[createRunFeedback]
    Q -->|201| R[Close composer and add returned card/marker]
    Q -->|422 invalid_feedback_anchor| S[Keep draft, show changed-spec message, reread spec and feedback]
    Q -->|other error| T[Keep draft and show error]
```

```mermaid
graph TD
    A[Spec tab opens or run changes] --> B[Read getRunSpec]
    B --> C[Read listRunFeedback]
    C --> D[Keep target artifact items]
    D --> E{Anchor kind}
    E -->|artifact_range, not stale, in bounds| F[Draw document marker and anchored card]
    E -->|artifact_range stale or still out of bounds after reread| G[Show stale group with quote]
    E -->|missing or other kind| H[Show no-range group]
    F --> I[Position cards at anchor tops and push down]
    I --> J[Reposition on pane resize and Shiki load]
```

### Key UI components

#### Rendered spec document

- Uses the existing Spec tab region from #135 and replaces only the ready-spec placeholder state.
- Shows front matter nowhere in the rendered document, but source offsets still count the full markdown string returned by getRunSpec.
- Renders Markdown as literal content only: raw HTML is escaped as text, links are safe, and unsupported link schemes are plain text.
- Headings, paragraphs, lists, tables, inline code, fenced code, and block quotes follow the design-system Spec reading column rules.
- Soft line breaks are represented in the render source map as their own source range. When a newline inside a paragraph renders as a space or wrapping opportunity, selections across it include the source `\n`, and CRLF soft breaks include `\r\n` as two code points.
- Code blocks are selectable before and after Shiki loads; highlighting must not change source mapping.

#### Comment composer

- Opens from the document selectionchange flow, not only mouseup. The selection is debounced for a few hundred milliseconds so mouse drags, Shift+Arrow, Shift+Home, and in-document Select All settle before mapping.
- Appears only when the whole selection range lies inside the spec document element and the selected run's current step is spec.human_review.
- Stores `{ from, to, quotedText }` when it opens. Submit uses this stored anchor and never reads `window.getSelection()` again.
- Shows a temporary highlight over the stored pending range while open, so the operator can see what the comment is about after focus moves into the textarea.
- Shows a quote line, textarea, Comment button, and Cancel button.
- Comment is disabled while body text is empty and busy while submission is in flight.
- Ctrl+Enter and Cmd+Enter submit; Escape cancels.
- Closes on Escape, Cancel, a new selection elsewhere, and when the run leaves spec.human_review. Leaving the gate discards the draft.
- A selection longer than the 2000-character quotedText contract is refused with a message asking for a shorter passage and sends nothing.

#### Markers and cards

- Open artifact-range feedback draws the open marker style; addressed, resolved, and wont_fix draw the resolved marker style. The card chip uses the actual status string.
- Open and resolved markers differ by underline and color, so color is not the only signal.
- Clicking a marker selects its card. Clicking a card selects its marker and scrolls it into view. Only one pair is selected at a time.
- Overlapping markers both render; clicking overlapped text selects the shorter range.
- Cards show author display name or id, age, status chip, quoted text, body, and read-only thread entries after the first.
- Cards have no reply field and no Resolve/Reopen controls in this feature.

#### Comment column groups

- Anchored cards come first in document order and are positioned beside their anchor tops with no overlap.
- A stale group appears after anchored cards only when stale comments exist. Each stale item shows its quote and a stale chip with no marker.
- A no-range group appears after stale comments only when feedback lacks an artifact_range anchor. Items show body and omit the quote line when no quoted text exists.
- A spec with no comments shows an empty comment column with a short hint that selecting text starts a comment.

### Visual references

- Use context-agent/wiki/design-system.md, Spec reading column, as the visual source of truth for the reading column, comment column width, markers, cards, composer, tables, code block outline/radius, and geometry assertions.
- Add the design-system note that stale comments and comments with no range sit in groups at the end of the column.

## Tech spec

### Introduction and overview

#### Prerequisites and assumptions

- Depends on #135 for the run detail pane, Spec tab shell, live run updates, tab empty states, and detail-pane data refresh infrastructure.
- Depends on #136 for getRunSpec markdown/artifact/frontmatter, createRunFeedback anchor validation, listRunFeedback reconciled anchors, request_changes behavior, status values, and response-only stale anchors.
- Depends on ADR-033 for source Markdown code-point anchor semantics and control-plane reconciliation ownership.
- Depends on ADR-032 for the web client stack, Shiki loading model, React/Vite/Tailwind, Vitest, and Playwright.
- This spec supersedes the issue text's outdated fake-mode passage literals. The actual fixture source in apps/control-plane/src/fake/constants.ts is authoritative for the end-to-end test: passage A is `A. Names must be unique within a tenant.` after the emoji, passage B is `B. Deletion cascades to every child record.`, the table-cell passage is `createdAt`, and the code-line passage is `const fixture = { name: "demo" };`.
- The client must not compare quote text for reconciliation or search for moved text. It may only guard obviously out-of-bounds returned offsets.

#### Technical goals

- Keep source-range math isolated to apps/web/src/features/spec/code-points.ts and selection mapping isolated to apps/web/src/features/spec/selection-source-map.ts.
- Add Markdown parsing dependencies to apps/web: `unified`, `remark-parse`, `remark-gfm`, and `remark-frontmatter`. Use the current stable major versions compatible with ESM and the repo's toolchain: `unified` 11.x, `remark-parse` 11.x, `remark-gfm` 4.x, and `remark-frontmatter` 5.x. Commit the resulting package.json and pnpm-lock.yaml changes.
- Render mdast to React ourselves. Do not add rehype-raw, do not use dangerouslySetInnerHTML, and do not rely on an HTML sanitizer to make raw HTML safe.
- Carry source ranges onto every rendered text run needed for selection mapping and marker placement.
- Preserve SDK-only communication; no test-only hooks, no direct state injection around the API.
- Keep Shiki lazy and language/theme scoped to the languages and resolved theme in the rendered spec.

#### Non-goals

- No API-contract changes are required unless implementation discovers a missing exported type; this feature consumes the #136 contracts.
- No persistence schema changes.
- No feedback status mutation UI.

#### Glossary

- **Source Markdown**: The exact markdown string returned by getRunSpec, including front matter.
- **Code-point offset**: Zero-based offset counted by Unicode code points, not JavaScript UTF-16 code units.
- **Rendered selection**: A DOM Range selected in the rendered Spec document.
- **Artifact range anchor**: Feedback anchor of kind artifact_range with artifactId, from, to, and quotedText.
- **Stale comment**: A response with artifact_range anchor carrying stale: true because the quote no longer appears in the current spec.
- **Soft line break**: A newline inside a Markdown paragraph that renders as a space or line-wrapping opportunity, while the source slice still contains `\n` or `\r\n`.

### System design and architecture

```mermaid
graph TD
    R[Run detail pane] --> S[Spec tab]
    S --> A[SDK getRunSpec]
    S --> B[SDK listRunFeedback]
    A --> C[unified + remark parser]
    C --> D[mdast-to-React renderer with source ranges]
    D --> E[Rendered DOM with source map]
    E --> F[selection-source-map]
    F --> G[Composer stores anchor]
    G --> H[SDK createRunFeedback]
    B --> I[Comment model classifier]
    I --> J[Marker renderer]
    I --> K[Comment column layout]
    D --> L[Shiki highlighter]
    E --> J
```

```mermaid
sequenceDiagram
    actor Operator
    participant Browser as Browser selection
    participant SpecTab
    participant Mapper as selection-source-map
    participant SDK
    participant API as Control plane

    Operator->>Browser: Mouse or keyboard selects text
    Browser-->>SpecTab: selectionchange events
    SpecTab->>SpecTab: Debounce until selection settles
    SpecTab->>Mapper: markdown + render source map + DOM Range
    Mapper-->>SpecTab: { from, to, quotedText } or null
    SpecTab->>SpecTab: Store anchor and show temporary highlight
    Operator->>SpecTab: Focus textarea and type
    Browser-->>SpecTab: Live DOM selection may clear
    Operator->>SpecTab: Submit comment
    SpecTab->>SDK: createRunFeedback(target artifact, body, title, stored anchor)
    SDK->>API: POST /v1/runs/:id/feedback
    API-->>SDK: Feedback or 422 invalid_feedback_anchor
    alt Created
      SDK-->>SpecTab: Feedback
      SpecTab->>Operator: Show card and marker without reread
    else Invalid anchor
      SDK-->>SpecTab: 422
      SpecTab->>SDK: getRunSpec + listRunFeedback
      SpecTab->>Operator: Keep draft and show changed-spec message
    end
```

#### Component breakdown

- apps/web/src/features/spec/code-points.ts: pure helpers for code-point length, code-point slicing, and conversions between UTF-16 indexes and code-point offsets. Other web code must not use string.length as an offset into spec markdown.
- apps/web/src/features/spec/selection-source-map.ts: pure-ish selection mapper that takes markdown, render source map, and DOM Range and returns an anchor candidate or null.
- Spec parser/render module: uses unified with remark-parse, remark-gfm, and remark-frontmatter; parses markdown/front matter; renders mdast to React; records source ranges for text runs and transformed source spans; exposes the render source map consumed by selection and marker code.
- Spec tab integration: loads spec and feedback, handles loading/error/404 states, composes document, composer, markers, and comment column.
- Comment state/classification: filters target artifact feedback, groups anchored/stale/no-range comments, guards out-of-bounds ranges with one reread, and maps status to marker style.
- Shiki integration: lazy-loads highlighter on first code block, loads only languages present in the spec, chooses theme from resolved light/dark theme, and re-highlights on theme change.
- Fake fixture update: apps/control-plane/src/fake/constants.ts changes SPEC_EMOJI from BMP `✨` to an astral emoji such as `🚀`, and adds a unit test preventing regression to a BMP character.
- Tests and fakes: scripted SDK client for component tests; production fake-mode Playwright path for E2E.

### Detailed design

#### Markdown parsing and dependencies

- Add dependencies to apps/web/package.json: `unified` 11.x, `remark-parse` 11.x, `remark-gfm` 4.x, and `remark-frontmatter` 5.x. Update pnpm-lock.yaml.
- The renderer consumes mdast directly and creates React elements; raw HTML nodes are rendered as literal text.
- Do not add rehype-raw and do not call dangerouslySetInnerHTML.
- mdast positions carry `position.start.offset` and `position.end.offset` in UTF-16 code units. Every mdast offset must be converted through code-points.ts before it is used as an anchor offset into the spec markdown.
- A text node whose rendered `value` differs from its source slice identifies transformed text, including entities and escapes. The source map records both the rendered run and its full source range so the mapper can snap outward when a selection lands inside transformed text.
- Soft line breaks are represented as source-ranged break runs in the render source map. A selection across the rendered join includes the source newline, and a selection starting immediately after a soft break maps to the first character after that break.
- The first parser task includes a spike test over every construct in the mapping matrix. If any construct does not provide positions the mapper can use, the implementer must stop and choose one fallback before continuing: add a small micromark-token pass for the missing construct, or replace the parser stack with another reviewed parser that provides the needed positions.

#### Markdown rendering behavior

- Parse front matter as source-only metadata with remark-frontmatter: include its characters in source offsets, exclude it from the rendered document, and make selection mapping return null for any range that would map into front matter.
- Render links as anchors only for http, https, and mailto. Use target=_blank and rel="noopener noreferrer". Other schemes render as plain text.
- Render raw HTML as escaped literal text, never through dangerouslySetInnerHTML.
- Render GFM tables, task-list checkboxes, and strikethrough according to the design-system Spec reading column rules.

#### Source range model

- Every rendered text run receives data attributes or equivalent references that tie its rendered DOM text to source Markdown ranges.
- For identity text, a selected DOM character maps directly to the corresponding source code-point range.
- For text transformed by Markdown rendering, such as heading markers removed, emphasis markers hidden, link target syntax hidden, table delimiters hidden, soft line breaks, hard breaks, escapes, and entities, the mapper snaps outward where needed so quotedText is always the markdown slice in [from, to) and contains the selected rendered characters.
- Selections spanning multiple rendered nodes produce the minimal source range from the first selected character's mapped source boundary to the last selected character's mapped source boundary, including source syntax between them.
- Empty, whitespace-only, outside-document, comment-column, pane-header, and front-matter selections return null.

#### Code-point helper rules

- codePointLength(text): counts Array.from(text).length or equivalent.
- sliceByCodePoints(text, from, to): returns the source slice by code-point offsets without splitting surrogate pairs.
- utf16IndexToCodePointOffset(text, index) and codePointOffsetToUtf16Index(text, offset): convert at safe boundaries and clamp or reject mid-surrogate indexes according to tests.
- quotedText must equal sliceByCodePoints(markdown, from, to).
- The composer title uses the first line of body cut to 80 code points.
- The 2000-character quotedText maximum follows the API contract counted as JavaScript string length; a mapped result over that limit is refused by the composer before createRunFeedback.

#### Composer trigger and anchor lifetime

- Listen to selectionchange while the Spec tab is active. Debounce for a few hundred milliseconds after the last selectionchange before running the mapper, so mouse and keyboard selection both work.
- Run the mapper only if the whole DOM Range lies inside the spec document element. Ranges that start or end in the comment column, composer, pane header, or outside the document return null and do not open the composer.
- When the mapper returns an anchor candidate, store `{ from, to, quotedText }` and the rendered range identity in component state. This stored value drives the temporary highlight and the eventual createRunFeedback request.
- Do not read `window.getSelection()` at submit time. Browser focus movement into the textarea may clear or collapse the live selection, and that must not affect the stored anchor.
- Close the composer and discard draft text on Escape, Cancel, a new valid selection elsewhere, tab unmount, or when the run leaves spec.human_review.

#### Comment creation

- The composer is enabled only when the run's current step is spec.human_review.
- Submitting sends createRunFeedback(runId, { target: 'artifact', title, body, anchor: { kind: 'artifact_range', artifactId, from, to, quotedText } }).
- The web client never sends a spec comment with no anchor. If mapping returns null, no composer is created.
- On success, insert the returned feedback into local comment state immediately and render marker/card without waiting for another read.
- On 422 invalid_feedback_anchor, preserve composer text, show a changed-spec/match-failed message, and reread getRunSpec plus listRunFeedback.
- On other errors, preserve composer text and show the error message.

#### Showing comments

- listRunFeedback runs when the Spec tab opens, when the run's currentStep or updatedAt changes through #135 live updates, and after a comment is created or a 422 requires reload.
- Keep only feedback items with target artifact for this tab.
- For artifact_range anchors without stale: true, render at the returned from/to offsets without quote comparison or search.
- If returned from/to do not fit within the held markdown code-point length, reread spec and feedback once. If still out of bounds, show the comment in the stale group.
- Stale artifact_range comments render only in the stale group with their quote and stale chip.
- Missing anchors or non-artifact_range anchors render in the no-range group.
- Card positioning reads marker/anchor top positions and pushes later cards down to avoid overlap. Recompute on pane resize, content reflow, and Shiki completion.

#### Security, privacy, and compliance

- Raw HTML is escaped; no Markdown content is inserted as markup.
- Links are limited to http, https, and mailto when clickable, with noopener/noreferrer.
- Feedback body and title are sent as user input through existing SDK/API validation; frontend checks are UX and do not replace control-plane validation.
- Error display must not expose raw stack traces or secrets; use SDK error messages already surfaced for clients.
- No model calls are made by client tests or Playwright tests.

#### Observability

- No new telemetry surface is required for this feature.
- Client-side recoverable failures should be visible through test assertions and user-facing inline messages: spec load failures, feedback load failures, comment submit failures, and invalid anchors.
- Avoid logging selected text or comment bodies unless existing client test diagnostics already capture DOM state.

#### Testing plan

- Unit tests for code-points.ts cover BMP, astral symbols, mathematical letters, flag sequences, CRLF, tabs, UTF-16/code-point conversion, slicing, and surrogate boundaries.
- Unit tests for selection-source-map.ts use the production render function in a DOM test environment and DOM Selection/Range APIs. They cover every mapping case listed in issue #137 plus soft line breaks.
- Mapping tests include: a selection across a soft line break where the rendered text joins with a space or line wrap and quotedText contains source `\n`; a selection that starts just after a soft break; the same cases with CRLF where `\r\n` counts as two code points; and the real revised fixture case where passage A after request_changes maps to the right offsets and marker highlight.
- Component tests with a scripted SDK client cover rendering, loading/error states, composing, keyboard selection opening the composer, request body after an astral emoji, submitting after DOM selection is cleared, composer closure/draft discard when leaving the gate, duplicate-submit prevention, 422 reread path, marker/card pairing, stale/no-range groups, open/resolved marker styles, read-only state away from the gate, and Shiki pre/post load selection stability.
- Fake-mode unit coverage changes SPEC_EMOJI to an astral emoji and asserts SPEC_EMOJI.codePointAt(0) > 0xFFFF.
- Playwright fake-mode production-path test starts fake mode on a free port with fresh state, seeds spec-review, builds/serves the client, creates comments on passage A, passage B, the table cell `createdAt`, and the code line `const fixture = { name: "demo" };`, verifies stored anchors through SDK getRunSpec/listRunFeedback, reloads and rechecks markers, creates a no-anchor SDK comment, sends request_changes, and verifies moved/stale/addressed behavior.
- The Playwright test asserts passage A's stored `from` is exactly one lower than the UTF-16 index of the same passage in the markdown because the fixture emoji before it is outside the basic multilingual plane.
- Playwright geometry assertions cover table cell borders, code block outline/radius, comment column width, and non-overlapping card layout.

#### Affected files

- apps/web/package.json — add Markdown parser dependencies.
- pnpm-lock.yaml — lock the new parser dependencies.
- apps/web/src/features/spec/code-points.ts — new code-point helper module.
- apps/web/src/features/spec/selection-source-map.ts — new rendered-selection to source-anchor mapper.
- apps/web/src/features/spec/* renderer/comment modules — new Spec tab rendering, composer, markers, cards, and layout modules as implementation organizes them.
- apps/web/src/runs/run-detail-spec-tab.tsx and related run-detail modules — replace ready-spec placeholder with the rendered review surface while preserving empty states.
- apps/control-plane/src/fake/constants.ts — change SPEC_EMOJI to an astral emoji for the E2E offset proof.
- apps/control-plane/src/fake/scripted-results.spec.ts or nearby fake constants test — assert the fixture emoji is outside the BMP.
- context-agent/wiki/code-map.md — record mapping module, code-point helpers, render function, anchor placement rule, and tests.
- context-agent/wiki/design-system.md — add stale/no-range group rule to Spec reading column.

#### Alternatives considered

- **Anchor to rendered DOM paths:** Rejected because ADR-033 defines source Markdown offsets and rendered DOM paths are unstable across renderer changes.
- **Search in the client for moved quotes:** Rejected because #136 makes reconciliation a control-plane responsibility so every client sees the same result.
- **Plain textarea markdown view:** Rejected because the outcome requires rendered Markdown, safe links, Shiki-highlighted code, and comments beside the text they concern.
- **Require anchors at the API for all artifact feedback:** Rejected because #136 intentionally allows channel-originated or target-level feedback without anchors; the stricter rule belongs only to the web composer.
- **Leave parser selection to implementation:** Rejected because parser positions are the core risk and add dependencies. The reviewed choice is unified + remark-parse + remark-gfm + remark-frontmatter with a direct mdast-to-React renderer.

#### Risks

- Mapping rendered selections to source ranges is the highest-risk area because Markdown syntax can hide, transform, or reorder source characters. Mitigation: isolate mapping logic, carry source ranges on text runs, and use fixture plus generated round-trip tests.
- Parser position data may not be precise enough for every GFM construct. Mitigation: prove parser choice first with spike tests for all required constructs and use the stated fallback decision before building UI on it.
- Shiki may change DOM structure after async highlighting. Mitigation: keep selectable source-range wrappers stable around code text and assert identical mapping before and after Shiki load.
- Card layout can drift with pane width, font loading, or code highlighting. Mitigation: recompute on resize/highlight completion and cover geometry in Playwright.

## Task list

- [ ] **Story: Render the spec document with source positions**
  - [ ] **Task: Add parser dependencies and prove parser positions**
    - **Description**: Add unified 11.x, remark-parse 11.x, remark-gfm 4.x, and remark-frontmatter 5.x to apps/web, update pnpm-lock.yaml, and write a spike test proving each construct in the mapping matrix produces mdast positions the mapper can use.
    - **Acceptance criteria**:
      - [ ] apps/web/package.json includes the four parser dependencies and pnpm-lock.yaml is updated.
      - [ ] The spike test covers paragraphs, headings, emphasis, strong, strikethrough, inline code, links, ordered/unordered/nested/task lists, tables, fenced code, block quotes, front matter, raw HTML, entities, escapes, hard breaks, soft line breaks, and CRLF soft breaks.
      - [ ] Tests document that mdast offsets are UTF-16 code units and must pass through code-points.ts.
      - [ ] If any construct lacks usable positions, implementation stops and applies one reviewed fallback: a small micromark-token pass for the missing construct or a replacement parser stack with usable positions.
    - **Dependencies**: None
  - [ ] **Task: Build the mdast-to-React render pipeline**
    - **Description**: Build the production render function that parses with unified/remark and renders mdast to React elements plus a source map. Raw HTML must render as text and front matter must not render.
    - **Acceptance criteria**:
      - [ ] The Spec tab renders markdown from getRunSpec when a spec exists.
      - [ ] Front matter is parsed and excluded from the rendered document while still counted in source offsets.
      - [ ] Raw HTML renders as literal text, not markup.
      - [ ] Links are clickable only for http, https, and mailto and use rel="noopener noreferrer".
      - [ ] No code path uses rehype-raw or dangerouslySetInnerHTML for spec content.
    - **Dependencies**: "Task: Add parser dependencies and prove parser positions"
  - [ ] **Task: Carry source ranges on rendered text and break runs**
    - **Description**: Ensure every selectable text run and every transformed break run in headings, paragraphs, emphasis, inline code, links, lists, tables, task lists, block quotes, and code blocks carries enough source-range metadata for mapping and marker placement.
    - **Acceptance criteria**:
      - [ ] Rendered text nodes or wrappers expose stable source-range data to the mapping module.
      - [ ] Code, inline code, table cells, list items, headings, and block quotes are included.
      - [ ] Hidden Markdown syntax can be included in source ranges when a selection spans across it.
      - [ ] Soft line breaks carry their own source ranges so selections across or immediately after them map to the right source newline.
    - **Dependencies**: "Task: Build the mdast-to-React render pipeline"
  - [ ] **Task: Add lazy Shiki code highlighting**
    - **Description**: Render fenced code blocks as selectable plain text immediately, then highlight with Shiki after first use using the JavaScript regex engine, languages used by the spec, and the theme matching the resolved theme.
    - **Acceptance criteria**:
      - [ ] Unknown or missing code languages render as plain text.
      - [ ] Theme changes re-highlight code blocks.
      - [ ] Selection mapping is identical before and after Shiki loads.
      - [ ] Shiki is lazy-loaded and not part of the initial route load.
    - **Dependencies**: "Task: Carry source ranges on rendered text and break runs"

- [ ] **Story: Map rendered selections to source anchors**
  - [ ] **Task: Implement code-point helpers**
    - **Description**: Add apps/web/src/features/spec/code-points.ts with helpers for code-point length, code-point slicing, and UTF-16/code-point offset conversion. Use these helpers wherever the web client handles spec source offsets.
    - **Acceptance criteria**:
      - [ ] Helpers handle BMP characters, astral emoji, mathematical letters, flag sequences, CRLF, and tabs.
      - [ ] Helpers never split a surrogate pair.
      - [ ] No other apps/web file counts source Markdown offsets with string.length.
      - [ ] Unit tests cover the helper edge cases.
    - **Dependencies**: None
  - [ ] **Task: Implement selection-source-map.ts**
    - **Description**: Add apps/web/src/features/spec/selection-source-map.ts exporting a function that maps markdown, render source map, and DOM Range to { from, to, quotedText } in Unicode code points, or null for invalid selections.
    - **Acceptance criteria**:
      - [ ] Empty, whitespace-only, outside-document, pane-header/comment-column, and front-matter selections return null.
      - [ ] For every non-null result, quotedText equals the markdown slice [from, to) by code points and from < to.
      - [ ] Selections over transformed renderer text snap outward to source that contains the selected text.
      - [ ] Soft line breaks and CRLF soft line breaks map to source newlines when a selection crosses them or starts just after them.
      - [ ] The mapper does not depend on browser-only APIs beyond DOM Range/Selection available in the unit test environment.
    - **Dependencies**: "Task: Implement code-point helpers", "Task: Carry source ranges on rendered text and break runs"
  - [ ] **Task: Add comprehensive mapping unit tests**
    - **Description**: Create apps/web/src/features/spec/selection-source-map.spec.ts using the production render function and DOM selection API. Cover the issue #137 mapping matrix, soft line breaks, and generated round trips.
    - **Acceptance criteria**:
      - [ ] Tests run under pnpm nx test web without a browser.
      - [ ] Each mapped selection verifies quotedText equals the source slice.
      - [ ] Tests cover paragraphs, full-document selection, headings, emphasis/strong/strikethrough, inline code, links, lists/task lists, tables, fenced code in lists and block quotes, block-spanning ranges, Unicode outside the BMP, front matter, CRLF/tabs, entities/escapes/hard breaks, soft line breaks, CRLF soft line breaks, and raw HTML.
      - [ ] Generated round-trip tests prove markers for [from, to) highlight selected rendered text and nothing outside the slice.
      - [ ] The long-selection test proves the composer refuses >2000 JavaScript string length and sends nothing.
    - **Dependencies**: "Task: Implement selection-source-map.ts"

- [ ] **Story: Create anchored spec comments**
  - [ ] **Task: Build the selectionchange-driven composer**
    - **Description**: Add the composer UI to the Spec tab. It opens after a debounced selectionchange for mouse or keyboard selections, only while the run waits at spec.human_review, stores the mapped anchor when it opens, and shows a temporary highlight over the pending range.
    - **Acceptance criteria**:
      - [ ] Mouse selection opens the composer after the selection settles.
      - [ ] Keyboard selection such as Shift+Arrow opens the composer after the selection settles.
      - [ ] Composer appears only for selections wholly inside the spec document at spec.human_review.
      - [ ] The pending range remains highlighted while the textarea has focus.
      - [ ] Comment is disabled while the textarea is empty and shows busy state while submitting.
      - [ ] Ctrl+Enter and Cmd+Enter submit; Escape and Cancel close.
      - [ ] Selection outside the document or in front matter creates no composer.
      - [ ] There is no general comment box or other way to create a spec comment.
    - **Dependencies**: "Task: Implement selection-source-map.ts"
  - [ ] **Task: Submit createRunFeedback with stored artifact_range anchors**
    - **Description**: Wire composer submission to the SDK using the stored anchor, target artifact, body text, and an 80-code-point title from the first body line. Do not read the live DOM selection on submit.
    - **Acceptance criteria**:
      - [ ] Every web-created spec comment sends an anchor.
      - [ ] A unit test checks the request body for passage A after the astral emoji.
      - [ ] A unit test clears the DOM selection after the composer opens and proves submit still sends the original anchor.
      - [ ] Duplicate submit is prevented while the request is in flight.
      - [ ] On success, the returned feedback appears immediately as a card and marker without waiting for a reread.
    - **Dependencies**: "Task: Build the selectionchange-driven composer", "Task: Implement code-point helpers"
  - [ ] **Task: Handle composer closure, create failures, and long selections**
    - **Description**: Add UX for selection changes while composing, leaving the gate, selections whose quotedText exceeds 2000 JavaScript string length, and createRunFeedback errors including invalid_feedback_anchor.
    - **Acceptance criteria**:
      - [ ] A new selection elsewhere closes the current composer.
      - [ ] Leaving spec.human_review while the composer is open closes it and discards the draft.
      - [ ] Overlong selections show a shorter-passage message and send nothing.
      - [ ] 422 invalid_feedback_anchor keeps composer text, shows a changed-spec/match-failed message, and rereads spec plus feedback.
      - [ ] Other errors keep composer text and show the error message.
    - **Dependencies**: "Task: Submit createRunFeedback with stored artifact_range anchors"

- [ ] **Story: Display anchored, stale, and no-range comments**
  - [ ] **Task: Load and classify artifact feedback**
    - **Description**: Read listRunFeedback when the Spec tab opens, after comment creation, on invalid-anchor recovery, and when #135 live updates report currentStep or updatedAt changes. Keep target artifact items and group them as anchored, stale, or no range.
    - **Acceptance criteria**:
      - [ ] Only target artifact feedback appears in the Spec tab.
      - [ ] Artifact_range anchors without stale render at returned offsets without client quote comparison or search.
      - [ ] Out-of-bounds returned ranges trigger one spec+feedback reread and then fall back to the stale group if still invalid.
      - [ ] Missing anchors and non-artifact_range anchors render in the no-range group.
    - **Dependencies**: "Task: Build the mdast-to-React render pipeline"
  - [ ] **Task: Render document markers and card pairing**
    - **Description**: Draw markers over anchored ranges and implement marker/card selection, overlapping-marker behavior, and status-based open/resolved visual states.
    - **Acceptance criteria**:
      - [ ] open comments draw open markers; addressed, resolved, and wont_fix draw resolved markers.
      - [ ] Open and resolved markers differ by underline as well as color.
      - [ ] Overlapping comments both show, and clicking overlapped text selects the shorter range.
      - [ ] Clicking a marker selects and scrolls its card; clicking a card selects and scrolls its marker.
      - [ ] Only one marker/card pair is selected at a time.
    - **Dependencies**: "Task: Load and classify artifact feedback", "Task: Carry source ranges on rendered text and break runs"
  - [ ] **Task: Implement comment column layout and groups**
    - **Description**: Render cards in the comment column at anchor tops with push-down overlap avoidance, followed by stale and no-range groups when present.
    - **Acceptance criteria**:
      - [ ] Anchored cards are in document order and each top is at or below its anchor and below the previous card.
      - [ ] Positions update on pane resize and Shiki completion.
      - [ ] Stale comments show quote plus stale chip and no marker.
      - [ ] No-range comments show body and no marker, omitting quote when absent.
      - [ ] Empty comment column says selecting text starts a comment.
    - **Dependencies**: "Task: Render document markers and card pairing"

- [ ] **Story: Integrate Spec tab states, fake fixture, and visual rules**
  - [ ] **Task: Replace the ready-spec placeholder in the Spec tab**
    - **Description**: Integrate the renderer, feedback loading, composer, markers, and comment column into the existing Spec tab while preserving #135 loading and empty states.
    - **Acceptance criteria**:
      - [ ] Spec tab shows a loading state while spec loads.
      - [ ] 404 from getRunSpec uses the existing #135 empty state.
      - [ ] Non-404 failures show an inline retry message.
      - [ ] Existing tabs, pane layout, and live update behavior remain intact.
    - **Dependencies**: "Task: Load and classify artifact feedback", "Task: Build the selectionchange-driven composer"
  - [ ] **Task: Update fake-mode emoji fixture for astral offset proof**
    - **Description**: Change SPEC_EMOJI in apps/control-plane/src/fake/constants.ts from the BMP sparkle to an astral emoji such as 🚀, and add a unit test so the fixture keeps proving code-point versus UTF-16 behavior.
    - **Acceptance criteria**:
      - [ ] SPEC_EMOJI.codePointAt(0) > 0xFFFF in a fake constants/scripted results unit test.
      - [ ] Existing scripted spec tests still assert the spec body contains `${SPEC_EMOJI} ${SPEC_PASSAGE_A}`.
      - [ ] No hard-coded fixture offsets require updates.
    - **Dependencies**: None
  - [ ] **Task: Apply design-system styling and docs updates**
    - **Description**: Style the reading column, tables, code blocks, markers, cards, composer, and comment column according to context-agent/wiki/design-system.md, and update docs that implementation changes require.
    - **Acceptance criteria**:
      - [ ] Headings, text, lists, tables, and code blocks follow Spec reading column rules.
      - [ ] Playwright checks table borders, code outline/radius, and comment column width against tokens.
      - [ ] context-agent/wiki/code-map.md records the mapping module, code-point helpers, render function, anchor placement rule, and tests.
      - [ ] context-agent/wiki/design-system.md gains the stale/no-range group rule.
    - **Dependencies**: "Task: Replace the ready-spec placeholder in the Spec tab", "Task: Implement comment column layout and groups"

- [ ] **Story: Prove behavior with component and production-path tests**
  - [ ] **Task: Add component tests with scripted SDK client**
    - **Description**: Cover rendering, composing, request bodies, 422 recovery, marker states, selection pairing, stale/no-range groups, moved offsets, and read-only behavior away from the gate using a scripted SDK client.
    - **Acceptance criteria**:
      - [ ] Tests cover open and resolved marker states.
      - [ ] Tests cover stale: true from scripted feedback and moved offsets returned by listRunFeedback.
      - [ ] Tests cover keyboard selection opening the composer.
      - [ ] Tests cover submitting after the DOM selection has been cleared.
      - [ ] Tests cover composer closure and draft discard when the run leaves spec.human_review.
      - [ ] Tests cover read-only state outside spec.human_review.
      - [ ] Tests make no model calls and use no test-only production hooks.
    - **Dependencies**: "Task: Replace the ready-spec placeholder in the Spec tab"
  - [ ] **Task: Add fake-mode Playwright spec review test**
    - **Description**: Add a production-path Playwright test that starts fake mode on a free port with fresh state, seeds spec-review, builds/serves the client, opens the Spec tab, creates comments on the real fixture passages, verifies SDK-stored anchors, reloads, adds a no-anchor SDK comment, sends request_changes, and verifies moved/stale/addressed behavior.
    - **Acceptance criteria**:
      - [ ] Test sees rendered heading, table, bullet list, and highlighted code block from the scripted spec.
      - [ ] Test creates comments on passage A `A. Names must be unique within a tenant.`, passage B `B. Deletion cascades to every child record.`, table-cell passage `createdAt`, and code-line passage `const fixture = { name: "demo" };`.
      - [ ] Stored from, to, and quotedText match code points of getRunSpec markdown.
      - [ ] Passage A follows an astral emoji, and its stored `from` is exactly one lower than the UTF-16 index of the same passage.
      - [ ] Reload preserves all four anchored comments.
      - [ ] SDK-created no-anchor feedback appears in the no-range group with no marker.
      - [ ] request_changes revision moves A by the inserted source text before it, marks B stale, leaves `createdAt` and the code line anchored where they were, and shows addressed chips/resolved marker style.
      - [ ] The revised A case proves selection and marker mapping after the inserted list item creates a soft line break before A.
      - [ ] A cross-block comment proves card order and no overlap.
    - **Dependencies**: "Task: Add component tests with scripted SDK client", "Task: Apply design-system styling and docs updates", "Task: Update fake-mode emoji fixture for astral offset proof"
