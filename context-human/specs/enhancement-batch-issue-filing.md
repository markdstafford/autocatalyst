---
created: 2026-04-19
last_updated: 2026-04-19
status: approved
issue: 62
specced_by: markdstafford
implemented_by: null
superseded_by: null
---
# Enhancement: Issue filing

## Parent feature

`enhancement-bug-and-chore-handlers.md`
## What

This is autocatalyst's first issue filing capability. When a user sends a message requesting that one or more items be filed as GitHub issues, the system classifies the message as `file_issues` intent and routes it to a new filing pipeline. The pipeline runs a two-phase filing process: first, an agent session invokes `mm:issue-triage` in feedback intake mode to investigate each item against the codebase, tease apart distinct issues, generate a rich title and body, suggest labels, and detect duplicates — writing an enrichment result file. Second, `AgentSDKIssueFiler` reads the enrichment result and calls `IssueManager.create()` for each non-duplicate item, using the same issue-creation path as the bug and chore pipelines. If a duplicate is detected for any item, the enrichment agent leaves a comment on the existing issue; the existing issue number is returned in the result rather than creating a new one. Once all items are processed, the bot replies with a summary listing newly filed and surfaced duplicate issue numbers and titles. Unlike the bug and chore pipelines, this path bypasses the Notion review cycle and files directly.
## Why

Autocatalyst currently has no issue filing capability. The existing `bug` and `chore` pipelines are designed for open-ended investigation: the user describes a symptom, the system generates a triage document, and the user reviews before any GitHub issue is created. That model is right for unknown problems where AI-guided analysis adds value. But users who already know what they want filed — whether a single well-understood issue or a list of items from a product review session, sprint retrospective, or friction log — have no path to GitHub at all. This enhancement adds that path: a filing pipeline that takes one or more items, enriches and files them directly as GitHub issues, deduplicates against existing open issues, and returns a summary without a review cycle.
## User stories

- Phoebe can send a list of product observations to the bot and receive a summary of filed GitHub issues in response
- Enzo can submit a batch of technical items (bugs, enhancements, chores) and have them all investigated and tracked in one shot
- Dani can paste in a session of UX notes and have each distinct issue filed as a labeled, enriched GitHub issue with suggested approach
- Fabio can request that a single item be filed as a GitHub issue and it goes through the same filing pipeline as a batch
- When Mira submits an item that duplicates an existing open issue, the bot returns the existing issue number rather than creating a duplicate, and leaves a comment on the existing issue
## Design changes

*(No UI — backend only. This enhancement adds no design surface.)*
## Technical changes

### Affected files

- `src/types/runs.ts` — add `'file_issues'` to `RequestIntent`
- `src/adapters/agent/intent-classifier.ts` — add `'file_issues'` to `Intent`, `ALL_INTENTS`, `VALID_INTENTS_BY_CONTEXT` for `new_thread` and `intake`, and `intentDescriptions`
- `src/adapters/agent/issue-filer.ts` (new) — `IssueFiler` interface, `FilingResult`, `FiledIssue`, `EnrichmentResult`, `EnrichmentItem` types, and `AgentSDKIssueFiler` implementation; `AgentSDKIssueFiler` takes `IssueManager` via constructor injection and calls `IssueManager.create()` for the actual GitHub issue creation step
- `src/core/orchestrator.ts` — add `issueFiler?: IssueFiler` to `OrchestratorDeps`; add `_startFilingPipeline` method; wire `file_issues` intent routing in `_handleRequest`
- `src/index.ts` — instantiate `AgentSDKIssueFiler` (passing the existing `GHIssueManager` instance) and pass it to orchestrator deps
- `tests/adapters/agent/issue-filer.test.ts` (new) — unit tests for `AgentSDKIssueFiler`
- `tests/core/orchestrator.test.ts` — add routing and pipeline tests for `file_issues`
### Changes

### 1. Introduction and overview

