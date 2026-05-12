---
created: 2026-05-11
last_updated: 2026-05-12
status: complete
issue: null
specced_by: autocatalyst
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Testing guide and implementation feedback loop quality

## Parent features

- `feature-approval-to-implementation.md` — creates the implementation loop, implementation result contract, and implementation review page.
- `enhancement-notion-database-publishing.md` — publishes testing guides as Notion database entries.
- `enhancement-agent-progress-updates.md` — forwards agent `[Relay]` progress updates to Slack during spec generation and initial implementation.
## What

Autocatalyst improves the implementation review experience in four related ways:
1. Testing guides become more useful and consistent. They show the workspace first, always show the branch second, summarize the code changes in 2-5 bullets, list what the reviewer should confirm in 2-5 bullets, and render concrete testing steps as Notion to-do items.
2. Implementation feedback items become a real closed loop. When the agent addresses feedback from the testing guide, Autocatalyst checks off the completed to-do items and adds a short resolution comment under each item.
3. Completed feedback items are never sent back to the implementer in later feedback rounds.
4. Implementation-feedback runs forward `[Relay]` progress updates to Slack, matching spec creation and initial implementation runs.
The result is that a reviewer can open the testing guide, find the correct workspace immediately, follow a concrete checklist, add feedback as to-do items, and see which feedback was addressed after each iteration.
## Why

The implementation review page is the main handoff from agent work to human testing. Today it often contains a broad summary, inconsistent instructions, and a Feedback section that accepts input but does not reliably close the loop. Reviewers lose time finding the workspace, translating prose into a local test plan, and deleting old feedback so the agent does not process it again.
This is especially painful across multiple feedback rounds. The human should not have to remember which items were already fixed or manually clean up the page after the agent completes a pass. Autocatalyst should keep the review artifact current: open items are actionable, completed items are checked off with context, and testing instructions reflect the latest implementation when the fix changes how the feature should be tested.
## Goals

- Put the workspace path at the top of every testing guide, before branch information or setup steps.
- Always show the branch immediately after the workspace for consistent reviewer orientation.
- Make the summary section useful without requiring the reviewer to read a test-pass narrative.
- Render concrete test steps as checkboxes that can be completed while testing.
- Preserve reviewer testing progress when new steps are added after a feedback pass.
- Provide a dedicated section for reviewer-added testing steps that the AI never overwrites.
- Preserve a simple Feedback section where humans add new to-do items.
- Pass only unresolved feedback items to the implementer.
- Let the implementer report exactly which feedback items were fixed.
- Check off fixed feedback items and add a resolution comment after implementation feedback is addressed.
- Forward progress updates during implementation-feedback work.
## Non-goals

- Building a dedicated web UI for implementation review.
- Polling the testing guide automatically without a Slack trigger. The reviewer still signals feedback processing from Slack.
- Automatically approving or merging a PR when all testing-guide checklist items are checked.
- Guaranteeing Notion comment resolution for unsupported API behavior. This enhancement uses to-do checked state and child blocks, not Notion comment resolution.
- Rewriting the spec review feedback loop, except where shared progress-update patterns are reused.
## User stories

- As Enzo, I can open a testing guide and immediately see which workspace directory to `cd` into.
- As Enzo, I can see the branch name immediately below the workspace path without searching for it.
- As Enzo, I can see a short list of what changed and a short list of what I should confirm before approving the implementation.
- As Enzo, I can follow testing instructions as a Notion checklist and check off steps as I complete them.
- As Enzo, I can add my own extra testing steps in the Additional steps section without them being overwritten when the AI updates Testing instructions.
- As Enzo, I can add implementation feedback as to-do items in the Feedback section and trigger a feedback pass from Slack.
- As Enzo, I can see completed feedback items checked off with a short comment explaining what changed.
- As Enzo, I can leave a second round of feedback without deleting completed items from the first round.
- As Enzo, my progress on testing instruction checkboxes is preserved when the AI appends new steps after a feedback pass.
- As Phoebe, I can see Slack progress updates while Autocatalyst is working through implementation feedback.
## Design changes

### Testing guide structure

