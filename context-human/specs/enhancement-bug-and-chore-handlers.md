---
created: 2026-04-17
last_updated: 2026-04-17
status: approved
issue: 42
specced_by: markdstafford
implemented_by: null
superseded_by: null
---
# Enhancement: Bug and chore handlers

## Parent feature

`enhancement-intent-classifier-routing.md`
## What

The intent classifier routing enhancement classified `bug` as a recognized top-level intent but deferred its downstream handler to a follow-on issue, leaving a stub that posts "Bug triage is not yet implemented." This enhancement replaces that stub with a real triage pipeline and extends the same pipeline to support `chore` — a new intent type for maintenance requests. When a user reports a bug or requests a chore, the system generates a structured triage document, publishes it to Notion for review, and on approval writes the triage content to a GitHub issue — the issue is the authoritative repo artifact for bugs and chores, not a file committed to the repository.
## Why

Bug reports and chores need a first-class path from Slack to a tracked, reviewed, and implementable work item. The triage pipeline mirrors the spec pipeline in structure, making the incremental implementation cost low and the user experience consistent.
## User stories

- Phoebe can @mention the bot with a bug report and receive a structured triage document in Notion, linked in the thread
- Phoebe can @mention the bot to request a chore (e.g., "upgrade Node to v22" or "clean up the test helpers") and have it recognized as a chore and triaged
- Enzo can review and approve a bug or chore triage document just as he reviews a feature spec
- Enzo can provide feedback on a triage document and have the system revise it
- Enzo can approve a triage document and trigger implementation; on approval, the triage content is written to a GitHub issue
- Phoebe can start with a question that upgrades to a bug or chore report without starting over (dependent on #43 — see prerequisites)
## Technical changes

### Affected files

- `src/types/runs.ts` — add `chore` to `RequestIntent`
- `src/adapters/agent/intent-classifier.ts` — add `chore` to `Intent`, `ALL_INTENTS`, `VALID_INTENTS_BY_CONTEXT`, and `intentDescriptions` in the classifier prompt
- `src/adapters/agent/spec-generator.ts` — add optional `intent` parameter to `SpecGenerator.create()` and its implementation; update agent prompt to invoke `mm:issue-triage` with thorough investigation for `bug` and `chore` intents
- `src/core/orchestrator.ts` — replace bug stub with `_startTriagePipeline`; add `chore` routing to the same pipeline; update approval handler to fetch triage content from Notion, write it to a GitHub issue, and update Notion page properties for bug/chore runs; extend upgrade path to include `chore` (dependent on #43)
- `tests/adapters/agent/intent-classifier.test.ts` — add `chore` intent test cases
- `tests/core/orchestrator.test.ts` — add routing test cases for bug and chore intents, approval paths including Notion content source and page property updates, and error paths
### Changes

### 1. Introduction and overview

**Prerequisites and assumptions**
- Depends on `enhancement-intent-classifier-routing.md` (#43, status: closed) — the `bug` intent is already classified and emitted; `_handleRequest` with intent × stage routing is implemented; `RequestIntent` already includes `bug`. Note: #43 was marked `implementing` when this spec was drafted, likely because the bug handler had been deferred to this follow-on spec; #43 is now closed. If intake-stage thread_message routing was not completed before close, the upgrade-path tasks in this spec remain gated until that work is confirmed available.
- The `new_request` routing for `bug` intent currently posts a stub acknowledgment (orchestrator.ts lines 235–242); this enhancement replaces that stub
- No new ADRs required; no database schema changes
- The `SpecGenerator.create()` interface change is backwards-compatible: the new `intent` parameter is optional and defaults to existing `'idea'` behavior when omitted
**Technical goals**
- `chore` is a first-class intent: recognized by the classifier, stored on `Run.intent`, and handled by the orchestrator
- Bugs and chores both produce a Notion-published triage document and enter the `reviewing_spec` stage — identical lifecycle behavior to ideas up to approval; differentiated at approval by how the content is persisted — ideas commit an md file to the repo, bugs and chores write triage content to a GitHub issue (creating one if none exists)
- The spec generator produces a triage document appropriate to the intent type when `intent` is `bug` or `chore`, by invoking `mm:issue-triage` with thorough investigation; the micromanager skill determines the output format
- `_startTriagePipeline` shares the same orchestration pattern as `_startSpecPipeline` (workspace create → generate → publish → review) without duplicating error-handling logic
- On approval of a bug or chore run, the orchestrator fetches the triage document content from Notion, writes it to the associated GitHub issue (or creates a new issue if none exists), updates the Notion page with the issue URL and Approved status, and does not commit any md file to the repository
- All existing behavior for `idea`, `question`, `feedback`, `approval`, and `ignore` intents is unchanged
**Non-goals**
- Intent upgrade path for `intake`-stage thread messages (question → bug/chore in a follow-up reply) — dependent on #43 having implemented intake-stage thread_message routing; included as a gated task if that work was not completed before #43 closed
- Dedicated Notion databases or distinct page types for bugs and chores vs. ideas — all triage documents use the existing Notion publisher; differentiation is in document content, not page type or database
- Severity, priority, or assignment fields on triage documents beyond what the spec generator produces from the request content
- Emoji reaction approval for bugs or chores
**Glossary**
- **Triage document** — the Notion-published structured markdown produced by the spec generator for `bug` or `chore` intents; equivalent to a spec for `idea` intents, with format determined by the micromanager skill
- **Triage pipeline** — the orchestration sequence (workspace → generate → publish → review → write to issue on approval) shared by bugs and chores; structurally identical to the spec pipeline for ideas up to the approval step
### 2. System design and architecture

**Modified components**
- `src/types/runs.ts` — add `'chore'` to `RequestIntent`
- `src/adapters/agent/intent-classifier.ts` — add `'chore'` throughout: `Intent` type, `ALL_INTENTS`, `VALID_INTENTS_BY_CONTEXT` for `new_thread` and `intake`, and `intentDescriptions`; `CONSERVATIVE_FALLBACK` for `new_thread` and `intake` remains `'idea'`
- `src/adapters/agent/spec-generator.ts` — `SpecGenerator.create()` gains an optional fourth argument `intent?: 'idea' | 'bug' | 'chore'`; the agent prompt invokes `mm:issue-triage` with thorough investigation and defers output format to the micromanager skill based on intent
- `src/core/orchestrator.ts` — replace bug stub with `_startTriagePipeline(run, request, intent)`; add `chore` routing; update `_handleApproval` to fetch triage content from Notion, write to GitHub issue, and update Notion page properties for bug/chore runs; extend upgrade path (dependent on #43)
**Updated intent × stage routing table**
<table header-row="true">
<tr>
<td>Intent</td>
<td>Stage</td>
<td>Action</td>
</tr>
<tr>
<td>`idea`</td>
<td>`new_thread` / `intake`</td>
<td>`_startSpecPipeline`</td>
</tr>
<tr>
<td>`bug`</td>
<td>`new_thread` / `intake`</td>
<td>`_startTriagePipeline`</td>
</tr>
<tr>
<td>`chore`</td>
<td>`new_thread` / `intake`</td>
<td>`_startTriagePipeline`</td>
</tr>
<tr>
<td>`question`</td>
<td>`new_thread` / `intake`</td>
<td>answer, stay at `intake`</td>
</tr>
<tr>
<td>`feedback`</td>
<td>`reviewing_spec`</td>
<td>revise spec/triage doc</td>
</tr>
<tr>
<td>`feedback`</td>
<td>`reviewing_implementation` / `awaiting_impl_input`</td>
<td>handle impl feedback</td>
</tr>
<tr>
<td>`approval`</td>
<td>`reviewing_spec` (`idea`)</td>
<td>commit spec file, start implementation</td>
</tr>
<tr>
<td>`approval`</td>
<td>`reviewing_spec` (`bug` / `chore`)</td>
<td>fetch triage content from Notion, write to issue, update Notion page properties, start implementation</td>
</tr>
<tr>
<td>`approval`</td>
<td>`reviewing_implementation`</td>
<td>create PR</td>
</tr>
<tr>
<td>`question`</td>
<td>any other stage</td>
<td>answer, no stage change</td>
</tr>
<tr>
<td>`ignore`</td>
<td>any</td>
<td>discard</td>
</tr>
</table>
Feedback routing for bug and chore runs is identical to ideas because all pipelines land the run in `reviewing_spec`. Approval routing diverges: idea runs commit a spec file to the repository; bug and chore runs fetch triage content from Notion, write it to a GitHub issue, and update the Notion page properties.
### 3. Detailed design

**Updated types**
`src/types/runs.ts`:
```typescript
export type RequestIntent = 'idea' | 'bug' | 'chore' | 'question';
```
`src/adapters/agent/intent-classifier.ts`:
```typescript
export type Intent =
  | 'idea'
  | 'bug'
  | 'chore'
  | 'question'
  | 'feedback'
  | 'approval'
  | 'ignore';

const ALL_INTENTS: Intent[] = ['idea', 'bug', 'chore', 'question', 'feedback', 'approval', 'ignore'];

export const VALID_INTENTS_BY_CONTEXT: Partial<Record<ClassificationContext, Intent[]>> = {
  new_thread:               ['idea', 'bug', 'chore', 'question', 'ignore'],
  intake:                   ['idea', 'bug', 'chore', 'question', 'ignore'],
  reviewing_spec:           ['feedback', 'approval', 'question', 'ignore'],
  reviewing_implementation: ['feedback', 'approval', 'question', 'ignore'],
  awaiting_impl_input:      ['feedback', 'question', 'ignore'],
  speccing:                 ['feedback', 'question', 'ignore'],
  implementing:             ['feedback', 'question', 'ignore'],
  done:                     ['ignore'],
  failed:                   ['ignore'],
};
```
Updated `intentDescriptions` in the classifier prompt:
```typescript
const intentDescriptions: Record<Intent, string> = {
  idea:     'the human wants to build a new feature or improvement',
  bug:      'the human is reporting a bug or something broken',
  chore:    'the human is requesting maintenance work — a refactor, cleanup, dependency update, or other non-feature, non-bug task',
  question: 'the human is asking a question',
  feedback: 'the human is providing feedback, a revision request, or answering a question about the current work',
  approval: 'the human is approving the current work and wants to proceed',
  ignore:   'the message is not directed at the bot or has no actionable intent',
};
```
**Updated ****`SpecGenerator`**** interface**
```typescript
export interface SpecGenerator {
  create(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
    intent?: 'idea' | 'bug' | 'chore',
  ): Promise<string>;
  revise(
    feedback: ThreadMessage,
    notion_comments: NotionComment[],
    spec_path: string,
    workspace_path: string,
    current_page_markdown?: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<ReviseResult>; // unchanged
}
```
**Spec generator prompts**
When `intent === 'bug'`, the agent prompt invokes `mm:issue-triage` with thorough investigation to analyze the report; the micromanager skill determines the output format and structure. The prompt passed to `AgentSDKSpecGenerator` is:
```javascript
You are producing a bug triage document for the following report:

{request.message}

Invoke the `mm:issue-triage` skill to perform a thorough investigation of this bug.
Examine relevant source files, recent commits, and related issues to understand the
root cause before forming conclusions. The investigation must be thorough — do not
skip the codebase inspection step.
```
When `intent === 'chore'`, the agent prompt invokes `mm:issue-triage` to investigate the current state of the relevant code; the micromanager skill determines the output format. The prompt passed to `AgentSDKSpecGenerator` is:
```javascript
You are producing a chore specification for the following maintenance request:

{request.message}

Invoke the `mm:issue-triage` skill to investigate the current state of the relevant
code and understand why this work is needed now. Use thorough investigation.
```
> If `mm:issue-triage` cannot handle document-generation for either intent, file the issue against the micromanager skill rather than working around it here.
When `intent === 'idea'` or omitted, existing feature spec behavior is unchanged.
**`_startTriagePipeline`**** in orchestrator**
```typescript
private async _startTriagePipeline(run: Run, request: Request, intent: 'bug' | 'chore'): Promise<void> {
  this.transition(run, 'speccing');

  // Step 1: Create workspace
  let workspace_path: string;
  let branch: string;
  try {
    ({ workspace_path, branch } = await this.deps.workspaceManager.create(request.id, this.deps.repo_url));
    run.workspace_path = workspace_path;
    run.branch = branch;
  } catch (err) {
    await this.failRun(run, request.channel_id, request.thread_ts, err);
    return;
  }

  // Step 2: Generate triage document
  const onProgress = (message: string): Promise<void> =>
    this.deps.postMessage(request.channel_id, request.thread_ts, message).catch(err => {
      this.logger.warn(
        { event: 'progress_failed', phase: 'triage_generation', run_id: run.id, error: String(err) },
        'Failed to post progress update',
      );
    });

  let spec_path: string;
  try {
    spec_path = await this.deps.specGenerator.create(request, workspace_path, onProgress, intent);
    run.spec_path = spec_path;
  } catch (err) {
    await this.deps.workspaceManager.destroy(workspace_path);
    await this.failRun(run, request.channel_id, request.thread_ts, err);
    return;
  }

  // Step 3: Publish triage document
  let publisher_ref: string;
  try {
    publisher_ref = await this.deps.specPublisher.create(request.channel_id, request.thread_ts, spec_path);
    run.publisher_ref = publisher_ref;
  } catch (err) {
    await this.deps.workspaceManager.destroy(workspace_path);
    await this.failRun(run, request.channel_id, request.thread_ts, err);
    return;
  }

  this.transition(run, 'reviewing_spec');
  await this.deps.specPublisher.updateStatus?.(run.publisher_ref!, 'Waiting on feedback').catch(err =>
    this.logger.error(
      { event: 'run.status_update_failed', run_id: run.id, status: 'Waiting on feedback', error: String(err) },
      'Failed to update triage document status',
    ),
  );
}
```
**Updated routing in ****`_handleRequest`**
Replace the stub bug block (lines 235–242) and add `chore` alongside it:
```typescript
} else if (intent === 'bug') {
  run.intent = 'bug';
  this._persistRuns();
  await this._startTriagePipeline(run, request, 'bug');
} else if (intent === 'chore') {
  run.intent = 'chore';
  this._persistRuns();
  await this._startTriagePipeline(run, request, 'chore');
}
```
**Approval handler for bug and chore runs**
When the orchestrator handles approval of a `reviewing_spec`-stage run with `intent === 'bug'` or `intent === 'chore'`, it writes the triage document content to a GitHub issue instead of committing an md file to the repository:
1. Fetch the triage document content from Notion via `run.publisher_ref` — this is the canonical reviewed version, which may differ from the initial draft at `run.spec_path` if revisions were made in Notion
2. Write the content to the associated GitHub issue if `run.issue` is set, or create a new GitHub issue if it is not
3. Store the issue number on the run
4. Update the Notion page properties: record the linked GitHub issue URL and set the page status to Approved
5. Proceed with implementation (same as idea approval from this point)
No md file is committed to the repository for bug or chore runs.
**Upgrade path extension (dependent on #43)**
Once intake-stage thread_message routing from #43 is confirmed available, extend the upgrade path in `_handleRequest` to include `chore` alongside the existing `bug` upgrade:
- `run.intent === 'question'` + `run.stage === 'intake'` + classifier returns `'chore'` → set `run.intent = 'chore'`, log `run.intent_upgraded`, call `_startTriagePipeline(run, ..., 'chore')`
- `run.intent === 'question'` + `run.stage === 'intake'` + classifier returns `'bug'` → set `run.intent = 'bug'`, log `run.intent_upgraded`, call `_startTriagePipeline(run, ..., 'bug')`
Note: The second bullet replaces the partially-specified "ack + log" behavior from the parent spec — with the triage pipeline implemented, upgrades to `bug` should start the pipeline, not just acknowledge receipt.
### 4. Security, privacy, and compliance

**Authentication and authorization**
- No changes to the authentication model — same as parent spec; Bolt SDK verifies Slack signatures; the orchestrator trusts only events from the authenticated adapter
**Data privacy**
- Message content is passed to the spec generator for triage document creation — an extension of the existing pattern already used for `idea` intent
- Intent type (`bug` or `chore`) is logged alongside existing metadata; no additional PII is introduced
- Message content is not logged; only metadata (run_id, intent, request_id) appears in log events
**Input validation**
- Message content is treated as untrusted user input, same as for `idea` intent — passed as a typed field, never interpolated into system prompts without proper isolation
### 5. Observability

**Log events**
<table header-row="true">
<tr>
<td>Event</td>
<td>Level</td>
<td>Fields</td>
<td>Notes</td>
</tr>
<tr>
<td>`triage.started`</td>
<td>info</td>
<td>`run_id`, `request_id`, `intent`</td>
<td></td>
</tr>
<tr>
<td>`triage.complete`</td>
<td>info</td>
<td>`run_id`, `request_id`, `intent`, `publisher_ref`</td>
<td></td>
</tr>
<tr>
<td>`triage.approved`</td>
<td>info</td>
<td>`run_id`, `request_id`, `intent`, `issue_number`</td>
<td>Emitted after triage content written to issue and Notion page updated</td>
</tr>
<tr>
<td>`run.intent_upgraded`</td>
<td>info</td>
<td>`run_id`, `request_id`, `from_intent`, `to_intent`</td>
<td>*(existing event; extended to cover **`chore`** and corrected **`bug`** upgrade)*</td>
</tr>
</table>
**Metrics**
- `slack.messages.classified` — existing counter; `chore` is a new value for the `intent` label; no new metrics required
**Alerting**
- No new alerting thresholds; existing thresholds cover the triage pipeline since it reuses the same infrastructure
### 6. Testing plan

**`spec-generator.ts`**** — unit tests (delta)**
- When `intent === 'bug'`, the agent prompt includes the instruction to invoke `mm:issue-triage` with thorough investigation
- When `intent === 'chore'`, the agent prompt includes the instruction to invoke `mm:issue-triage`
- When `intent === 'idea'` or omitted, the existing feature spec prompt is unchanged; the `mm:issue-triage` instruction does not appear
**`intent-classifier.ts`**** — unit tests (delta)**
- `new_thread` context → valid intents include `'chore'`
- `intake` context → valid intents include `'chore'`
- `chore` returned for `reviewing_spec` context → conservative fallback (`'feedback'`) asserted
- Example message requesting maintenance work (e.g., "we should upgrade our Node version") → classified as `'chore'`
**`orchestrator.ts`**** — unit tests (delta)**
*New request routing:*
- `new_request` + classifier returns `'bug'` → `_startTriagePipeline` called with `'bug'`; `run.intent = 'bug'`; run transitions `intake → speccing → reviewing_spec`
- `new_request` + classifier returns `'chore'` → `_startTriagePipeline` called with `'chore'`; `run.intent = 'chore'`; run transitions `intake → speccing → reviewing_spec`
- Workspace created for bug run; `specGenerator.create()` called with `intent = 'bug'`; `specPublisher.create()` called
- Workspace created for chore run; `specGenerator.create()` called with `intent = 'chore'`; `specPublisher.create()` called
*Error paths:*
- Workspace creation failure for bug run → `failRun` called; run marked `failed`
- Spec generator failure for chore run → workspace destroyed; `failRun` called
- Publisher failure for bug run → workspace destroyed; `failRun` called
- Notion content fetch failure on approval of bug run → `failRun` called; run does not proceed to implementation
- GitHub issue write failure on approval of chore run → `failRun` called
*Approval paths:*
- `approval` + `reviewing_spec` + `run.intent = 'bug'` → triage content fetched from Notion via `run.publisher_ref` (not `run.spec_path`); written to issue; no spec file committed
- `approval` + `reviewing_spec` + `run.intent = 'bug'` → Notion page properties updated: issue URL set, page status set to Approved
- `approval` + `reviewing_spec` + `run.intent = 'chore'` → same triage content fetch from Notion; issue write; Notion page property update
- `approval` + `reviewing_spec` + `run.intent = 'bug'` + no existing issue → new issue created; issue number stored on run; Notion page updated with new issue URL
- Notion property update failure after successful issue write → error logged; run proceeds to implementation (property update failure is non-blocking)
- `approval` + `reviewing_spec` + `run.intent = 'idea'` → spec file committed; Notion page properties not updated (idea behavior unchanged)
*Existing routing unchanged:*
- Feedback routing for a run with `intent = 'bug'` or `intent = 'chore'` that is in `reviewing_spec` → routes to existing spec feedback handler unchanged
*Upgrade path (dependent on #43):*
- `thread_message` + `run.intent = 'question'` + `run.stage = 'intake'` + classifier returns `'chore'` → intent upgraded to `'chore'`, `run.intent_upgraded` logged, `_startTriagePipeline` called with `'chore'`
- `thread_message` + `run.intent = 'question'` + `run.stage = 'intake'` + classifier returns `'bug'` → intent upgraded to `'bug'`, `_startTriagePipeline` called (not stub ack)
### 7. Alternatives considered

**Separate ****`_startBugPipeline`**** and ****`_startChorePipeline`**** methods**
Rather than a shared `_startTriagePipeline(intent)`, create a dedicated method per intent. Rejected because the orchestration logic is identical for both — workspace create, generate, publish, review. The only difference is the `intent` value passed to the spec generator. A shared method keeps the error-handling path in one place and makes both intents easier to maintain in sync.
**New ****`triaging`**** run stage instead of reusing ****`speccing`**
A dedicated stage for triage would allow differentiated status tracking in Notion and the run store. Rejected because the semantic difference is small and adding a new stage has wide blast radius: routing tables, transition guards, run store serialization, and test fixtures all reference `RunStage`. The `speccing` stage is accurate — the system is generating a structured document for review — regardless of whether that document is a feature spec, bug triage, or chore spec.
**Make ****`intent`**** a required parameter on ****`SpecGenerator.create()`**
Making the parameter required ensures callers always pass it explicitly. Rejected because it would be a breaking change for `AgentSDKSpecGenerator` and all test doubles. An optional parameter defaulting to `'idea'` behavior preserves backwards compatibility and avoids requiring simultaneous changes across test infrastructure.
**Implement chore as ****`idea`**** with a label or tag, not a separate intent**
Chores could be handled as ideas with a `[chore]` prefix or metadata field rather than a distinct intent type. Rejected because intent-based routing is already the system's architecture — adding `chore` as a first-class intent is consistent with how `bug` was added and keeps the classifier the single decision point.
### 8. Risks

**Triage document quality depends on spec generator prompt and ****`mm:issue-triage`**** delegation**
The triage document sections for bugs and chores are only as good as the prompts and the `mm:issue-triage` skill invocation. If the skill does not produce appropriate output for document-generation use cases, the triage document will be unhelpful. Mitigation: validate output quality manually on representative bug and chore messages before merging; if `mm:issue-triage` is insufficient, file an improvement issue against the micromanager skill rather than working around it in this implementation.
**`ALL_INTENTS`**** array must stay in sync with ****`Intent`**** type**
`ALL_INTENTS` in `intent-classifier.ts` is used for intent parsing and must include `'chore'`. A type system change without updating `ALL_INTENTS` would cause the classifier to never return `'chore'`. Mitigation: the acceptance criteria for the type change task include a grep verification (`grep -r "ALL_INTENTS" src/`); TypeScript will catch type mismatches at other sites.
**Upgrade path is non-functional until #43 intake routing is confirmed**
The `chore` upgrade path cannot be exercised until intake-stage thread_message routing from #43 is confirmed operational. Mitigation: the upgrade path task is explicitly gated; tests for that path are added when the dependency is confirmed.
**Notion property update failure must not block implementation**
The Notion page property update (step 4 of the approval handler) is a best-effort operation. If it fails after the GitHub issue has been written, the run should proceed to implementation rather than failing. A failed update is logged as an error but is non-blocking. Mitigation: wrap the Notion update in a try/catch that logs and continues, matching the pattern used for `updateStatus` in the triage pipeline.
## Task list

- [ ] **Story: Add ****`chore`**** to the intent taxonomy**
	- [ ] **Task: Add ****`chore`**** to ****`RequestIntent`**
		- **Description**: In `src/types/runs.ts`, extend `RequestIntent` from `'idea' | 'bug' | 'question'` to `'idea' | 'bug' | 'chore' | 'question'`.
		- **Acceptance criteria**:
			- [ ] `RequestIntent` type is `'idea' | 'bug' | 'chore' | 'question'`
			- [ ] `tsc --noEmit` passes (downstream errors expected until `Intent` type is updated)
		- **Dependencies**: None
	- [ ] **Task: Add ****`chore`**** to ****`Intent`**** type and classifier**
		- **Description**: In `src/adapters/agent/intent-classifier.ts`: (1) add `'chore'` to the `Intent` union type; (2) add `'chore'` to `ALL_INTENTS`; (3) add `'chore'` to `VALID_INTENTS_BY_CONTEXT` for `new_thread` and `intake` contexts; (4) add `'chore'` to `intentDescriptions` with description `'the human is requesting maintenance work — a refactor, cleanup, dependency update, or other non-feature, non-bug task'`; (5) confirm `CONSERVATIVE_FALLBACK` for `new_thread` and `intake` remains `'idea'` (no change needed).
		- **Acceptance criteria**:
			- [ ] `Intent` type includes `'chore'`
			- [ ] `ALL_INTENTS` includes `'chore'`
			- [ ] `VALID_INTENTS_BY_CONTEXT.new_thread` includes `'chore'`
			- [ ] `VALID_INTENTS_BY_CONTEXT.intake` includes `'chore'`
			- [ ] `intentDescriptions` has an accurate description for `'chore'`
			- [ ] `CONSERVATIVE_FALLBACK` for `new_thread` and `intake` is still `'idea'`
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `chore` to `RequestIntent`
	- [ ] **Task: Update intent classifier tests for ****`chore`**
		- **Description**: In `tests/adapters/agent/intent-classifier.test.ts`, add cases: (1) `new_thread` context → valid intents include `'chore'`; (2) `intake` context → valid intents include `'chore'`; (3) a maintenance-work message example classifies as `'chore'`; (4) `'chore'` returned for `reviewing_spec` context → conservative fallback (`'feedback'`) asserted.
		- **Acceptance criteria**:
			- [ ] `new_thread` valid intents test includes `'chore'`
			- [ ] `intake` valid intents test includes `'chore'`
			- [ ] Maintenance work message example classifies as `'chore'`
			- [ ] Out-of-context `'chore'` → fallback asserted
			- [ ] All tests pass
		- **Dependencies**: Task: Add `chore` to `Intent` type and classifier
- [ ] **Story: Implement triage pipeline**
	- [ ] **Task: Update ****`SpecGenerator.create()`**** to support triage intent**
		- **Description**: In `src/adapters/agent/spec-generator.ts`, add an optional fourth parameter `intent?: 'idea' | 'bug' | 'chore'` to both the `SpecGenerator` interface and `AgentSDKSpecGenerator.create()`. When `intent === 'bug'`, use the bug triage prompt (see section 3 — invokes `mm:issue-triage` with thorough investigation; output format is determined by the micromanager skill). When `intent === 'chore'`, use the chore spec prompt (see section 3 — invokes `mm:issue-triage`; output format is determined by the micromanager skill). When `intent === 'idea'` or omitted, existing behavior is unchanged.
		- **Acceptance criteria**:
			- [ ] `SpecGenerator` interface `create()` has optional `intent` parameter
			- [ ] `AgentSDKSpecGenerator.create()` implementation updated accordingly
			- [ ] Bug agent prompt includes instruction to invoke `mm:issue-triage` with thorough investigation
			- [ ] Chore agent prompt includes instruction to invoke `mm:issue-triage`
			- [ ] Omitting `intent` or passing `'idea'` produces existing feature spec behavior unchanged
			- [ ] Manually verify `mm:issue-triage` produces appropriate output for a representative bug report; if insufficient, file against micromanager before merging
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `chore` to `RequestIntent`
	- [ ] **Task: Implement ****`_startTriagePipeline`**** in orchestrator**
		- **Description**: In `src/core/orchestrator.ts`, add a private method `_startTriagePipeline(run: Run, request: Request, intent: 'bug' | 'chore'): Promise<void>`. It mirrors `_startSpecPipeline` in structure: (1) `this.transition(run, 'speccing')`; (2) create workspace via `workspaceManager.create()`; (3) generate triage document via `this.deps.specGenerator.create(request, workspace_path, onProgress, intent)`; (4) publish via `specPublisher.create()`; (5) `this.transition(run, 'reviewing_spec')`; (6) update Notion status to `'Waiting on feedback'`. All error paths follow the same `failRun` + workspace destroy pattern as `_startSpecPipeline`.
		- **Acceptance criteria**:
			- [ ] `_startTriagePipeline` exists and is callable with `'bug'` and `'chore'`
			- [ ] On success: run transitions `intake → speccing → reviewing_spec`
			- [ ] On workspace creation failure: `failRun` called; run marked `failed`
			- [ ] On spec generator failure: workspace destroyed; `failRun` called
			- [ ] On publisher failure: workspace destroyed; `failRun` called
			- [ ] `specGenerator.create()` called with the correct `intent` argument
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Update `SpecGenerator.create()` to support triage intent
	- [ ] **Task: Wire ****`bug`**** and ****`chore`**** intents to ****`_startTriagePipeline`**
		- **Description**: In `src/core/orchestrator.ts`, `_handleRequest`: replace the stub bug handler (the block currently posting "Got it — bug report noted. Bug triage is not yet implemented.", lines 235–242) with `run.intent = 'bug'; this._persistRuns(); await this._startTriagePipeline(run, request, 'bug');`. Add a parallel `chore` branch: `run.intent = 'chore'; this._persistRuns(); await this._startTriagePipeline(run, request, 'chore');`.
		- **Acceptance criteria**:
			- [ ] `bug` intent routes to `_startTriagePipeline(run, request, 'bug')`
			- [ ] `chore` intent routes to `_startTriagePipeline(run, request, 'chore')`
			- [ ] Stub "Bug triage is not yet implemented." post is removed
			- [ ] `run.intent` is set before `_persistRuns()` in both branches
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Implement `_startTriagePipeline` in orchestrator, Task: Add `chore` to `Intent` type and classifier
	- [ ] **Task: Update approval handler for bug and chore runs**
		- **Description**: In `src/core/orchestrator.ts`, update the approval handler for `reviewing_spec`-stage runs: when `run.intent === 'bug'` or `run.intent === 'chore'`: (1) fetch triage content from Notion via `run.publisher_ref` (not `run.spec_path` — the Notion page is the canonical reviewed version); (2) write the content to the associated GitHub issue if `run.issue` is set, or create a new GitHub issue if none exists; (3) store the issue number on the run; (4) update the Notion page properties — set the linked GitHub issue URL and set page status to Approved (this step is non-blocking: log errors but do not fail the run); (5) proceed with implementation. When `run.intent === 'idea'`, existing behavior (commit spec file) is unchanged.
		- **Acceptance criteria**:
			- [ ] Approval of a bug run fetches triage content from Notion via `run.publisher_ref`, not from `run.spec_path`
			- [ ] Approval of a chore run fetches triage content from Notion via `run.publisher_ref`
			- [ ] Triage content written to the associated GitHub issue for both bug and chore runs
			- [ ] If no issue is associated with the run, a new GitHub issue is created and its number stored on the run
			- [ ] Notion page properties updated: issue URL recorded, page status set to Approved
			- [ ] Notion property update failure is logged as an error but does not fail the run
			- [ ] `triage.approved` log event emitted with `run_id`, `request_id`, `intent`, `issue_number`
			- [ ] No md file is committed to the repository for bug or chore runs
			- [ ] Approval of an idea run continues to commit the spec file (unchanged behavior)
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Wire `bug` and `chore` intents to `_startTriagePipeline`
	- [ ] **Task: Extend upgrade path for ****`bug`**** and ****`chore`**** (dependent on #43)**
		- **Description**: Once intake-stage thread_message routing from #43 is confirmed available, update the upgrade path in `_handleRequest`: when `run.intent === 'question'` and `run.stage === 'intake'` and classifier returns `'bug'` or `'chore'`, update `run.intent`, log `run.intent_upgraded`, and call `_startTriagePipeline` with the appropriate intent. Note: the `'bug'` upgrade previously called a stub ack — this task replaces that with the real pipeline call. This task MUST NOT be started until intake-stage routing is confirmed operational.
		- **Acceptance criteria**:
			- [ ] `run.intent = 'question'` + `stage = 'intake'` + classifier returns `'bug'` → intent upgraded, `_startTriagePipeline(run, ..., 'bug')` called, `run.intent_upgraded` logged
			- [ ] `run.intent = 'question'` + `stage = 'intake'` + classifier returns `'chore'` → intent upgraded, `_startTriagePipeline(run, ..., 'chore')` called, `run.intent_upgraded` logged
			- [ ] `tsc --noEmit` passes
			- [ ] All tests pass
		- **Dependencies**: Task: Wire `bug` and `chore` intents to `_startTriagePipeline`; intake-stage thread routing from `enhancement-intent-classifier-routing.md` (#43) confirmed available
- [ ] **Story: Test coverage**
	- [ ] **Task: Update orchestrator unit tests**
		- **Description**: In `tests/core/orchestrator.test.ts`, add cases covering: routing (bug and chore new_request → `_startTriagePipeline`, correct `run.intent` set, run reaches `reviewing_spec`); error paths (workspace failure, spec generator failure, publisher failure for each intent; Notion fetch failure on approval; GitHub issue write failure on approval); approval paths (triage content fetched from Notion via `publisher_ref` not `spec_path`; issue written; Notion page properties updated; no file committed; new issue created when none exists; Notion update failure is non-blocking); and existing behavior (feedback routing for bug/chore in `reviewing_spec` unchanged; idea approval unchanged).
		- **Acceptance criteria**:
			- [ ] Bug and chore routing test cases pass; `run.intent` and stage transitions asserted
			- [ ] Error path tests pass for workspace, generator, and publisher failures for both intents
			- [ ] Approval tests assert triage content fetched from Notion (mock `specPublisher.getContent` or equivalent), not read from `spec_path`
			- [ ] Approval tests assert Notion page properties updated on success
			- [ ] Approval tests assert Notion update failure is logged and run proceeds to implementation
			- [ ] Approval tests assert new GitHub issue created and stored when `run.issue` is unset
			- [ ] Existing `idea` feedback and approval tests unchanged and passing
			- [ ] All tests pass
		- **Dependencies**: Task: Wire `bug` and `chore` intents to `_startTriagePipeline`, Task: Update approval handler for bug and chore runs