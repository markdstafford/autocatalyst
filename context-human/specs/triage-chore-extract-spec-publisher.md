---
type: chore
issue: 50
status: draft
last_updated: 2026-04-19
---

# Extract SpecPublisher interface to src/types/publisher.ts

## Summary

`SpecPublisher` and `SpecEntryStatus` are generic, publisher-agnostic types currently defined inside `src/adapters/slack/canvas-publisher.ts`. This placement causes `NotionPublisher`, `NotionSpecCommitter`, `OrchestratorImpl`, and `src/index.ts` to import from a Slack adapter file to satisfy their types — a layering violation. The fix is to move both the interface and the `titleFromPath` utility to `src/types/publisher.ts` and update all five import sites.

## Background

`SpecPublisher` is the port interface that both `SlackCanvasPublisher` and `NotionPublisher` implement. It carries no Slack-specific semantics. The accidental placement in `canvas-publisher.ts` happened because `SlackCanvasPublisher` was the first implementation; when `NotionPublisher` was added it inherited the import dependency.

`titleFromPath` (a filename-to-title utility) lives in the same file and is already consumed by both publishers and by `OrchestratorImpl`, making it equally misplaced.

## Affected files

| File | Change |
|------|--------|
| `src/types/publisher.ts` | **New file** — receives `SpecEntryStatus`, `SpecPublisher`, `titleFromPath` |
| `src/adapters/slack/canvas-publisher.ts` | Remove the three exported symbols; import them from `../../types/publisher.js` |
| `src/adapters/notion/notion-publisher.ts` | Update import source from `../slack/canvas-publisher.js` → `../../types/publisher.js` |
| `src/adapters/notion/spec-committer.ts` | Update import source from `../slack/canvas-publisher.js` → `../../types/publisher.js` |
| `src/core/orchestrator.ts` | Update import source from `../adapters/slack/canvas-publisher.js` → `../types/publisher.js` |
| `src/index.ts` | Update import source from `./adapters/slack/canvas-publisher.js` → `./types/publisher.js` |

## Implementation tasks

- [x] Create `src/types/publisher.ts` exporting:
  - `SpecEntryStatus` (type union — `'Speccing' | 'Waiting on feedback' | 'Approved' | 'Complete' | 'Superseded'`)
  - `SpecPublisher` (interface with `create`, `update`, `getPageMarkdown`, optional `updateStatus`, optional `setIssueLink`)
  - `titleFromPath` (function — parses a spec file path into a display title)
- [x] In `src/adapters/slack/canvas-publisher.ts`: remove `SpecEntryStatus`, `SpecPublisher`, and `titleFromPath` from the module; add `import { titleFromPath } from '../../types/publisher.js'` so `SlackCanvasPublisher.create()` continues to call it
- [x] Update `src/adapters/notion/notion-publisher.ts` lines 9–10: change both imports to `../../types/publisher.js`
- [x] Update `src/adapters/notion/spec-committer.ts` line 7: change import to `../../types/publisher.js`
- [x] Update `src/core/orchestrator.ts` lines 8–9: change both imports to `../types/publisher.js`
- [x] Update `src/index.ts` line 17: change `SpecPublisher` import to `./types/publisher.js`
- [x] Run `tsc --noEmit` and confirm zero new type errors
- [x] Run the test suite and confirm it stays green

## Verification

- `grep -r "canvas-publisher" src/` after the change must return only `src/adapters/slack/canvas-publisher.ts` itself (i.e., no other file imports from it for types)
- `tsc --noEmit` exits 0
- Existing tests pass

## Notes

- No behaviour changes. This is a pure file reorganisation.
- No re-exports needed: all five import sites are updated directly, keeping the import graph clean.
- `SlackCanvasPublisher` still has its own `setIssueLink` stub (`undefined` / omitted); `NotionPublisher` provides the real implementation. The interface's optional `setIssueLink?` signature stays unchanged.