A testing guide page body uses this structure:
```markdown
[Spec bookmark, when available]

## Workspace

Workspace: `/absolute/path/to/workspace`
Branch: `spec/abc123`

## Summary

### Changes

- Added direct model runner configuration for OpenAI-compatible providers.
- Wired provider selection into the runtime configuration loader.
- Added tests for provider validation and error handling.

### Confirm

- The configured provider is used for new implementation runs.
- Existing Anthropic-backed runs still work without config changes.
- Invalid provider config fails with a clear error.

## Testing instructions

- [ ] `cd /absolute/path/to/workspace`
- [ ] Run `npm install`.
- [ ] Run `npm test`.
- [ ] Update `autocatalyst.yaml` with an OpenAI-compatible provider config.
- [ ] Start Autocatalyst and trigger a small implementation run.
- [ ] Confirm the run completes and the provider-specific logs look correct.

## Additional steps

- [ ] Add any extra testing steps here.

## Feedback

- [ ] Add feedback here as to-do items.
```
Rules:
- `Workspace` is always the first content section after the spec bookmark.
- `Workspace` is required and uses `run.workspace_path`.
- `Branch` is always shown immediately after workspace using `run.branch`. It appears in this fixed position so every testing guide has a consistent, predictable layout.
- `Summary` contains two subsections: `Changes` and `Confirm`.
- `Changes` contains 2-5 bullets describing user-visible or reviewer-relevant changes.
- `Confirm` contains 2-5 bullets describing what the human should verify.
- `Summary` does not include the agent's test-pass narrative. Test pass details can appear in Slack progress or logs, not in the review summary.
- `Testing instructions` renders as Notion to-do blocks, not a paragraph blob. This section is AI-managed.
- Testing instructions should be concrete commands and manual checks, not generic advice like "test the feature".
- `Additional steps` is a reviewer-managed section for extra testing items the reviewer wants to track. The AI never reads from or writes to this section. It is created with a placeholder to-do item so the section is immediately usable in the Notion editor.
- `Feedback` remains a section of to-do blocks that reviewers can add to.
### Partially completed testing instruction checklists

When a feedback pass results in new testing steps (because the fix changes how the feature should be tested), `update()` **appends** new items to the end of the existing `Testing instructions` list rather than replacing the whole list. This preserves checked state for steps the reviewer has already completed.
Rules:
- `update()` never removes or unchecks existing `Testing instructions` to-dos.
- New `testing_steps` returned from a feedback implementation are appended at the end of the section.
- If the updated steps would duplicate a step already present (same text, case-insensitive), skip the duplicate.
- The `## Additional steps` section is never modified by `update()`.
### Feedback completion display

When implementation feedback is addressed, completed feedback items are checked and receive a child paragraph comment:
```markdown
- [x] Custom transformation step is swallowed on add.
  - ✓ Fixed by wiring custom step persistence through `WorkflowStepRepository`; added regression coverage in `workflow-steps.test.ts`.
```
The resolution comment should be 1-2 sentences, specific, and written for the reviewer. It should say what changed, not repeat that tests passed.
### Slack progress during implementation feedback

When a reviewer triggers an implementation-feedback pass, the Slack thread receives progress updates such as:
```plain text
Reviewing 2 unresolved feedback items from the testing guide
Addressing feedback item 1 of 2 — custom transformation persistence
Feedback fixes implemented — updating the testing guide
```
These messages use the existing `[Relay]` path. They are best-effort and must not fail the implementation-feedback run.
## Technical changes

### Affected files

- `src/types/ai.ts` — extend `ImplementationResult` with structured review-summary and resolved-feedback fields.
- `src/types/impl-feedback-page.ts` — extend `ImplementationReviewInput` and update `ImplementationReviewPublisher.update()` options where needed.
- `src/core/ai/agent-services.ts` — update the implementation prompt and feedback prompt contract.
- `src/core/handlers/implementation-start-handler.ts` — pass workspace and branch into testing guide creation.
- `src/core/handlers/implementation-feedback-handler.ts` — pass progress callback, serialize unresolved feedback with IDs, update testing guide instructions and resolved items.
- `src/adapters/notion/implementation-feedback-page.ts` — render the new page structure, read only actionable to-dos, check off resolved feedback items, and append resolution comments.
- `tests/core/ai/agent-services.test.ts` — cover prompt/result contract changes.
- `tests/core/handlers/implementation-start-handler.test.ts` — cover workspace-first testing guide input.
- `tests/core/handlers/implementation-feedback-handler.test.ts` — cover unresolved filtering, resolved item updates, and progress wiring.
- `tests/adapters/notion/implementation-feedback-page.test.ts` — cover Notion rendering, feedback reading, and feedback resolution updates.
- `tests/core/orchestrator.test.ts` — update integration-style assertions around implementation feedback and testing guide content.
### Result contract