**Prerequisites and assumptions**
- Depends on `enhancement-bug-and-chore-handlers.md` (#42, status: approved) — the `IssueManager` interface, `GHIssueManager` implementation, and the orchestrator's issue-filing pattern were introduced there; this enhancement reuses `IssueManager.create()` for the actual GitHub issue creation step, ensuring a consistent creation path across all pipelines and avoiding a separate code path that could reintroduce duplicate-creation bugs
- Depends on `enhancement-intent-classifier-routing.md` (#43, status: closed) — the intent × stage routing in `_handleRequest` and `_classify` is in place; `file_issues` is a new intent added to that routing table
- No new ADRs required; no database schema changes; no Notion integration changes
- The `IssueFiler` interface is net-new; it does not extend or modify `SpecGenerator`, `IssueManager`, or `Implementer`; `AgentSDKIssueFiler` takes `IssueManager` as a constructor parameter and delegates GitHub issue creation to it
**Technical goals**
- `file_issues` is a first-class intent: recognized by the classifier, stored on `Run.intent`, and handled by the orchestrator
- The filing pipeline creates a workspace, runs the two-phase filing agent, posts a summary to Slack, destroys the workspace, and transitions the run to `done` — no Notion publishing, no `reviewing_spec` stage, no implementation
- The enrichment phase invokes `mm:issue-triage` in feedback intake mode to investigate each item against the codebase, generate a rich title/body/labels, and detect duplicates; for duplicates, the enrichment agent leaves a comment on the existing issue; the enrichment result is written to `/.autocatalyst/enrichment-result.json`
- The creation phase reads the enrichment result and calls `IssueManager.create()` for each non-duplicate item — the same code path used by the bug and chore pipelines; the `FilingResult` is built in memory from the created issue numbers and detected duplicate numbers
- Progress updates from the enrichment agent are forwarded to the Slack thread via `onProgress`, matching the pattern used by the spec generator and implementer
- Workspace is destroyed after successful filing (unlike the spec and triage pipelines, which retain the workspace for implementation)
**Non-goals**
- Review cycle for filings: the filing pipeline does not go through Notion review; the user's explicit "file this/these" instruction is the approval signal
- Investigation pipeline: a user reporting an unknown bug or chore symptom without explicitly requesting filing continues to go through the existing `bug`/`chore` pipelines with their Notion review cycle
- Associating filed issues with a run for future implementation by Autocatalyst; once filed, the issues are tracked in GitHub, not in the run store
**Glossary**
- **Filing pipeline** — the orchestration sequence (workspace create → acknowledge → enrich → create issues → summarize → destroy workspace → done) for `file_issues` intent; structurally simpler than the spec or triage pipelines
- **Filing agent** — the `AgentSDKIssueFiler` instance; it coordinates the enrichment phase (agent SDK session running `mm:issue-triage`) and the creation phase (`IssueManager.create()` calls), and returns a `FilingResult` to the orchestrator
- **Enrichment phase** — the agent SDK session that runs `mm:issue-triage` in feedback intake mode; investigates the codebase, generates title/body/labels per item, detects duplicates, and leaves comments on existing issues for duplicates; writes an enrichment result file
- **Creation phase** — the programmatic loop in `AgentSDKIssueFiler.file()` that reads the enrichment result and calls `IssueManager.create(title, body, labels)` for each non-duplicate item; builds `FilingResult` in memory
- **Enrichment result** — the JSON file written by the enrichment agent at `/.autocatalyst/enrichment-result.json`; contains proposed issue data and duplicate detection results per item; consumed by the creation phase
- **Filing result** — the `FilingResult` object returned by `AgentSDKIssueFiler.file()` to the orchestrator; includes both newly filed issues (with numbers assigned by GitHub) and existing issues surfaced by deduplication; built in memory during the creation phase, not written to disk by the agent
### 2. System design and architecture

**Modified and new components**
- `src/types/runs.ts` — `RequestIntent` gains `'file_issues'`
- `src/adapters/agent/intent-classifier.ts` — `Intent` type, `ALL_INTENTS`, `VALID_INTENTS_BY_CONTEXT`, and `intentDescriptions` gain `'file_issues'`
- `src/adapters/agent/issue-filer.ts` (new) — `EnrichmentItem`, `EnrichmentResult` (internal types), `FiledIssue`, `FilingResult`, `IssueFiler` interface, and `AgentSDKIssueFiler`; constructor takes `IssueManager`
- `src/core/orchestrator.ts` — `OrchestratorDeps` gains `issueFiler?`; `_startFilingPipeline` added; `_handleRequest` wired for `file_issues`
- `src/index.ts` — `AgentSDKIssueFiler` instantiated with the existing `GHIssueManager` and passed to orchestrator
**Updated intent × stage routing table**

Intent
Stage
Action

`idea`
`new_thread` / `intake`
`_startSpecPipeline`

`bug`
`new_thread` / `intake`
`_startTriagePipeline`

`chore`
`new_thread` / `intake`
`_startTriagePipeline`

`file_issues`
`new_thread` / `intake`
`_startFilingPipeline`

`question`
`new_thread` / `intake`
answer, stay at `intake`

`feedback`
`reviewing_spec`
revise spec/triage doc

`feedback`
`reviewing_implementation` / `awaiting_impl_input`
handle impl feedback

`approval`
`reviewing_spec` (`idea`)
commit spec file, start implementation

`approval`
`reviewing_spec` (`bug` / `chore`)
fetch triage content, write to issue, start implementation

`approval`
`reviewing_implementation`
create PR

`question`
any other stage
answer, no stage change

`ignore`
any
discard

**Run lifecycle for ****`file_issues`**
```javascript
new_request
  → _handleRequest
    → intent = 'file_issues'
      → _startFilingPipeline
        → transition: intake → speccing
        → workspaceManager.create()
        → postMessage (acknowledgment)
        → issueFiler.file()
            → [enrichment phase] agent runs mm:issue-triage feedback intake mode
              → investigates codebase per item, generates title/body/labels, detects duplicates
              → for duplicates: leaves comment on existing issue
              → writes enrichment-result.json
            → [creation phase] for each non-duplicate: IssueManager.create(title, body, labels)
            → builds FilingResult in memory (filed_issues with GitHub-assigned numbers)
            → returns FilingResult
        → emits filing.issue_filed / filing.duplicate_detected per item
        → workspaceManager.destroy()
        → transition: speccing → done
        → postMessage (result.summary)
```
No `reviewing_spec`, `implementing`, `reviewing_implementation`, or `awaiting_impl_input` stages are entered.
### 3. Detailed design

**Updated types**
`src/types/runs.ts`:
```typescript
export type RequestIntent = 'idea' | 'bug' | 'chore' | 'file_issues' | 'question';
```
`src/adapters/agent/intent-classifier.ts`:
```typescript
export type Intent =
  | 'idea'
  | 'bug'
  | 'chore'
  | 'file_issues'
  | 'question'
  | 'feedback'
  | 'approval'
  | 'ignore';

const ALL_INTENTS: Intent[] = ['idea', 'bug', 'chore', 'file_issues', 'question', 'feedback', 'approval', 'ignore'];

export const VALID_INTENTS_BY_CONTEXT: Partial> = {
  new_thread:               ['idea', 'bug', 'chore', 'file_issues', 'question', 'ignore'],
  intake:                   ['idea', 'bug', 'chore', 'file_issues', 'question', 'ignore'],
  reviewing_spec:           ['feedback', 'approval', 'question', 'ignore'],
  reviewing_implementation: ['feedback', 'approval', 'question', 'ignore'],
  awaiting_impl_input:      ['feedback', 'question', 'ignore'],
  speccing:                 ['feedback', 'question', 'ignore'],
  implementing:             ['feedback', 'question', 'ignore'],
  done:                     ['ignore'],
  failed:                   ['ignore'],
};
```
Updated `intentDescriptions` in the classifier prompt (delta — add one entry):
```typescript
file_issues: 'the human is explicitly requesting that one or more items be filed as GitHub issues',
```
`CONSERVATIVE_FALLBACK` for `new_thread` and `intake` remains `'idea'` — no change.
**Internal ****`EnrichmentItem`**** and ****`EnrichmentResult`**** types**
These types represent the agent-written file, validated before the creation phase runs. They are not exported from `issue-filer.ts`.
```typescript
interface EnrichmentItem {
  proposed_title: string;        // non-null when duplicate_of is null
  proposed_body: string;         // non-null when duplicate_of is null
  proposed_labels: string[];     // non-null when duplicate_of is null
  duplicate_of: { number: number; title: string } | null;
}

interface EnrichmentResult {
  status: 'complete' | 'failed';
  items: EnrichmentItem[];
  error?: string;
}
```
Validation rules on read: `status` must be `'complete'` or `'failed'`; `items` must be an array; for each item, `duplicate_of` must be `null` or an object with `number` (number) and `title` (string); if `duplicate_of` is null, `proposed_title` and `proposed_body` must be non-empty strings and `proposed_labels` must be an array of strings.
**`IssueFiler`**** interface and exported types**
`src/adapters/agent/issue-filer.ts`:
```typescript
export interface FiledIssue {
  number: number;
  title: string;
  action: 'filed' | 'duplicate'; // 'filed' = new issue created via IssueManager; 'duplicate' = existing issue, commented on by enrichment agent
}

export interface FilingResult {
  status: 'complete' | 'failed';
  summary: string;          // human-readable message for Slack; built in code from filed_issues
  filed_issues: FiledIssue[];
  error?: string;
}

export interface IssueFiler {
  file(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise,
  ): Promise;
}
```
**`AgentSDKIssueFiler`**** implementation**
`AgentSDKIssueFiler` takes `IssueManager` via constructor injection and separates enrichment from creation:
```typescript
export class AgentSDKIssueFiler implements IssueFiler {
  constructor(private readonly issueManager: IssueManager) {}

  async file(request: Request, workspace_path: string, onProgress?: ...): Promise {
    const enrichmentFilePath = join(workspace_path, '.autocatalyst', 'enrichment-result.json');
    const prompt = buildEnrichmentPrompt(request, enrichmentFilePath);

    // Phase 1: enrichment — agent investigates codebase, generates title/body/labels, detects duplicates
    // invoke agent SDK via query(); forward [Relay] messages to onProgress

    // Phase 2: creation — read and validate enrichment-result.json, call IssueManager.create() per non-duplicate
    const enrichmentResult = readAndValidateEnrichmentResult(enrichmentFilePath);
    const filed_issues: FiledIssue[] = [];

    for (const item of enrichmentResult.items) {
      if (item.duplicate_of) {
        filed_issues.push({ number: item.duplicate_of.number, title: item.duplicate_of.title, action: 'duplicate' });
      } else {
        const created = await this.issueManager.create(item.proposed_title, item.proposed_body, item.proposed_labels);
        filed_issues.push({ number: created.number, title: item.proposed_title, action: 'filed' });
      }
    }

    // Build summary deterministically from filed_issues
    const summary = buildSummary(filed_issues);
    return { status: 'complete', summary, filed_issues };
  }
}
```
The `buildSummary` function constructs the Slack message from `filed_issues`:
- New issues: `"Filed N new issue(s): #123 Title, #124 Title"`
- Duplicates: `"Found N existing issue(s): #45 Title"`
- Both: combined as a single sentence
The enrichment prompt (`buildEnrichmentPrompt`):
```javascript
You are enriching a list of items to be filed as GitHub issues.

Invoke the `mm:issue-triage` skill in feedback intake mode to:
1. Identify each distinct issue in the list below
2. Investigate each item against the codebase (thorough mode)
3. For each item:
   - If a duplicate issue already exists: leave a comment on the existing issue noting the duplicate request; record it with duplicate_of set to the existing issue's number and title; omit proposed_title/body/labels
   - If no duplicate exists: generate a rich title, descriptive body, and appropriate label suggestions; record it with duplicate_of: null

Do NOT create GitHub issues. Record enrichment data only — issue creation will be handled separately.

List of items:
>>

When enrichment is complete, write the result to: {enrichmentFilePath}
Content must be:
{
  "status": "complete" | "failed",
  "items": [
    {
      "proposed_title": "...",      // required when duplicate_of is null
      "proposed_body": "...",       // required when duplicate_of is null
      "proposed_labels": ["..."],   // required when duplicate_of is null; may be empty array
      "duplicate_of": null | { "number": N, "title": "..." }
    }
  ],
  "error": "..." (only when failed)
}

Do not signal completion until the result file has been written.

[CHECKPOINT_INSTRUCTIONS]
```
The enrichment result file is validated on read as described in the `EnrichmentResult` section above. Validation throws with path context on any structural error.
**`_startFilingPipeline`**** in orchestrator**
```typescript
private async _startFilingPipeline(run: Run, request: Request): Promise {
  this.transition(run, 'speccing');
  this.logger.info(
    { event: 'filing.started', run_id: run.id, request_id: run.request_id },
    'Filing pipeline started',
  );

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

  // Step 2: Acknowledge (best-effort)
  try {
    await this.deps.postMessage(request.channel_id, request.thread_ts, 'On it — investigating and filing issues...');
  } catch (err) {
    this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post acknowledgment');
  }

  // Step 3: File issues (enrichment + creation)
  const onProgress = (message: string): Promise =>
    this.deps.postMessage(request.channel_id, request.thread_ts, message).catch(err => {
      this.logger.warn(
        { event: 'progress_failed', phase: 'filing', run_id: run.id, error: String(err) },
        'Failed to post progress update',
      );
    });

  let result: FilingResult;
  try {
    result = await this.deps.issueFiler!.file(request, workspace_path, onProgress);
  } catch (err) {
    await this.deps.workspaceManager.destroy(workspace_path);
    await this.failRun(run, request.channel_id, request.thread_ts, err);
    return;
  }

  // Step 4: Emit per-issue events
  for (const issue of result.filed_issues) {
    if (issue.action === 'filed') {
      this.logger.info(
        { event: 'filing.issue_filed', run_id: run.id, request_id: run.request_id, issue_number: issue.number, issue_title: issue.title },
        'Issue filed',
      );
    } else {
      this.logger.info(
        { event: 'filing.duplicate_detected', run_id: run.id, request_id: run.request_id, existing_issue_number: issue.number, existing_issue_title: issue.title },
        'Duplicate issue detected',
      );
    }
  }

  // Step 5: Destroy workspace (no implementation follows)
  await this.deps.workspaceManager.destroy(workspace_path).catch(err =>
    this.logger.warn({ event: 'workspace.destroy_failed', run_id: run.id, error: String(err) }, 'Failed to destroy workspace after filing'),
  );

  if (result.status === 'failed') {
    await this.failRun(run, request.channel_id, request.thread_ts, new Error(result.error ?? 'Filing failed'));
    return;
  }

  // Step 6: Post summary
  try {
    await this.deps.postMessage(request.channel_id, request.thread_ts, result.summary);
  } catch (err) {
    this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post filing summary');
  }

  const filed_count = result.filed_issues.filter(i => i.action === 'filed').length;
  const duplicate_count = result.filed_issues.filter(i => i.action === 'duplicate').length;
  this.logger.info(
    { event: 'filing.complete', run_id: run.id, request_id: run.request_id, filed_count, duplicate_count },
    'Filing pipeline complete',
  );
  this.transition(run, 'done');
}
```
**Routing in ****`_handleRequest`**
Add a `file_issues` branch alongside the existing intent branches:
```typescript
} else if (intent === 'file_issues') {
  run.intent = 'file_issues';
  this._persistRuns();
  await this._startFilingPipeline(run, request);
}
```
**`OrchestratorDeps`**** update**
```typescript
interface OrchestratorDeps {
  // ... existing deps ...
  issueFiler?: IssueFiler;
}
```
**`index.ts`**** update**
```typescript
import { AgentSDKIssueFiler } from './adapters/agent/issue-filer.js';
// issueManager (GHIssueManager) is already instantiated for bug/chore pipelines
const issueFiler = new AgentSDKIssueFiler(issueManager);
// pass to OrchestratorImpl deps: issueFiler
```
### 4. Security, privacy, and compliance

**Authentication and authorization**
- No changes to the authentication model — same as parent spec; Bolt SDK verifies Slack signatures; the orchestrator trusts only events from the authenticated adapter
**Data privacy**
- Message content is passed to the filing agent as an extension of the existing pattern for `idea`, `bug`, and `chore` intents — it is treated as trusted content from an authenticated Slack user
- Message content is not logged; only metadata (`run_id`, `intent`, `request_id`, `issue_number`, `issue_title`, `filed_count`, `duplicate_count`) appears in log events
**Input validation**
- Message content is treated as user-controlled input and passed as a typed field to the filing agent; it is never interpolated into system prompts without proper delimiters (`>>` quoting)
- The enrichment result file written by the enrichment agent is parsed and validated before `IssueManager.create()` is called with any values from it; `proposed_title`, `proposed_body`, and `proposed_labels` are only passed to `IssueManager.create()` after type validation passes
### 5. Observability

**Log events**

Event
Level
Fields
Notes

`filing.started`
info
`run_id`, `request_id`
Emitted at start of `_startFilingPipeline`

`filing.issue_filed`
info
`run_id`, `request_id`, `issue_number`, `issue_title`
Emitted once per issue created via `IssueManager.create()`

`filing.duplicate_detected`
info
`run_id`, `request_id`, `existing_issue_number`, `existing_issue_title`
Emitted once per duplicate found by the enrichment agent

`filing.complete`
info
`run_id`, `request_id`, `filed_count`, `duplicate_count`
Emitted after all per-issue events and before transition to `done`

All existing events (`run.stage_transition`, `run.failed`, `workspace.*`, `progress_failed`, `run.notify_failed`) apply to this pipeline and are emitted by the shared infrastructure.
**Metrics**
- `slack.messages.classified` — existing counter; `file_issues` is a new value for the `intent` label; no new metrics required
**Alerting**
- No new alerting thresholds; existing thresholds cover the filing pipeline since it reuses the same infrastructure
### 6. Testing plan

**`issue-filer.ts`**** — unit tests (new file)**
*Enrichment prompt structure:*
- `buildEnrichmentPrompt` includes the `mm:issue-triage` feedback intake mode instruction
- Prompt includes the request content delimited by `>>`
- Prompt explicitly instructs the agent NOT to create GitHub issues (enrichment only)
- Prompt includes dedup instructions (leave comment on existing issue; record `duplicate_of`; omit proposed fields for duplicates)
- Prompt includes the enrichment result file path and the expected JSON shape
*Enrichment result validation:*
- `status` value other than `'complete'`/`'failed'`: throws with path context
- Missing `items` array: throws
- Item with `duplicate_of: null` but missing `proposed_title`: throws
- Item with `duplicate_of: null` but missing `proposed_body`: throws
- Item with `duplicate_of` that is not `null` and not an object with `number`/`title`: throws
- Enrichment result file missing after agent completes (ENOENT): throws with path context
- Invalid JSON in enrichment result file: throws with path context
*Creation phase — **`IssueManager.create()`** interactions:*
- Single new item: `IssueManager.create()` called once with `proposed_title`, `proposed_body`, `proposed_labels` from enrichment; returned issue number appears in `filed_issues` with `action: 'filed'`
- Single duplicate item: `IssueManager.create()` not called; `duplicate_of.number` and `duplicate_of.title` appear in `filed_issues` with `action: 'duplicate'`
- Mixed batch (2 new + 1 duplicate): `IssueManager.create()` called exactly twice; `filed_issues` has 3 entries with correct actions
- All items are duplicates: `IssueManager.create()` never called; all entries have `action: 'duplicate'`
- Empty `items` array: `IssueManager.create()` never called; `filed_issues` is empty; summary reflects 0 filed
- `IssueManager.create()` throws: error propagates from `file()`; partially completed items from earlier in the loop are not silently swallowed (the caller sees the failure)
*Summary building:*
- All new: summary contains count and list of `#N title` entries; no duplicate language
- All duplicates: summary contains existing issue count; no "filed" language
- Mixed: summary includes both filed and existing sections
*Progress forwarding:*
- `[Relay]` messages from enrichment agent assistant turns forwarded to `onProgress`
- No `onProgress` callback provided — no error thrown
- `onProgress` throws — error swallowed; enrichment continues
**`intent-classifier.ts`**** — unit tests (delta)**
- `new_thread` context → valid intents include `'file_issues'`
- `intake` context → valid intents include `'file_issues'`
- `'file_issues'` returned for `reviewing_spec` context → conservative fallback (`'feedback'`) asserted
- Example message with a list of items (e.g., "please file these: ...") → classified as `'file_issues'`
- Example message requesting a single item be filed (e.g., "please file an issue for X") → classified as `'file_issues'`
- `ALL_INTENTS` array snapshot test includes `'file_issues'` (guards against accidental removal)
**`orchestrator.ts`**** — unit tests (delta)**
*New request routing:*
- `new_request` + classifier returns `'file_issues'` → `_startFilingPipeline` called; `run.intent = 'file_issues'`; run transitions `intake → speccing → done`
*Error paths:*
- Workspace creation failure → `failRun` called; run marked `failed`; `issueFiler.file()` not called
- Filing agent throws (enrichment failure) → workspace destroyed; `failRun` called; run marked `failed`
- Filing agent throws (creation phase — `IssueManager.create()` failure) → workspace destroyed; `failRun` called; run marked `failed`
- `result.status === 'failed'` → workspace destroyed; `failRun` called with `result.error`; per-issue log events emitted for any entries already in `filed_issues` before status check
*Success path:*
- Filing agent succeeds with mixed results (1 filed, 1 duplicate):
	- `filing.issue_filed` emitted for the filed item with correct `issue_number` and `issue_title`
	- `filing.duplicate_detected` emitted for the duplicate with correct `existing_issue_number` and `existing_issue_title`
	- workspace destroyed
	- `result.summary` posted to Slack
	- `filing.complete` emitted with `filed_count: 1`, `duplicate_count: 1`
	- run transitions to `done`
- All new items filed → `filing.issue_filed` emitted once per item; no `filing.duplicate_detected`
- All duplicates → `filing.duplicate_detected` emitted once per item; no `filing.issue_filed`; `IssueManager.create()` never called on the mock
- Acknowledgment post fails → `run.notify_failed` logged; filing proceeds normally
- Summary post fails → `run.notify_failed` logged; run still transitions to `done`; issues remain filed
*Existing routing unchanged:*
- `idea`, `bug`, `chore`, `question` intent routing unaffected by the `file_issues` branch
### 7. Alternatives considered

**Reuse ****`SpecGenerator.create()`**** with a ****`'file_issues'`**** intent branch**
Rather than a new `IssueFiler` interface, add `'file_issues'` as a fourth intent to `SpecGenerator.create()`. Rejected because the return type is fundamentally different: `SpecGenerator.create()` returns a `spec_path: string` (path to a written markdown file used downstream for Notion publishing and implementation). The filing pipeline has no downstream use for a spec path — it produces a filing summary. Forcing this into the spec generator would require either changing its return type or having the orchestrator ignore the returned value, both of which obscure intent and create a confusing interface.
**Skip workspace creation for the filing pipeline (use the configured repo path directly)**
Rather than calling `workspaceManager.create()`, pass `args.repoPath` to the filing agent so `gh issue create` runs against the main repo without cloning. Rejected because it couples the filing agent to the process's startup repo path — a detail that is not available at the orchestrator level without a larger design change — and introduces a risk of concurrent filing runs clobbering each other's workspace state. The workspace manager already handles isolation; using it is consistent with all other pipelines.
**Route messages as multiple independent ****`bug`****/****`chore`****/****`idea`**** runs**
Detect that a message contains multiple items at classification time and spawn N separate runs, one per item, each going through the normal single-item pipeline. Rejected because (1) the classifier would need to tease apart items before dispatching, doing work that `mm:issue-triage` feedback intake mode already does better; (2) N simultaneous runs would each go through a Notion review cycle, which is the wrong model for explicit filing requests; (3) the run concurrency limit could be hit on a large list.
**Delegate all GitHub operations (enrichment and creation) to mm:issue-triage**
Have the enrichment agent call `gh issue create` directly for new items instead of writing enrichment data for the creation phase to consume. Rejected because it creates a second code path for GitHub issue creation that bypasses `IssueManager`, diverging from the bug and chore pipelines and reintroducing the risk of duplicate-creation bugs that were already addressed in the parent spec. Keeping all issue creation in `IssueManager.create()` means bugs in that path are fixed once and benefit all pipelines.
### 8. Risks

**`mm:issue-triage`**** feedback intake mode in an agent-invoked context**
The enrichment agent calls `mm:issue-triage` as a skill inside a `query()` agent session, not interactively. If the skill has branching logic that requires human confirmation before completing (e.g., "does this look right?"), the agent session may stall waiting for input that never arrives. Mitigation: validate that `mm:issue-triage` feedback intake mode can run non-interactively before merging; if interactive confirmation steps block the agent, file an improvement issue against the micromanager skill to add a non-interactive / auto-confirm mode.
**`ALL_INTENTS`**** must stay in sync with ****`Intent`**** type**
Same risk as in the parent spec: `ALL_INTENTS` is used for intent parsing and must include `'file_issues'`. Mitigation: the acceptance criteria for the type change task include a grep verification (`grep -r "ALL_INTENTS" src/`); TypeScript catches type mismatches at other call sites.
**Partial filing on ****`IssueManager.create()`**** failure**
If the creation phase fails mid-loop (e.g., `IssueManager.create()` throws on the second of three items), the first item has already been created in GitHub but the overall `file()` call throws. The orchestrator calls `failRun`, so the run is marked `failed` and no summary is posted. The human receives an error message with no list of which items were filed. Mitigation: the risk is bounded because the enrichment result is written first and survives the failure; the human can re-send the request for the remaining items; a future enhancement could add partial-success reporting to `FilingResult`.
**Workspace destroyed before summary is posted; summary post failure not retried**
The filing pipeline destroys the workspace before posting the summary, so a failed summary post cannot be retried by re-running the pipeline (the workspace no longer exists). Mitigation: workspace destruction is done before the summary post; if the summary post fails, the `run.notify_failed` event is logged — the issues are still filed in GitHub and the run transitions to `done`; the human can check GitHub directly. This matches the best-effort notification pattern used elsewhere in the orchestrator.
## Task list

- [x] **Story: Add ****`file_issues`**** to the intent taxonomy**
	- [x] **Task: Add ****`file_issues`**** to ****`RequestIntent`**
		- **Description**: In `src/types/runs.ts`, extend `RequestIntent` from `'idea' | 'bug' | 'chore' | 'question'` to `'idea' | 'bug' | 'chore' | 'file_issues' | 'question'`.
		- **Acceptance criteria**:
			- [x] `RequestIntent` type includes `'file_issues'`
			- [x] `tsc --noEmit` passes (downstream errors expected until `Intent` type is updated)
		- **Dependencies**: None
	- [x] **Task: Add ****`file_issues`**** to ****`Intent`**** type and classifier**
		- **Description**: In `src/adapters/agent/intent-classifier.ts`: (1) add `'file_issues'` to the `Intent` union type; (2) add `'file_issues'` to `ALL_INTENTS`; (3) add `'file_issues'` to `VALID_INTENTS_BY_CONTEXT` for `new_thread` and `intake` contexts; (4) add `'file_issues'` to `intentDescriptions` with description `'the human is explicitly requesting that one or more items be filed as GitHub issues'`; (5) confirm `CONSERVATIVE_FALLBACK` for `new_thread` and `intake` remains `'idea'` (no change needed). Run `grep -r "ALL_INTENTS" src/` to verify no other call site needs updating.
		- **Acceptance criteria**:
			- [x] `Intent` type includes `'file_issues'`
			- [x] `ALL_INTENTS` includes `'file_issues'`
			- [x] `VALID_INTENTS_BY_CONTEXT.new_thread` includes `'file_issues'`
			- [x] `VALID_INTENTS_BY_CONTEXT.intake` includes `'file_issues'`
			- [x] `intentDescriptions` entry for `'file_issues'` is present and accurate
			- [x] `CONSERVATIVE_FALLBACK` for `new_thread` and `intake` remains `'idea'` (unchanged)
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `file_issues` to `RequestIntent`
	- [x] **Task: Update intent classifier tests for ****`file_issues`**
		- **Description**: In `tests/adapters/agent/intent-classifier.test.ts`, add cases: (1) `new_thread` context → valid intents include `'file_issues'`; (2) `intake` context → valid intents include `'file_issues'`; (3) a list-of-items message (e.g., "please file these: ...") classifies as `'file_issues'`; (4) a single-item explicit filing message (e.g., "please file an issue for X") classifies as `'file_issues'`; (5) `'file_issues'` in a `reviewing_spec` context → conservative fallback (`'feedback'`) asserted; (6) `ALL_INTENTS` snapshot test includes `'file_issues'` (guards against accidental removal).
		- **Acceptance criteria**:
			- [x] `new_thread` valid intents test includes `'file_issues'`
			- [x] `intake` valid intents test includes `'file_issues'`
			- [x] List-of-items message example classifies as `'file_issues'`
			- [x] Single-item explicit filing message classifies as `'file_issues'`
			- [x] Out-of-context `'file_issues'` → fallback asserted
			- [x] `ALL_INTENTS` snapshot test includes `'file_issues'`
			- [x] All tests pass
		- **Dependencies**: Task: Add `file_issues` to `Intent` type and classifier
- [ ] **Story: Implement the filing agent**
	- [x] **Task: Create ****`issue-filer.ts`**** — types, interface, and ****`AgentSDKIssueFiler`**
		- **Description**: Create `src/adapters/agent/issue-filer.ts`. (1) Define and export `FiledIssue` (`{ number: number; title: string; action: 'filed' | 'duplicate' }`), `FilingResult` (`{ status: 'complete' | 'failed'; summary: string; filed_issues: FiledIssue[]; error?: string }`), and `IssueFiler` interface (`file(request, workspace_path, onProgress?): Promise`). (2) Define internal (non-exported) `EnrichmentItem` and `EnrichmentResult` types as specified in section 3. (3) Implement `AgentSDKIssueFiler` with `constructor(private readonly issueManager: IssueManager)`. (4) Implement `buildEnrichmentPrompt(request, enrichmentFilePath)` — instructs the agent to invoke `mm:issue-triage` in feedback intake mode for enrichment ONLY (no GitHub issue creation); includes request content in `>>` delimiters; instructs agent to write `enrichment-result.json` with the schema from section 3; includes `CHECKPOINT_INSTRUCTIONS` (copy from `spec-generator.ts`). (5) Implement `readAndValidateEnrichmentResult(filePath)` — reads and parses the JSON file; throws with path context on ENOENT or invalid JSON; validates `status`, `items` array, and per-item field types per the rules in section 3. (6) Implement the enrichment phase in `file()`: invoke agent SDK via `query()`; forward `[Relay]` messages from assistant turns to `onProgress`. (7) Implement the creation phase in `file()`: loop over `enrichmentResult.items`; for non-duplicates call `this.issueManager.create(proposed_title, proposed_body, proposed_labels)` and push `{ number: created.number, title: proposed_title, action: 'filed' }`; for duplicates push `{ number: duplicate_of.number, title: duplicate_of.title, action: 'duplicate' }`. (8) Implement `buildSummary(filedIssues)` — builds the human-readable Slack message from the `filed_issues` array. Follow `AgentSDKSpecGenerator`'s structure for agent invocation and result file handling.
		- **Acceptance criteria**:
			- [x] `FiledIssue`, `FilingResult`, `IssueFiler` exported from `issue-filer.ts`
			- [x] `EnrichmentItem` and `EnrichmentResult` defined but not exported
			- [x] `AgentSDKIssueFiler` exported and implements `IssueFiler`
			- [x] Constructor accepts `IssueManager`
			- [x] `buildEnrichmentPrompt` includes `mm:issue-triage` instruction, content in `>>`, explicit "do NOT create GitHub issues" instruction, dedup instructions, enrichment result file path, expected JSON schema, and `CHECKPOINT_INSTRUCTIONS`
			- [x] Enrichment result file path is `/.autocatalyst/enrichment-result.json`
			- [x] `readAndValidateEnrichmentResult` throws on ENOENT, invalid JSON, invalid `status`, missing `items`, and per-item field type violations
			- [x] `[Relay]` messages forwarded to `onProgress`; absent `onProgress` does not throw
			- [x] Creation phase calls `IssueManager.create(title, body, labels)` exactly once per non-duplicate item
			- [x] `FilingResult.summary` built by `buildSummary` (not written by the agent)
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `file_issues` to `RequestIntent`
	- [ ] **Task: Write unit tests for ****`AgentSDKIssueFiler`**
		- **Description**: Create `tests/adapters/agent/issue-filer.test.ts`. Use a mock `queryFn` and mock `IssueManager` (same injection pattern as `spec-generator.test.ts`). Test cases — *Prompt structure*: (1) prompt contains `mm:issue-triage` instruction; (2) request content present in `>>` delimiters; (3) prompt contains explicit "do NOT create GitHub issues" instruction; (4) prompt contains dedup instructions; (5) prompt contains enrichment result file path and schema. *Enrichment result validation*: (6) missing file → throws with path; (7) invalid JSON → throws with path; (8) invalid `status` → throws; (9) missing `items` → throws; (10) non-duplicate item missing `proposed_title` → throws; (11) invalid `duplicate_of` structure → throws. *Creation phase*: (12) single new item → `IssueManager.create()` called once with exact title/body/labels from enrichment; returned number in `filed_issues` with `action: 'filed'`; (13) single duplicate → `IssueManager.create()` not called; `duplicate_of` values in `filed_issues` with `action: 'duplicate'`; (14) mixed batch (2 new + 1 duplicate) → `IssueManager.create()` called exactly twice; `filed_issues` has 3 entries with correct actions; (15) all duplicates → `IssueManager.create()` never called; (16) empty `items` array → `IssueManager.create()` never called, `filed_issues` empty; (17) `IssueManager.create()` throws → error propagates from `file()`. *Summary building*: (18) all new → summary contains filed count; no duplicate language; (19) all duplicates → summary contains existing count; no "filed" language; (20) mixed → both sections present. *Progress*: (21) `[Relay]` messages forwarded to `onProgress`; (22) no `onProgress` → no error; (23) `onProgress` throws → swallowed, does not abort enrichment.
		- **Acceptance criteria**:
			- [ ] All five prompt structure assertions pass
			- [ ] All six enrichment result validation assertions pass
			- [ ] Creation phase tests pass for single-new, single-duplicate, mixed, all-duplicate, empty, and `IssueManager.create()` failure cases
			- [ ] Summary building tests pass for all-new, all-duplicate, and mixed cases
			- [ ] `onProgress` forwarding, absent, and throwing cases all pass
			- [ ] All tests pass
		- **Dependencies**: Task: Create `issue-filer.ts` — types, interface, and `AgentSDKIssueFiler`
- [ ] **Story: Add filing pipeline to orchestrator**
	- [ ] **Task: Add ****`issueFiler`**** to ****`OrchestratorDeps`**** and implement ****`_startFilingPipeline`**
		- **Description**: In `src/core/orchestrator.ts`: (1) import `IssueFiler` and `FilingResult` from `issue-filer.js`; (2) add `issueFiler?: IssueFiler` to `OrchestratorDeps`; (3) implement private method `_startFilingPipeline(run: Run, request: Request): Promise` following section 3. The method: transitions to `speccing`; emits `filing.started`; creates workspace (on failure: `failRun`, return); posts acknowledgment as best-effort; calls `this.deps.issueFiler!.file(request, workspace_path, onProgress)` (on throw: destroy workspace, `failRun`, return); after `file()` returns, loops over `result.filed_issues` emitting `filing.issue_filed` (fields: `run_id`, `request_id`, `issue_number`, `issue_title`) for `action: 'filed'` entries and `filing.duplicate_detected` (fields: `run_id`, `request_id`, `existing_issue_number`, `existing_issue_title`) for `action: 'duplicate'` entries; destroys workspace (best-effort); if `result.status === 'failed'`: `failRun` with `result.error`, return; posts `result.summary` as best-effort; emits `filing.complete` with `filed_count` and `duplicate_count`; transitions to `done`.
		- **Acceptance criteria**:
			- [ ] `issueFiler` added to `OrchestratorDeps` as optional
			- [ ] `_startFilingPipeline` is private
			- [ ] `filing.started` emitted at the start of the pipeline
			- [ ] On success: run transitions `intake → speccing → done`
			- [ ] On workspace creation failure: `failRun` called; `issueFiler.file()` not called
			- [ ] On `issueFiler.file()` throwing: workspace destroyed; `failRun` called
			- [ ] On `result.status === 'failed'`: workspace destroyed; `failRun` called with `result.error`
			- [ ] `filing.issue_filed` emitted for each `action: 'filed'` entry (with `issue_number` and `issue_title`)
			- [ ] `filing.duplicate_detected` emitted for each `action: 'duplicate'` entry (with `existing_issue_number` and `existing_issue_title`)
			- [ ] Workspace destroyed in success path after per-issue events
			- [ ] `result.summary` posted to Slack on success (best-effort)
			- [ ] `filing.complete` emitted with `run_id`, `request_id`, `filed_count`, `duplicate_count`
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Create `issue-filer.ts` — types, interface, and `AgentSDKIssueFiler`
	- [ ] **Task: Wire ****`file_issues`**** intent routing in ****`_handleRequest`**
		- **Description**: In `src/core/orchestrator.ts`, `_handleRequest`: add a `file_issues` branch after the `chore` branch — `run.intent = 'file_issues'; this._persistRuns(); await this._startFilingPipeline(run, request);`. Verify existing `idea`, `bug`, `chore`, and `question` branches are unmodified.
		- **Acceptance criteria**:
			- [ ] `file_issues` intent branch routes to `_startFilingPipeline`
			- [ ] `run.intent` set to `'file_issues'` before `_persistRuns()`
			- [ ] Branch placed after the `chore` branch
			- [ ] Existing `idea`, `bug`, `chore`, `question` branches unchanged
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `issueFiler` to `OrchestratorDeps` and implement `_startFilingPipeline`, Task: Add `file_issues` to `Intent` type and classifier
	- [ ] **Task: Wire ****`AgentSDKIssueFiler`**** in ****`index.ts`**
		- **Description**: In `src/index.ts`: (1) import `AgentSDKIssueFiler` from `./adapters/agent/issue-filer.js`; (2) instantiate `const issueFiler = new AgentSDKIssueFiler(issueManager)` — `issueManager` is the existing `GHIssueManager` instance already created for the bug/chore pipelines; (3) add `issueFiler` to the `OrchestratorImpl` deps object.
		- **Acceptance criteria**:
			- [ ] `AgentSDKIssueFiler` imported and instantiated
			- [ ] Existing `GHIssueManager` instance passed to the `AgentSDKIssueFiler` constructor
			- [ ] `issueFiler` passed in orchestrator deps
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Wire `file_issues` intent routing in `_handleRequest`
	- [ ] **Task: Update orchestrator unit tests for ****`file_issues`**
		- **Description**: In `tests/core/orchestrator.test.ts`, add test cases as specified in section 6. *Routing*: `new_request` + classifier returns `'file_issues'` → `_startFilingPipeline` called; `run.intent = 'file_issues'`; run reaches `done`. *Error paths*: (1) workspace creation failure → `failRun`; `issueFiler.file()` not called; (2) `issueFiler.file()` throws (enrichment failure) → workspace destroyed; `failRun`; (3) `issueFiler.file()` throws (creation phase — `IssueManager.create()` failure) → workspace destroyed; `failRun`; (4) `result.status === 'failed'` → workspace destroyed; `failRun` with `result.error`. *Success path*: (5) mixed result (1 filed + 1 duplicate) → `filing.issue_filed` emitted with correct `issue_number`/`issue_title`, `filing.duplicate_detected` emitted with correct `existing_issue_number`/`existing_issue_title`, workspace destroyed, summary posted, `filing.complete` with `filed_count: 1`/`duplicate_count: 1`, run `done`; (6) all new → only `filing.issue_filed` events; no `filing.duplicate_detected`; (7) all duplicates → only `filing.duplicate_detected`; `IssueManager.create()` never called; (8) acknowledgment post fails → pipeline continues; (9) summary post fails → run transitions to `done`. *Existing routing*: `idea`, `bug`, `chore`, `question` routing unaffected.
		- **Acceptance criteria**:
			- [ ] Routing test: `run.intent = 'file_issues'`; run reaches `done`
			- [ ] All four error path tests pass
			- [ ] Mixed-result success path asserts per-issue event fields, workspace destroyed, summary posted, `filing.complete` fields, `done` transition
			- [ ] All-new and all-duplicate scenarios assert correct event emission and `IssueManager.create()` call count
			- [ ] Acknowledgment and summary post failure tests pass
			- [ ] Existing `idea`, `bug`, `chore`, `question` routing tests unchanged and passing
			- [ ] All tests pass
		- **Dependencies**: Task: Wire `file_issues` intent routing in `_handleRequest`