Extend `ImplementationResult` so the implementer can return structured testing-guide content and feedback-resolution metadata:
```typescript
export interface ImplementationResult {
  status: 'complete' | 'needs_input' | 'failed';
  summary?: string;
  testing_instructions?: string;
  review_summary?: {
    changes: string[];
    confirm: string[];
  };
  testing_steps?: string[];
  resolved_feedback_items?: Array;
  question?: string;
  error?: string;
}
```
Compatibility rules:
- `summary` and `testing_instructions` remain supported during migration.
- `review_summary.changes` and `review_summary.confirm` are preferred for testing guide rendering.
- `testing_steps` is preferred for checklist rendering.
- If the implementer omits structured fields, Autocatalyst falls back to the legacy strings and logs `implementation.review_contract_legacy` at warn level.
- `resolved_feedback_items` is optional on initial implementation and expected on implementation-feedback runs that receive feedback item IDs.
### Implementation prompt changes

Update `buildImplementationPrompt()` in `src/core/ai/agent-services.ts` so the JSON shape requests structured output:
```json
{
  "status": "complete | needs_input | failed",
  "summary": "short fallback summary",
  "review_summary": {
    "changes": ["2-5 bullets describing what changed"],
    "confirm": ["2-5 bullets describing what the human should confirm"]
  },
  "testing_instructions": "legacy fallback instructions",
  "testing_steps": ["concrete checklist item", "concrete checklist item"],
  "resolved_feedback_items": [
    { "id": "feedback item id", "resolution_comment": "what was fixed" }
  ],
  "question": "only when needs_input",
  "error": "only when failed"
}
```
Prompt rules:
- On initial implementation, include `resolved_feedback_items: []`.
- On implementation-feedback runs, only include an item in `resolved_feedback_items` when the implementation addressed that specific feedback item.
- Use item IDs exactly as provided in the additional context.
- `review_summary.changes` and `review_summary.confirm` must each contain 2-5 bullets when `status === "complete"`.
- `testing_steps` must start with `cd ` when the workspace path is available to the agent, or the renderer will add it.
- Do not put the workspace in `summary`; workspace is rendered by the review page from trusted run state.
### Feedback context serialization

Change `ImplementationFeedbackHandler.additionalContext()` for `reviewing_implementation` so unresolved feedback is serialized with stable IDs. This follows the same pattern used in spec feedback processing, where each comment is tagged with its source ID so the agent can reference specific items in its response:
```plain text
Unresolved implementation feedback from the testing guide:

[FEEDBACK_ID: block-id-1]
Custom transformation step isn't working — gets swallowed on add.
Conversation:
- I tested with a custom transform and it disappears after save.

[FEEDBACK_ID: block-id-2]
The config example is missing the new provider field.
```
Rules:
- Include only `FeedbackItem` values where `resolved === false`.
- Include `conversation` child paragraphs under that item's ID when present.
- If there are no unresolved feedback items, use the Slack message content as the only additional context and log `implementation.feedback_empty` at info level.
- For `awaiting_impl_input`, keep the existing behavior: use the Slack message directly and do not read the testing guide.
### Progress callback for implementation feedback

`ImplementationFeedbackHandler.handle()` must construct the same `onProgress` callback pattern used by `ImplementationStartHandler`:
```typescript
const onProgress = (message: string): Promise =>
  this.deps.postMessage(feedback.conversation, message).catch(err => {
    this.deps.logger.warn(
      { event: 'progress_failed', phase: 'implementation_feedback', run_id: run.id, error: String(err) },
      'Failed to post progress update',
    );
  });
```
Then pass it to `implementer.implement(localPath, run.workspace_path, additionalContext.value, onProgress)` for all implementation-feedback calls. Callback failure is non-blocking.
### Testing guide creation and update

Extend `ImplementationReviewInput`:
```typescript
export interface ImplementationReviewInput {
  artifact_ref: string;
  artifact_url?: string;
  title: string;
  workspace_path: string;
  branch: string;
  summary: string;
  testing_instructions: string;
  review_summary?: {
    changes: string[];
    confirm: string[];
  };
  testing_steps?: string[];
}
```
`ImplementationStartHandler` passes `run.workspace_path` and `run.branch` when creating the testing guide. It also maps `result.review_summary` and `result.testing_steps` into `ImplementationReviewInput`.
`NotionImplementationFeedbackPage.create()` renders:
- bookmark block when `artifact_url` is present;
- `Workspace` heading;
- workspace paragraph with code-formatted workspace path;
- branch paragraph immediately after workspace;
- `Summary` heading;
- `Changes` and `Confirm` subheadings with bulleted lists;
- `Testing instructions` heading with Notion `to_do` blocks;
- `Additional steps` heading with a single placeholder to-do item (`Add any extra testing steps here.`);
- `Feedback` heading with no default feedback item, unless a placeholder is needed for Notion editor usability.
If only legacy strings are available, the renderer:
- wraps `summary` under `Changes` as a single bullet if no structured changes exist;
- adds `Confirm the implemented behavior matches the approved spec.` as the fallback confirm bullet;
- splits `testing_instructions` on newlines into checklist items;
- prepends `cd ` when no step starts with `cd ` and the workspace path is available.
`ImplementationFeedbackHandler` calls `implFeedbackPage.update()` with:
```typescript
{
  summary: result.summary,
  review_summary: result.review_summary,
  testing_instructions: result.testing_instructions,
  testing_steps: result.testing_steps,
  resolved_items: result.resolved_feedback_items ?? []
}
```
`NotionImplementationFeedbackPage.update()` updates sections independently:
- If `review_summary` is present, replace only the content under `## Summary`.
- If `testing_steps` is present, append new items to the end of `## Testing instructions`. Do not remove or uncheck existing items. Skip items whose text matches an existing step (case-insensitive).
- If `resolved_items` is present, check the matching to-do blocks and append resolution comments under them.
- Do not modify `## Additional steps` under any circumstances.
- Do not remove existing unresolved feedback to-dos.
- Do not alter already checked feedback items except to avoid duplicate resolution comments.
### Reading feedback

`NotionImplementationFeedbackPage.readFeedback()` must continue to return all feedback to-do items with `resolved` state, because the handler owns filtering. It must not return testing-instruction checklist items or additional-steps checklist items.
Implementation guidance:
- Read top-level page blocks in order.
- Treat `to_do` blocks after the `Feedback` heading as feedback items.
- Ignore `to_do` blocks under `Testing instructions`.
- Ignore `to_do` blocks under `Additional steps`.
- Preserve current child paragraph collection as `conversation`.
- Return `resolved: block.to_do.checked`.
This is important because the page now contains three separate to-do regions: AI-generated testing steps, reviewer-added testing steps, and actionable feedback.
### Observability

Add or update structured logs:

Event
Level
Component
Meaning

`implementation.review_contract_legacy`
warn
implementation-feedback/start handler
Result used legacy summary or testing instruction fields because structured fields were missing

`implementation.feedback_empty`
info
implementation-feedback handler
Feedback trigger found no unresolved Notion feedback items

`implementation.feedback_context_built`
debug
implementation-feedback handler
Unresolved feedback was serialized for the implementer; includes count only

`implementation.feedback_resolved`
info
implementation-feedback-page
Testing guide checked off resolved feedback items; includes resolved count

`implementation.testing_steps_appended`
debug
implementation-feedback-page
New testing steps appended to existing Testing instructions list; includes appended count and skipped-duplicate count

`progress_failed` with `phase: 'implementation_feedback'`
warn
implementation-feedback handler
Slack progress post failed but the run continued

Do not log feedback text, testing instructions, or resolution comments at info level or above.
## Acceptance criteria

- New testing guides show `Workspace` before `Summary`, `Testing instructions`, `Additional steps`, and `Feedback`.
- New testing guides include the workspace path from `run.workspace_path`.
- Branch always appears immediately after workspace.
- Summary renders `Changes` and `Confirm` subsections with 2-5 bullets each when structured output is available.
- Testing instructions render as Notion to-do blocks.
- An `Additional steps` section is created with a placeholder to-do item for reviewer use.
- Implementation-feedback context includes only unchecked feedback to-do items from the Feedback section.
- Checked feedback to-dos are excluded from later implementation-feedback prompts.
- Testing-instruction to-dos are never sent to the implementer as feedback.
- Additional-steps to-dos are never sent to the implementer as feedback.
- When the implementer returns `resolved_feedback_items`, matching feedback to-dos are checked and receive a resolution comment.
- Re-running an update with the same resolved item does not duplicate its resolution comment.
- When a feedback pass returns new `testing_steps`, those steps are appended to the existing Testing instructions list; existing checked items remain checked.
- Steps with text matching an already-present item are not duplicated.
- The `Additional steps` section is never modified by `update()`.
- Implementation-feedback runs pass an `onProgress` callback to the implementer.
- `[Relay]` messages emitted during implementation feedback are posted to Slack best-effort.
- Slack progress post failures do not fail the run.
- Legacy implementer results still create a usable testing guide.
## Test plan

### Unit tests — `NotionImplementationFeedbackPage`

- `create()` writes a `Workspace` heading before `Summary`.
- `create()` writes workspace path and branch in that order.
- `create()` renders `Changes` and `Confirm` as bulleted lists from `review_summary`.
- `create()` renders `testing_steps` as Notion `to_do` blocks.
- `create()` renders an `Additional steps` heading with a placeholder to-do item.
- `create()` falls back from legacy `summary` and `testing_instructions` when structured fields are missing.
- `readFeedback()` ignores testing-instruction to-do blocks.
- `readFeedback()` ignores additional-steps to-do blocks.
- `readFeedback()` returns unchecked to-dos from the Feedback section with `resolved: false`.
- `readFeedback()` returns checked to-dos from the Feedback section with `resolved: true`.
- `readFeedback()` preserves child paragraph conversation lines.
- `update()` checks matching feedback to-dos and appends one resolution child paragraph.
- `update()` does not duplicate a resolution child paragraph when called twice.
- `update()` replaces Summary content without removing Feedback items.
- `update()` appends new testing steps to Testing instructions without removing or unchecking existing items.
- `update()` does not append a testing step whose text matches an existing step.
- `update()` does not touch the Additional steps section.
### Unit tests — `ImplementationFeedbackHandler`

- Serializes unresolved feedback with `[FEEDBACK_ID: ...]` markers.
- Filters out resolved feedback items before calling `implementer.implement()`.
- Uses Slack message content when no unresolved feedback exists.
- Does not call `readFeedback()` for `awaiting_impl_input`.
- Passes `onProgress` to `implementer.implement()` during implementation feedback.
- `onProgress` posts to Slack with the original conversation ref.
- `postMessage` rejection inside `onProgress` logs `progress_failed` and does not fail the run.
- Calls `implFeedbackPage.update()` with `resolved_items` from the implementation result.
- Calls `implFeedbackPage.update()` with updated structured summary and testing steps when present.
### Unit tests — `ImplementationStartHandler`

- Passes `workspace_path` and `branch` to `implFeedbackPage.create()`.
- Maps `review_summary` and `testing_steps` from the implementation result into `ImplementationReviewInput`.
- Falls back to legacy fields when structured fields are omitted.
### Unit tests — `agent-services`

- Initial implementation prompt requests `review_summary`, `testing_steps`, and `resolved_feedback_items`.
- Feedback implementation prompt instructs the agent to preserve feedback IDs exactly.
- Result parsing accepts structured fields.
- Result parsing rejects invalid `resolved_feedback_items` entries with missing `id` or `resolution_comment`.
- Result parsing tolerates omitted structured fields for backward compatibility.
### Integration-style tests — orchestrator

- First implementation creates a testing guide with workspace-first content, branch after workspace, and an Additional steps section.
- Implementation feedback with one unchecked item sends that item to the implementer, updates the page with a checked to-do, and transitions back to `reviewing_implementation`.
- Second implementation feedback after the item is checked does not resend it to the implementer.
- A feedback pass that returns new `testing_steps` appends them to the existing list; previously checked steps remain checked.
- Implementation-feedback `[Relay]` messages are forwarded to Slack.
### Manual test

1. Seed and approve a small feature.
2. Open the generated testing guide.
3. Confirm the first section is `Workspace` and the path points to the run workspace.
4. Confirm the branch name appears immediately below the workspace path.
5. Confirm Summary has `Changes` and `Confirm` bullets.
6. Confirm Testing instructions are checkboxes.
7. Confirm an `Additional steps` section exists with a placeholder item.
8. Check off the first two Testing instructions items.
9. Add two Feedback to-do items.
10. Trigger implementation feedback from Slack.
11. Confirm Slack receives at least one progress update while feedback is being processed.
12. Confirm addressed feedback items are checked with resolution comments.
13. Confirm the first two Testing instructions remain checked.
14. If new testing steps were added, confirm they appear at the end of the Testing instructions list.
15. Add an item to Additional steps; trigger another feedback pass and confirm the Additional steps section is unchanged after the pass.
16. Add a second Feedback item and trigger another pass; confirm previously checked items are not sent to the implementer again.
## Rollout

- This is backward-compatible with existing implementation agents because legacy `summary` and `testing_instructions` remain accepted.
- Existing testing guide pages keep their current shape. The new renderer applies to newly created testing guides and to pages updated after feedback where the expected headings can be found.
- If an older testing guide does not contain the expected headings, `update()` should still resolve feedback to-dos by block ID and log a warning before skipping summary/testing-instruction replacement.
- `branch` is now a required field in `ImplementationReviewInput`. Call sites that previously omitted it must be updated to pass `run.branch`.
## Risks and mitigations

- **Notion markdown replacement could disturb manually edited content.** Limit replacement to known sections and preserve the Feedback and Additional steps sections. Add tests around section boundaries.
- **The implementer may omit ****`resolved_feedback_items`****.** The page will remain unchecked, but unresolved filtering still prevents checked items from being resent. Prompt strongly instructs the agent to return resolved IDs.
- **The implementer may return an unknown feedback ID.** Ignore unknown IDs and log a warning with the ID and run ID, without failing the run.
- **Testing-guide pages now contain three to-do sections.** `readFeedback()` must scope itself to the Feedback section so testing checklist items and additional steps are not treated as feedback.
- **Appended testing steps may duplicate existing steps.** Use case-insensitive text comparison to skip duplicates before appending.
- **Notion child-block APIs may not allow appending under a to-do block in some workspaces.** If appending a resolution comment fails, still check the item when possible and log a warning. If checking also fails, leave the item unchanged and surface the degraded state in logs.
## Task list

- [ ] **Story: Structured implementation review result**
	- [ ] **Task: Extend ****`ImplementationResult`**
		- **Description**: Add `review_summary`, `testing_steps`, and `resolved_feedback_items` to `src/types/ai.ts`. Keep legacy fields optional and supported.
		- **Acceptance criteria**: Types compile; legacy call sites still compile; invalid resolved item shapes are rejected by result parsing tests.
		- **Dependencies**: None.
	- [ ] **Task: Update implementation prompts and result parsing**
		- **Description**: Update `buildImplementationPrompt()` and implementation-result parsing to request and validate the structured fields. Include explicit instructions for returning feedback IDs on feedback runs.
		- **Acceptance criteria**: Prompt tests cover new fields; parser accepts valid structured output; parser tolerates legacy output; parser rejects malformed resolved items.
		- **Dependencies**: Extend `ImplementationResult`.
- [ ] **Story: Workspace-first testing guide rendering**
	- [ ] **Task: Extend testing guide input**
		- **Description**: Make `branch` a required field in `ImplementationReviewInput` and add optional `review_summary` and `testing_steps`. Update `ImplementationStartHandler` to always pass `run.branch`.
		- **Acceptance criteria**: `ImplementationStartHandler` passes run workspace and branch; tests assert input shape; TypeScript compile passes.
		- **Dependencies**: Structured implementation review result.
	- [ ] **Task: Render new Notion testing guide structure**
		- **Description**: Update `NotionImplementationFeedbackPage.create()` to render bookmark, Workspace, Summary with Changes/Confirm, Testing instructions as to-dos, Additional steps with placeholder, and Feedback.
		- **Acceptance criteria**: Unit tests assert heading order, workspace/branch order, bullet rendering, checkbox rendering, Additional steps section creation, and legacy fallback.
		- **Dependencies**: Extend testing guide input.
- [ ] **Story: Feedback item closed loop**
	- [ ] **Task: Scope feedback reading to the Feedback section**
		- **Description**: Update `readFeedback()` to ignore Testing instructions to-dos and Additional steps to-dos, returning only Feedback-section to-dos with checked state and child conversation text.
		- **Acceptance criteria**: Tests prove testing checklist items and additional steps items are ignored and feedback to-dos are returned with correct `resolved` values.
		- **Dependencies**: Render new Notion testing guide structure.
	- [ ] **Task: Serialize unresolved feedback with IDs**
		- **Description**: Update `ImplementationFeedbackHandler.additionalContext()` to include only unresolved feedback items with `[FEEDBACK_ID: ...]` markers, following the same ID-tagged serialization pattern used in spec feedback processing.
		- **Acceptance criteria**: Implementer receives only unchecked feedback; checked items are omitted; no unresolved items falls back to Slack message content.
		- **Dependencies**: Scope feedback reading.
	- [ ] **Task: Check off resolved feedback items**
		- **Description**: Update `ImplementationFeedbackHandler` to pass `resolved_feedback_items` to `implFeedbackPage.update()`. Update Notion page update logic to check matching to-dos and append resolution comments.
		- **Acceptance criteria**: Matching to-dos become checked; resolution comment is appended once; unknown IDs are ignored with a warning; update failures are degraded and do not fail completed implementations.
		- **Dependencies**: Serialize unresolved feedback with IDs.
	- [ ] **Task: Update summary and testing instructions after feedback**
		- **Description**: When feedback implementation returns updated structured summary or new testing steps, replace Summary content and append new testing steps to the existing checklist without touching Additional steps or unresolved feedback.
		- **Acceptance criteria**: Tests show Summary updates; new testing steps are appended; existing checked testing steps remain checked; Additional steps and Feedback to-dos remain intact.
		- **Dependencies**: Check off resolved feedback items.
- [ ] **Story: Progress updates during implementation feedback**
	- [ ] **Task: Wire ****`onProgress`**** in ****`ImplementationFeedbackHandler`**
		- **Description**: Construct an `onProgress` callback using `postMessage`, log `progress_failed` with `phase: 'implementation_feedback'` on failure, and pass it to every feedback-run `implementer.implement()` call.
		- **Acceptance criteria**: Tests capture the callback, verify Slack posting, and verify post failure does not fail the run.
		- **Dependencies**: None.
	- [ ] **Task: Add implementation-feedback relay prompt examples**
		- **Description**: Ensure the feedback implementation prompt includes examples that fit feedback iteration, such as reading unresolved items, fixing item N of M, and updating the testing guide.
		- **Acceptance criteria**: Prompt tests include implementation-feedback examples; existing initial implementation progress behavior remains unchanged.
		- **Dependencies**: Wire `onProgress` in `ImplementationFeedbackHandler`.
- [ ] **Story: Validation and regression coverage**
	- [ ] **Task: Add handler and orchestrator regression tests**
		- **Description**: Cover first implementation guide creation, first feedback round resolution, second feedback round filtering, testing-step append behavior, and progress forwarding.
		- **Acceptance criteria**: Tests fail on current behavior and pass after implementation.
		- **Dependencies**: Previous stories.
	- [ ] **Task: Run full project validation**
		- **Description**: Run typecheck and the full Vitest suite.
		- **Acceptance criteria**: `npm test` and any configured typecheck pass; skipped checks are documented with reason.
		- **Dependencies**: All implementation tasks.