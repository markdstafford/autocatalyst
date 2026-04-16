---
created: 2026-04-16
last_updated: 2026-04-16
status: approved
issue: null
specced_by: markdstafford
implemented_by: null
superseded_by: null
---
# Enhancement: Notion database publishing

## Parent feature

`enhancement-notion-publisher.md` — Notion publisher
## What

Instead of writing specs and testing guides as plain child pages under a configured parent page, Autocatalyst creates them as structured entries in two dedicated Notion databases: a "Specs" database and a "Testing guides" database. Each spec entry carries typed properties populated from the spec's frontmatter — title, filename, status, specced by, repo/codebase, and issue number. When a spec is committed (approved), its Specs database entry Status is updated to "Approved". Testing guide entries are created in the Testing guides database with a relation back to the corresponding Specs entry, wiring the dual-property link that Notion maintains automatically. The `parent_page_id` configuration field is replaced by `specs_database_id` and `testing_guides_database_id`.
## Why

The Specs and Testing guides databases exist to be the structured home for these artifacts — they have the right columns, relations, and views already in place. Writing to them as proper database entries makes the full corpus queryable: team members can filter by Status to find all in-progress specs, sort by creation date, and navigate from a spec entry directly to its testing guide via the built-in relation without hunting through a page tree. It also makes Autocatalyst a first-class contributor to the team's existing workflow rather than a parallel, unstructured pile of pages.
## User stories

- Phoebe can see a new spec entry appear in the Specs database with Status "Speccing" as soon as Autocatalyst generates it, without any manual steps
- Phoebe can filter the Specs database by Status and immediately see which specs are actively being specced, waiting on feedback, or approved
- Phoebe can see the spec entry Status change to "Approved" automatically when the spec is committed, and "Complete" when the implementation is approved
- Phoebe can see the spec entry Status change to "Superseded" automatically when the spec is superseded
- Enzo can open a spec entry and navigate to its linked testing guide directly from the Testing guide relation property
- Enzo can open the Testing guides database and see the corresponding Spec relation on each entry pointing back to the source spec
- Enzo can see the testing guide Status update automatically as implementation work progresses
- Mark (operator) can wire up the integration by adding two database IDs and the integration token to [WORKFLOW.md](http://WORKFLOW.md) — no code changes required
## Design changes

This enhancement has no user-facing UI changes. The design changes describe the Notion artifact structure that team members see when browsing the two databases.
### Specs database entry structure

Each spec generates one entry in the Specs database. Autocatalyst sets the following properties at creation and updates them on revision:
<table header-row="true">
<tr>
<td>Property</td>
<td>Type</td>
<td>Value set by Autocatalyst</td>
</tr>
<tr>
<td>**Title**</td>
<td>Title</td>
<td>Spec title derived from the spec filename (same titleFromPath logic as today — e.g., `feature-setup-wizard.md` → "Setup wizard")</td>
</tr>
<tr>
<td>**Filename**</td>
<td>Rich text</td>
<td>Basename of the spec file (e.g., `feature-setup-wizard.md`); used to resolve `supersedes` and `superseded_by` relation links from other spec entries</td>
</tr>
<tr>
<td>**Status**</td>
<td>Status</td>
<td>"Speccing" on creation; see status lifecycle below</td>
</tr>
<tr>
<td>**Specced by**</td>
<td>Rich text</td>
<td>Value of `specced_by` from spec frontmatter</td>
</tr>
<tr>
<td>**Repo / Codebase**</td>
<td>Select</td>
<td>org/repo derived from the last two path segments of `repo_url` (e.g., `acme-org/autocatalyst`); omitted if `repo_name` is not provided in `NotionPublisherOptions`</td>
</tr>
<tr>
<td>**Issue #**</td>
<td>Number</td>
<td>Value of `issue` from spec frontmatter, if set; omitted otherwise</td>
</tr>
<tr>
<td>**Last updated**</td>
<td>Date</td>
<td>Value of `last_updated` from spec frontmatter</td>
</tr>
<tr>
<td>**Implemented by**</td>
<td>Rich text</td>
<td>Value of `implemented_by` from spec frontmatter, if set; omitted otherwise</td>
</tr>
<tr>
<td>**Superseded by / Supersedes**</td>
<td>Relation</td>
<td>Values of `superseded_by` and `supersedes` from spec frontmatter, if set; each is a spec filename resolved by querying the Specs database `Filename` property, then linked as a relation</td>
</tr>
</table>
The following properties are **not set by Autocatalyst** — they are either auto-managed by Notion or populated manually by the team:
<table header-row="true">
<tr>
<td>Property</td>
<td>How it's populated</td>
</tr>
<tr>
<td>**Created**</td>
<td>Auto-set by Notion (created_time)</td>
</tr>
<tr>
<td>**Testing guide**</td>
<td>Populated automatically via the dual-property relation when a testing guide entry is created with the Spec relation pointing to this entry</td>
</tr>
<tr>
<td>**Links**</td>
<td>Set manually by the team</td>
</tr>
</table>
**Status lifecycle**: The Status property reflects where the spec is in its lifecycle. Autocatalyst manages all transitions:
<table header-row="true">
<tr>
<td>Event</td>
<td>Status transition</td>
</tr>
<tr>
<td>Spec created</td>
<td>→ "Speccing"</td>
</tr>
<tr>
<td>Agent stops working, spec not yet approved</td>
<td>→ "Waiting on feedback"</td>
</tr>
<tr>
<td>Agent resumes working on spec</td>
<td>→ "Speccing"</td>
</tr>
<tr>
<td>Spec committed (approved via `SpecCommitter`)</td>
<td>→ "Approved"</td>
</tr>
<tr>
<td>Implementation approved</td>
<td>→ "Complete"</td>
</tr>
<tr>
<td>Spec superseded (`superseded_by` set in frontmatter)</td>
<td>→ "Superseded"</td>
</tr>
</table>
**Entry page body**: The full spec Markdown including frontmatter is written to the entry's page body via the Notion Markdown API — identical to the current behavior. Inline comment anchors, span passthrough, and revision behavior are unchanged.
---
### Testing guides database entry structure

Each testing guide generates one entry in the Testing guides database. Autocatalyst sets the following properties at creation:
<table header-row="true">
<tr>
<td>Property</td>
<td>Type</td>
<td>Value set by Autocatalyst</td>
</tr>
<tr>
<td>**Title**</td>
<td>Title</td>
<td>"Testing guide: \{spec title\}" — derived from the associated spec title</td>
</tr>
<tr>
<td>**Spec**</td>
<td>Relation</td>
<td>The Notion page ID of the corresponding Specs database entry</td>
</tr>
<tr>
<td>**Status**</td>
<td>Status</td>
<td>Set automatically by Autocatalyst; see status lifecycle below</td>
</tr>
<tr>
<td>**PR link**</td>
<td>URL</td>
<td>Set automatically by Autocatalyst when the implementation PR is created</td>
</tr>
</table>
All other properties are either auto-managed by Notion or populated manually:
<table header-row="true">
<tr>
<td>Property</td>
<td>How it's populated</td>
</tr>
<tr>
<td>**Created**</td>
<td>Auto-set by Notion (created_time)</td>
</tr>
<tr>
<td>**Last updated**</td>
<td>Auto-set by Notion on every edit (last_edited_time)</td>
</tr>
<tr>
<td>**Implemented by**</td>
<td>Set manually by the team</td>
</tr>
<tr>
<td>**Test plan complete**</td>
<td>Checked manually by the team</td>
</tr>
</table>
**Status lifecycle**: Autocatalyst manages the testing guide Status to reflect the state of implementation work:
<table header-row="true">
<tr>
<td>Event</td>
<td>Status transition</td>
</tr>
<tr>
<td>Testing guide created</td>
<td>→ "Not started"</td>
</tr>
<tr>
<td>Agent starts working on implementation</td>
<td>→ "In progress"</td>
</tr>
<tr>
<td>Agent stops working on implementation</td>
<td>→ "Waiting on feedback"</td>
</tr>
<tr>
<td>Implementation approved</td>
<td>→ "Approved"</td>
</tr>
</table>
**Spec relation and dual-property sync**: Setting the `Spec` relation on a testing guide entry automatically populates the `Testing guide` relation on the linked Specs entry — this is Notion's dual-property relation behavior and requires no additional API call from Autocatalyst.
**Entry page body**: Same structure as today — a spec link bookmark, a Summary section, a Testing instructions section, and a Feedback section with to-do items. No changes to content or layout.
---
### Configuration delta

`WORKFLOW.md` gains two new fields and the integration token under the `notion` block. The existing `parent_page_id` field is removed.
**Before:**
```yaml
notion:
  parent_page_id: <page-id>
# Note: Set AC_NOTION_INTEGRATION_TOKEN as an environment variable (not in this file)

```
**After:**
```yaml
notion:
  integration_token: ${AC_NOTION_INTEGRATION_TOKEN}
  specs_database_id: <specs-database-id>
  testing_guides_database_id: <testing-guides-database-id>
```
The integration token (`AC_NOTION_INTEGRATION_TOKEN`) is added to the `notion` block in [WORKFLOW.md](http://WORKFLOW.md) as `integration_token: ${AC_NOTION_INTEGRATION_TOKEN}`, following the same pattern as the Slack tokens.
## Technical changes

### Affected files

- `src/types/config.ts` — `notion` block updated: `parent_page_id` replaced by `specs_database_id` + `testing_guides_database_id`
- `src/adapters/notion/notion-client.ts` — add `pages.updateProperties()` and `databases.query()` methods
- `src/adapters/slack/canvas-publisher.ts` — `SpecPublisher` interface gains optional `updateStatus?()` method; `SpecEntryStatus` type exported (note: markdstafford/autocatalyst#50 tracks extracting `SpecPublisher` to a neutral location — out of scope here)
- `src/adapters/notion/notion-publisher.ts` — constructor updated; `create()` creates database entry with typed properties; `update()` also syncs frontmatter properties; `updateStatus()` added
- `src/adapters/notion/implementation-feedback-page.ts` — constructor gains `testing_guides_database_id` as second positional parameter; `create()` signature updated; `updateStatus()` and `setPRLink()` added; `ImplementationFeedbackPage` interface updated
- `src/core/orchestrator.ts` — status update calls added at lifecycle transitions; `implFeedbackPage.create()` call updated with new `spec_title` parameter
- `src/index.ts` — config validation updated; `repo_name` derived from `repo_url`; constructors updated
### Changes

This enhancement is a delta on the parent feature (`enhancement-notion-publisher.md`). All changes are additive or substitutive within the Notion adapter layer — no new agent interactions, no new Slack interactions, no changes to the workspace or spec generation pipeline.
The core substitution: `pages.create()` with `parent: { page_id }` → `pages.create()` with `parent: { database_id }` plus typed properties. The Markdown content write and revision flow are unchanged.
## Tech spec

### 1. Introduction and overview

**Dependencies**
- Enhancement: Notion publisher — provides all Notion infrastructure (NotionClient, NotionPublisher, NotionFeedbackSource, ImplementationFeedbackPage, spec committer, Markdown API, comment handling). This enhancement is a delta on top of it; all of that infrastructure is assumed to be in place.
- The Specs and Testing guides databases must exist in Notion with the schema described in the Design changes section. Autocatalyst does not create or validate database schemas at startup.
**Technical goals**
- Specs created as entries in `specs_database_id` with typed properties sourced from spec frontmatter
- Testing guides created as entries in `testing_guides_database_id` with a Spec relation pointing to the corresponding Specs entry
- Status properties updated at each lifecycle event via the Orchestrator (Speccing, Waiting on feedback, Approved, Complete, Superseded)
- `supersedes` / `superseded_by` frontmatter filenames resolved to Notion page IDs by querying the Specs database `Filename` property
- `parent_page_id` config removed; `specs_database_id` and `testing_guides_database_id` take its place
- Markdown content, span passthrough, comment handling, and revision flow unchanged
**Non-goals**
- Migrating existing Notion pages created under `parent_page_id` to the new databases
- Validating the database schema at startup — Autocatalyst surfaces schema mismatches as Notion API errors on first run
- Automating testing guide Status updates for teams not using the implementation workflow
### 2. System design and architecture

**Modified components**
- `src/types/config.ts` — `WorkflowConfig.notion` updated
- `src/adapters/notion/notion-client.ts` — two new methods on `NotionClient` interface and `NotionClientImpl`
- `src/adapters/slack/canvas-publisher.ts` — `SpecPublisher` interface extended with optional `updateStatus?()`; `SpecEntryStatus` type added. `SpecPublisher` is currently defined in `canvas-publisher.ts` because that is where the `SlackCanvasPublisher` implementation lives. This is acknowledged as a sub-optimal placement; markdstafford/autocatalyst#50 tracks extracting it to a neutral location and is out of scope here.
- `src/adapters/notion/notion-publisher.ts` — constructor, `create()`, `update()` updated; `updateStatus()` added
- `src/adapters/notion/implementation-feedback-page.ts` — constructor, `create()` updated; `updateStatus()`, `setPRLink()` added
- `src/core/orchestrator.ts` — status update call-sites added at each lifecycle transition
- `src/index.ts` — config validation, `repo_name` derivation, constructor calls updated
No new files.
### 3. Detailed design

**Updated config types**
```typescript
// src/types/config.ts
export interface WorkflowConfig {
  // ...existing fields unchanged
  notion?: {
    integration_token: string;
    specs_database_id: string;          // replaces parent_page_id
    testing_guides_database_id: string; // new
  };
}
```
**NotionClient additions**
```typescript
// src/adapters/notion/notion-client.ts — additions to interface and NotionClientImpl
export interface NotionClient {
  // ...existing methods unchanged
  pages: {
    create(args: CreatePageParameters): Promise<CreatePageResponse>;
    getMarkdown(page_id: string): Promise<string>;
    updateMarkdown(page_id: string, operation: MarkdownOperation): Promise<void>;
    updateProperties(page_id: string, properties: Record<string, unknown>): Promise<void>; // new
  };
  databases: {
    query(                                                                                  // new
      database_id: string,
      filter?: unknown,
    ): Promise<{ results: Array<{ id: string; properties: Record<string, unknown> }> }>;
  };
}
```
`pages.updateProperties` sends `PATCH /v1/pages/{page_id}` with `{ properties }`. Implemented via the Notion SDK's `pages.update()` method.
`databases.query` sends `POST /v1/databases/{database_id}/query` with an optional filter body. Implemented via the SDK's `databases.query()` method.
**SpecPublisher interface extension**
```typescript
// src/adapters/slack/canvas-publisher.ts
export type SpecEntryStatus =
  | 'Speccing'
  | 'Waiting on feedback'
  | 'Approved'
  | 'Complete'
  | 'Superseded';

export interface SpecPublisher {
  create(channel_id: string, thread_ts: string, spec_path: string): Promise<string>;
  update(publisher_ref: string, spec_path: string, page_content?: string): Promise<void>;
  getPageMarkdown(publisher_ref: string): Promise<string>;
  updateStatus?(publisher_ref: string, status: SpecEntryStatus): Promise<void>; // new; not implemented by SlackCanvasPublisher
}
```
`SlackCanvasPublisher` does not implement `updateStatus` (the method is absent on instances). All call-sites use optional chaining: `await this.deps.specPublisher.updateStatus?.(publisher_ref, status)`.
**NotionPublisher changes**
**What goes in options vs. positional**: `client`, `app`, and `specs_database_id` are positional — they are the core dependencies and the primary operational target the component needs to function. `repo_name` is a presentational configuration value (used only to populate the `Repo / Codebase` property); it goes in `NotionPublisherOptions`. This keeps the positional signature stable and consistent with the current `(client, app, parent_page_id)` shape.
Constructor signature:
```typescript
constructor(
  client: NotionClient,
  app: App,
  specs_database_id: string,  // replaces parent_page_id
  options?: NotionPublisherOptions,
)
```
`NotionPublisherOptions` gains `repo_name?: string` alongside the existing `logDestination`. If `repo_name` is absent, the `Repo / Codebase` property is omitted from the `pages.create()` call.
`create()` changes:
1. Read spec from `spec_path`; parse YAML frontmatter via private `parseFrontmatter()` helper
2. Derive `title` via `titleFromPath(spec_path)` and `filename` via `basename(spec_path)`
3. Build `properties` object for the Notion API call:
	- `Title`: title property with derived title
	- `Filename`: rich_text property with spec filename
	- `Status`: status property set to `"Speccing"`
	- `Specced by`: rich_text from `frontmatter['specced_by']`
	- `Repo / Codebase`: select from `options.repo_name` (omit key if absent)
	- `Issue #`: number from `frontmatter['issue']` (omit key if null/undefined)
	- `Last updated`: date from `frontmatter['last_updated']`
	- `Implemented by`: rich_text from `frontmatter['implemented_by']` (omit key if null/undefined)
	- `Superseded by / Supersedes`: relation resolved via `resolveFilenameToPageId()` if `frontmatter['supersedes']` is set
4. `POST /v1/pages` with `parent: { database_id: specs_database_id }` and properties — no children
5. `PATCH /v1/pages/<page_id>/markdown` with `replace_content` (unchanged from parent feature)
6. Post Slack message with Notion page URL (unchanged)
7. Return `page_id`
`update()` changes: after writing Markdown as today, additionally call `pages.updateProperties()` to sync the following from freshly-parsed frontmatter: `last_updated`, `implemented_by`. If `superseded_by` is now set in frontmatter, also call `pages.updateProperties()` with Status `"Superseded"` and the Superseded by / Supersedes relation (resolved via `resolveFilenameToPageId()`).
`updateStatus(page_id, status)` (new):
```typescript
async updateStatus(page_id: string, status: SpecEntryStatus): Promise<void> {
  await this.client.pages.updateProperties(page_id, {
    Status: { status: { name: status } },
  });
}
```
`resolveFilenameToPageId(filename)` (private):
1. Call `databases.query(specs_database_id, { filter: { property: 'Filename', rich_text: { equals: filename } } })`
2. Return `results[0].id` if found
3. Return `undefined` and log `notion_spec.filename_lookup_failed` at `warn` level if not found; callers skip the relation update gracefully
`parseFrontmatter(spec_path)` (private): reads the file, extracts the YAML block between `---` delimiters, parses with the `yaml` package (already a project dependency). Returns a map (`Record<string, unknown>`) of all YAML frontmatter fields. Callers access specific keys by name with appropriate type coercion (e.g., `String(frontmatter['specced_by'] ?? '')`). Returns `{}` gracefully if frontmatter is absent or the YAML block is empty.
**ImplementationFeedbackPage changes**
`NotionImplementationFeedbackPage` constructor gains `testing_guides_database_id: string` as a **second positional parameter**, consistent with how `parent_page_id` was positional in `NotionPublisher`. The `options` parameter (currently `{ logDestination? }`) is unchanged.
Updated interface:
```typescript
// src/adapters/notion/implementation-feedback-page.ts
export type TestingGuideStatus =
  | 'Not started'
  | 'In progress'
  | 'Waiting on feedback'
  | 'Approved';

export interface ImplementationFeedbackPage {
  create(
    spec_page_id: string,    // was parent_page_id; now sets the Spec relation
    spec_page_url: string,
    spec_title: string,      // new — for the Title property ("Testing guide: {spec_title}")
    summary: string,
    testing_instructions: string,
  ): Promise<string>;
  readFeedback(page_id: string): Promise<FeedbackItem[]>;
  update(
    page_id: string,
    options: {
      summary?: string;
      resolved_items?: Array<{ id: string; resolution_comment: string }>;
    },
  ): Promise<void>;
  updateStatus?(page_id: string, status: TestingGuideStatus): Promise<void>; // new
  setPRLink?(page_id: string, pr_url: string): Promise<void>;                // new
}
```
`create()` changes:
- `parent` changes to `{ type: 'database_id', database_id: testing_guides_database_id }`
- `properties` set: `Title` (title: "Testing guide: \{spec_title\}"), `Spec` (relation: `[{ id: spec_page_id }]`), `Status` (status: `"Not started"`)
- `children` (page body blocks) unchanged: bookmark, Summary, Testing instructions, Feedback sections
`updateStatus(page_id, status)` (new): calls `pages.updateProperties(page_id, { Status: { status: { name: status } } })`.
`setPRLink(page_id, pr_url)` (new): calls `pages.updateProperties(page_id, { 'PR link': { url: pr_url } })`.
**Orchestrator changes**
All new `updateStatus` and `setPRLink` calls are best-effort: errors are logged at `error` level but do not transition the run to `failed` and do not abort subsequent steps.
In `_startSpecPipeline`, after `transition(run, 'reviewing_spec')`:
```typescript
await this.deps.specPublisher.updateStatus?.(publisher_ref, 'Waiting on feedback').catch(err =>
  this.logger.error({ event: 'run.status_update_failed', run_id: run.id, status: 'Waiting on feedback', error: String(err) }, 'Failed to update spec status'),
);
```
In `_handleSpecFeedback`, after `transition(run, 'speccing')`:
```typescript
await this.deps.specPublisher.updateStatus?.(run.publisher_ref, 'Speccing').catch(err =>
  this.logger.error({ event: 'run.status_update_failed', run_id: run.id, status: 'Speccing', error: String(err) }, 'Failed to update spec status'),
);
```
In `_handleSpecApproval`, after `specCommitter.commit()` succeeds:
```typescript
await this.deps.specPublisher.updateStatus?.(run.publisher_ref, 'Approved').catch(err =>
  this.logger.error({ event: 'run.status_update_failed', run_id: run.id, status: 'Approved', error: String(err) }, 'Failed to update spec status'),
);
```
In `_runImplementation`, before `implementer.implement()`:
```typescript
if (run.impl_feedback_ref) {
  await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'In progress').catch(err =>
    this.logger.error({ event: 'run.status_update_failed', run_id: run.id, status: 'In progress', error: String(err) }, 'Failed to update testing guide status'),
  );
}
```
In `_runImplementation`, after implementation completes (before `transition(run, 'reviewing_implementation')`):
```typescript
if (run.impl_feedback_ref) {
  await this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'Waiting on feedback').catch(err =>
    this.logger.error({ event: 'run.status_update_failed', run_id: run.id, status: 'Waiting on feedback', error: String(err) }, 'Failed to update testing guide status'),
  );
}
```
In `_handleImplementationApproval`, after `prCreator.createPR()` succeeds:
```typescript
if (run.impl_feedback_ref) {
  await Promise.allSettled([
    this.deps.implFeedbackPage?.setPRLink?.(run.impl_feedback_ref, prUrl),
    this.deps.implFeedbackPage?.updateStatus?.(run.impl_feedback_ref, 'Approved'),
    this.deps.specPublisher.updateStatus?.(run.publisher_ref!, 'Complete'),
  ]).then(results => {
    for (const r of results) {
      if (r.status === 'rejected') {
        this.logger.error({ event: 'run.status_update_failed', run_id: run.id, error: String(r.reason) }, 'Failed to update status on implementation approval');
      }
    }
  });
}
```
Updated `implFeedbackPage.create()` call in `_runImplementation` (adds `spec_title`):
```typescript
const pageId = await this.deps.implFeedbackPage!.create(
  run.publisher_ref!,             // spec_page_id — for Spec relation
  specPageUrl,
  titleFromPath(run.spec_path!),  // spec_title — new parameter
  result.summary ?? '',
  result.testing_instructions ?? '',
);
```
`titleFromPath` is already imported from `canvas-publisher.ts` in `orchestrator.ts` via the `SpecPublisher` import chain; add the direct import if not already present.
**`src/index.ts`**** changes**
Replace `parent_page_id` validation with:
```typescript
const specsDatabaseId = currentConfig.config.notion.specs_database_id;
const testingGuidesDatabaseId = currentConfig.config.notion.testing_guides_database_id;
if (!specsDatabaseId || !testingGuidesDatabaseId) {
  logger.error(
    { event: 'config.parse_error' },
    'notion.specs_database_id and notion.testing_guides_database_id are required in WORKFLOW.md',
  );
  process.exit(1);
}
```
Derive `repo_name` from the already-resolved `repo_url`, taking the last two path segments to produce the `org/repo` format:
```typescript
const segments = repo_url.replace(/\.git$/, '').split('/');
const repo_name = segments.slice(-2).join('/') || 'unknown';
```
For example: `https://github.com/acme-org/autocatalyst` → `acme-org/autocatalyst`; `git@github.com:acme-org/autocatalyst.git` → `acme-org/autocatalyst`.
Updated constructors:
```typescript
specPublisher = new NotionPublisher(notionClient, boltApp, specsDatabaseId, { repo_name });
implFeedbackPage = new NotionImplementationFeedbackPage(notionClient, testingGuidesDatabaseId);
```
### 4. Security, privacy, and compliance

No new secrets or credentials. `specs_database_id` and `testing_guides_database_id` are non-sensitive Notion database IDs stored plainly in `WORKFLOW.md` — they are workspace-internal identifiers, not authentication credentials.
Frontmatter values written to Notion properties (`specced_by`, `implemented_by`) are already visible in the spec Markdown body; writing them to structured properties does not expand the data surface.
All other security, privacy, and compliance characteristics are inherited from the parent feature unchanged.
### 5. Observability

New stable log events (all components use `createLogger()` from `src/core/logger.ts`):
<table header-row="true">
<tr>
<td>Event</td>
<td>Level</td>
<td>Component</td>
</tr>
<tr>
<td>`notion_spec.properties_created`</td>
<td>info</td>
<td>notion-publisher</td>
</tr>
<tr>
<td>`notion_spec.properties_updated`</td>
<td>info</td>
<td>notion-publisher</td>
</tr>
<tr>
<td>`notion_spec.status_updated`</td>
<td>info</td>
<td>notion-publisher</td>
</tr>
<tr>
<td>`notion_spec.filename_lookup_failed`</td>
<td>warn</td>
<td>notion-publisher</td>
</tr>
<tr>
<td>`notion_testing_guide.created`</td>
<td>info</td>
<td>implementation-feedback-page</td>
</tr>
<tr>
<td>`notion_testing_guide.status_updated`</td>
<td>info</td>
<td>implementation-feedback-page</td>
</tr>
<tr>
<td>`notion_testing_guide.pr_link_set`</td>
<td>info</td>
<td>implementation-feedback-page</td>
</tr>
<tr>
<td>`run.status_update_failed`</td>
<td>error</td>
<td>orchestrator</td>
</tr>
</table>
`notion_spec.filename_lookup_failed` includes the `filename` that could not be resolved so operators can diagnose broken `supersedes` / `superseded_by` links. `run.status_update_failed` includes `run_id` and the target `status` so failed transitions are traceable without failing the run.
### 6. Testing plan

All tests use Vitest. `NotionClient` is injectable and mocked with `vi.fn()`. Existing test structure and helper patterns from the parent feature apply unchanged. The mock client helper in each test file must be extended to include the new `pages.updateProperties` and `databases.query` methods.
---
**`NotionClient`**** additions**
- `pages.updateProperties` calls `pages.update()` with the page_id and properties payload; the exact payload is passed through unchanged
- `pages.updateProperties` propagates rejection from the SDK `pages.update()` call
- `databases.query` calls `databases.query()` with the database_id and filter; returns the `results` array from the SDK response
- `databases.query` called without a filter: passes an empty or absent body (does not error)
- `databases.query` propagates rejection from the SDK
---
**`NotionPublisher`**
*`parseFrontmatter()`** — private helper*
- File with all expected frontmatter fields present: returns `Record<string, unknown>` containing each field
- File with no frontmatter block (no `---` delimiters): returns `{}`
- File with empty frontmatter block (`---\n---`): returns `{}`
- File with only some fields set: returns a map containing only the present fields; missing keys are absent from the map (callers coerce via `?? null`)
- `issue: null` in YAML: value in map is `null`
- `issue: 42` in YAML: value in map is the number `42` (not a string)
- File with extra/unknown frontmatter fields: all fields appear in the returned map (flexible — no field list is hard-coded)
- YAML parse error: throws or returns `{}`; `create()` continues with empty properties (no crash)
*`create()`** — database entry*
- Calls `pages.create` with `parent: { database_id: specs_database_id }`, not `page_id`
- Title property derived from filename via `titleFromPath`
- Filename property set to `basename(spec_path)` (e.g., `feature-setup-wizard.md`)
- Status property set to `"Speccing"`
- Specced by property set from `frontmatter['specced_by']`
- `repo_name` provided in options: `Repo / Codebase` select property included with the provided value
- `repo_name` absent from options: `Repo / Codebase` key omitted from `properties`
- `issue` non-null in frontmatter: `Issue #` number property included
- `issue` null in frontmatter: `Issue #` key omitted from `properties`
- Last updated property set from `frontmatter['last_updated']`
- `implemented_by` non-null in frontmatter: `Implemented by` rich_text property included
- `implemented_by` null/absent: `Implemented by` key omitted
- `supersedes` set in frontmatter: `resolveFilenameToPageId()` called; `Superseded by / Supersedes` relation set when found
- `supersedes` filename not found in database: `notion_spec.filename_lookup_failed` logged at warn; relation key omitted; `pages.create` still called and succeeds
- Markdown write and Slack postMessage behavior unchanged from parent feature tests
*`update()`** — property sync*
- After Markdown write, calls `pages.updateProperties()` with `last_updated` and `implemented_by` from updated frontmatter
- `implemented_by` absent from frontmatter on update: `pages.updateProperties()` still called; `implemented_by` key omitted from properties payload
- `superseded_by` newly set in frontmatter: calls `pages.updateProperties()` with Status `"Superseded"` and resolved relation
- `superseded_by` set but filename not found in DB: `updateProperties` still called for `last_updated`/`implemented_by`; Status NOT set to `"Superseded"`; `notion_spec.filename_lookup_failed` logged
- Frontmatter unchanged between calls: `pages.updateProperties()` is still called (no diffing — always syncs tracked fields)
*`updateStatus()`*
- Calls `pages.updateProperties(page_id, { Status: { status: { name: status } } })` with the provided status string
- Throws if `pages.updateProperties` rejects
- Logs `notion_spec.status_updated` with `page_id` and `status`
- Called with each valid `SpecEntryStatus` value: correct name string passed through in each case
*`resolveFilenameToPageId()`*
- Returns page ID of first result when database query returns one or more matches
- Multiple results: returns `results[0].id` (first match only)
- Empty results array: returns `undefined` and logs `notion_spec.filename_lookup_failed` with the filename
- `databases.query` rejects: exception propagates to the caller
---
**`NotionImplementationFeedbackPage`**
*Constructor*
- `testing_guides_database_id` passed as second positional argument: stored on instance and used in `create()`
- Options still accepted as third argument: `logDestination` routed to logger as before
*`create()`** — database entry*
- Calls `pages.create` with `parent: { type: 'database_id', database_id: testing_guides_database_id }`
- Title property set to `"Testing guide: {spec_title}"`
- Spec relation property set to `[{ id: spec_page_id }]`
- Status property set to `"Not started"`
- `children` (page body blocks) unchanged: bookmark, Summary, Testing instructions, Feedback sections
- Returns `page_id` from response
- `spec_title` with special characters (e.g., colons, slashes): passed through to title without modification
*`updateStatus()`*
- Calls `pages.updateProperties(page_id, { Status: { status: { name: status } } })`
- Throws if rejects; logs `notion_testing_guide.status_updated`
- Called with each valid `TestingGuideStatus` value: correct name string passed through
*`setPRLink()`*
- Calls `pages.updateProperties(page_id, { 'PR link': { url: pr_url } })`
- Throws if rejects; logs `notion_testing_guide.pr_link_set`
- `pr_url` passed through verbatim
---
**`repo_name`**** derivation**
These tests live in the `src/index.ts` config block or a dedicated unit for the derivation helper:
- HTTPS URL without `.git`: `https://github.com/acme-org/autocatalyst` → `acme-org/autocatalyst`
- HTTPS URL with `.git`: `https://github.com/acme-org/autocatalyst.git` → `acme-org/autocatalyst`
- SSH URL with `.git`: `git@github.com:acme-org/autocatalyst.git` → `acme-org/autocatalyst`
- SSH URL without `.git`: `git@github.com:acme-org/autocatalyst` → `acme-org/autocatalyst`
- URL with only one path segment (e.g., `https://selfhosted/repo`): `slice(-2)` falls back gracefully; result is `repo` (single segment joined)
**Config validation (startup)**
- `specs_database_id` present, `testing_guides_database_id` absent: process exits with a config error naming both fields
- `specs_database_id` absent, `testing_guides_database_id` present: same exit
- Both absent: same exit
- Both present: no exit; constructors called with correct IDs
- `notion` block absent entirely: `SlackCanvasPublisher` used; no `NotionPublisher` or `NotionImplementationFeedbackPage` constructed
---
**`Orchestrator`**** — status update call-sites**
- After `reviewing_spec` transition in `_startSpecPipeline`: `updateStatus('Waiting on feedback')` called; failure logged but run state machine continues to next step
- After `speccing` transition in `_handleSpecFeedback`: `updateStatus('Speccing')` called; failure logged but run continues
- After `specCommitter.commit()` succeeds in `_handleSpecApproval`: `updateStatus('Approved')` called; failure logged but run continues
- In `_runImplementation` before `implementer.implement()`: `implFeedbackPage.updateStatus('In progress')` called if `impl_feedback_ref` is set; if `impl_feedback_ref` is not set, `updateStatus` is not called
- `updateStatus` rejects at any call-site: `run.status_update_failed` logged with `run_id` and target `status`; the pipeline step that follows the `.catch()` still executes — the rejection does not propagate
- In `_handleImplementationApproval` after PR created: `specPublisher.updateStatus('Complete')`, `implFeedbackPage.updateStatus('Approved')`, `implFeedbackPage.setPRLink(prUrl)` called via `Promise.allSettled`; one rejection does not prevent the other two from executing; each rejection individually logged
- `specPublisher` is `SlackCanvasPublisher` (no `updateStatus` method): optional chaining short-circuits; `updateStatus` is never invoked; no error thrown; run behaves identically to before
---
**Manual acceptance testing**
- Seed an idea; confirm: (1) a new entry appears in the Specs database with Status "Speccing", correct Title, Filename, Specced by, Repo/Codebase (in `org/repo` format), Last updated; (2) a link appears in the Slack thread as before
- After Autocatalyst stops revising (goes to `reviewing_spec`): confirm Specs entry Status is now "Waiting on feedback"
- @mention `@ac` with feedback; confirm: (1) Specs entry Status flips to "Speccing" while revising, then back to "Waiting on feedback" when done
- Approve the spec; confirm: (1) Specs entry Status is "Approved"; (2) a new Testing guides database entry appears with Status "Not started", correct Title (`Testing guide: <spec title>`), and Spec relation pointing to the Specs entry; (3) Specs entry shows the Testing guide relation populated automatically (dual-property sync)
- Seed a new spec with `supersedes: <old-spec-filename>` in its frontmatter; confirm: (1) the Superseded by / Supersedes relation is populated on both entries; (2) the old spec's Status is "Superseded" automatically on the next revision cycle
- Seed a spec with no `issue` field in frontmatter; confirm: Issue # property is absent from the Specs database entry (not set to 0 or blank)
- After spec approval, confirm `implemented_by` sync: set `implemented_by` in frontmatter and trigger a revision; confirm the Notion property updates
- Approve implementation; confirm: (1) Testing guides entry PR link is set to the correct PR URL; (2) Testing guides entry Status is "Approved"; (3) Specs entry Status is "Complete"
- Configure the service with an HTTPS `repo_url` (e.g., `https://github.com/acme-org/autocatalyst`); confirm Repo/Codebase reads `acme-org/autocatalyst`
- Configure the service with an SSH `repo_url` (e.g., `git@github.com:acme-org/autocatalyst.git`); confirm same `acme-org/autocatalyst` value
- Revoke the Notion integration token during an active run; confirm: `run.status_update_failed` appears in logs; the run continues and Slack interaction is unaffected
- Configure the service without a `notion` block (fallback to `SlackCanvasPublisher`); confirm no status update calls are made and behavior is identical to before this enhancement
### 7. Alternatives considered

**Database IDs on the ****`Run`**** object**: Storing `specs_database_id` and `testing_guides_database_id` on the `Run` struct was considered to avoid passing them through constructors. Rejected — these are service-level configuration constants, not per-run values. Keeping them in constructors follows the existing `parent_page_id` pattern and avoids bloating the persisted run state.
**Single ****`createInDatabase()`**** method on ****`SpecPublisher`**: Adding a `createInDatabase()` method to the `SpecPublisher` interface was considered to make the database-vs-page distinction explicit at the interface level. Rejected — `SpecPublisher` is implemented by `SlackCanvasPublisher`, which has no database concept. Confining the database logic to `NotionPublisher`'s `create()` keeps the shared interface stable.
**Rolling status updates into ****`update()`**: Bundling all status transitions into `update()` was partially adopted — `"Superseded"` transitions are derived from frontmatter and handled there because the frontmatter is already being read. Point-in-time transitions (`"Speccing"`, `"Waiting on feedback"`, `"Approved"`, `"Complete"`) remain Orchestrator-driven because they depend on pipeline stage events, not content diffs.
**Validating database schema at startup**: Querying the Notion database schema at startup to verify property names was considered. Rejected — adds latency at startup, creates a dependency on the schema query API, and would fail the service entirely on any schema drift. Surfacing mismatches as run-time errors (with clear log events) provides an equivalent operator signal without the startup cost.
**`repo_name`**** as positional parameter on ****`NotionPublisher`**: Keeping `repo_name` as a fourth positional argument was considered. Rejected — `repo_name` is a presentational concern (one optional Notion property), not a core operational dependency. Placing it in options keeps the positional signature stable at `(client, app, specs_database_id)` and makes the constructor consistent with how `SlackCanvasPublisher` and `NotionPublisher` currently differ only by their third positional arg.
### 8. Risks

**Notion database schema drift**: If the Specs or Testing guides database schemas are modified (properties renamed or removed), `pages.create()` or `pages.updateProperties()` will return a 400 validation error from Notion. Mitigation: document the expected schema in the operator setup guide; schema errors surface as run failures with the Notion error message in the logs.
**Filename uniqueness assumption**: `resolveFilenameToPageId()` uses the first result from the database query. If two Specs entries share the same `Filename` value (which should not occur by convention), the wrong entry is linked. Mitigation: spec filenames are unique by the workspace convention enforced by the spec generator; document this requirement for manual entries created directly in Notion.
**Best-effort status updates**: All `updateStatus()` and `setPRLink()` calls in the Orchestrator are best-effort. A transient Notion API failure leaves an entry's Status stale without failing the run. Operators monitoring the database may see entries stuck at a prior status. Mitigation: `run.status_update_failed` logged at `error` level with `run_id` and target `status` for diagnosis; retrying the triggering Slack message will re-drive the status transition.
**Select option auto-creation**: Notion's select property auto-creates new options when a value not already in the option list is used. If `repo_name` produces an unexpected value or the Repo/Codebase option list is locked, the `pages.create()` call may fail or create an unintended option. Mitigation: `repo_name` is derived deterministically from `repo_url` in `org/repo` format; operators should confirm the value matches an existing option or allow auto-creation.
## Task list

- [ ] **Story: Configuration layer**
	- [x] **Task: Update ****`WorkflowConfig.notion`**** type**
		- **Description**: In `src/types/config.ts`, replace the `parent_page_id: string` field with `specs_database_id: string` and `testing_guides_database_id: string`. Remove `parent_page_id` entirely.
		- **Acceptance criteria**:
			- [x] `WorkflowConfig.notion` has `integration_token`, `specs_database_id`, and `testing_guides_database_id` fields
			- [x] `parent_page_id` field is removed
			- [x] TypeScript compiles with no errors after the change
		- **Dependencies**: None
	- [ ] **Task: Update startup validation, ****`repo_name`**** derivation, and constructors in ****`src/index.ts`**
		- **Description**: Replace `parent_page_id` validation with `specs_database_id` + `testing_guides_database_id` validation (exit with a config error if either is missing). Derive `repo_name` from `repo_url` by stripping `.git` and taking the last two path segments joined by `/`. Update `NotionPublisher` and `NotionImplementationFeedbackPage` constructor calls to use the new IDs.
		- **Acceptance criteria**:
			- [ ] Process exits with a config error if either `specs_database_id` or `testing_guides_database_id` is missing from the `notion` block
			- [ ] `repo_name` is derived as `org/repo` from HTTPS and SSH `repo_url` formats, with and without `.git` suffix
			- [ ] `NotionPublisher` constructed with `(notionClient, boltApp, specsDatabaseId, { repo_name })`
			- [ ] `NotionImplementationFeedbackPage` constructed with `(notionClient, testingGuidesDatabaseId)`
			- [ ] Unit tests cover: both IDs present (no exit), one absent (exit), both absent (exit), `notion` block absent entirely, all four `repo_url` format variants
		- **Dependencies**: "Task: Update `WorkflowConfig.notion` type"
- [ ] **Story: NotionClient API extensions**
	- [ ] **Task: Add ****`pages.updateProperties()`**** to ****`NotionClient`**
		- **Description**: Add `updateProperties(page_id: string, properties: Record<string, unknown>): Promise<void>` to the `NotionClient` interface and implement it in `NotionClientImpl` via the Notion SDK's `pages.update()` method. The properties payload is passed through unchanged.
		- **Acceptance criteria**:
			- [ ] Method added to `NotionClient` interface in `src/adapters/notion/notion-client.ts`
			- [ ] `NotionClientImpl.pages.updateProperties` calls `this.client.pages.update({ page_id, properties })` as a passthrough
			- [ ] Rejection from the SDK propagates to the caller
			- [ ] Unit tests added to `tests/adapters/notion/notion-client.test.ts`
		- **Dependencies**: None
	- [ ] **Task: Add ****`databases.query()`**** to ****`NotionClient`**
		- **Description**: Add a `databases` namespace to `NotionClient` with `query(database_id: string, filter?: unknown): Promise<{ results: Array<{ id: string; properties: Record<string, unknown> }> }>`. Implement in `NotionClientImpl` via the Notion SDK's `databases.query()` method. Calling without a filter must not error.
		- **Acceptance criteria**:
			- [ ] Method added to `NotionClient` interface
			- [ ] `NotionClientImpl.databases.query` calls the SDK and returns the `results` array shaped as specified
			- [ ] Calling without a filter does not error
			- [ ] Rejection from the SDK propagates to the caller
			- [ ] Unit tests added to `tests/adapters/notion/notion-client.test.ts`
		- **Dependencies**: None
- [ ] **Story: SpecPublisher interface extension**
	- [ ] **Task: Export ****`SpecEntryStatus`**** type and add optional ****`updateStatus?()`**** to ****`SpecPublisher`**
		- **Description**: In `src/adapters/slack/canvas-publisher.ts`, export `SpecEntryStatus` as `'Speccing' | 'Waiting on feedback' | 'Approved' | 'Complete' | 'Superseded'`. Add optional `updateStatus?(publisher_ref: string, status: SpecEntryStatus): Promise<void>` to the `SpecPublisher` interface. `SlackCanvasPublisher` must not declare this method — all call-sites use optional chaining.
		- **Acceptance criteria**:
			- [ ] `SpecEntryStatus` type exported from `canvas-publisher.ts`
			- [ ] `SpecPublisher` interface has optional `updateStatus?()` with the correct signature
			- [ ] `SlackCanvasPublisher` does not declare `updateStatus` (method absent on instances)
			- [ ] TypeScript compiles with no errors
			- [ ] Existing `canvas-publisher.test.ts` tests pass unchanged; no new tests required unless existing assertions break
		- **Dependencies**: None
- [ ] **Story: NotionPublisher database publishing**
	- [ ] **Task: Implement ****`parseFrontmatter()`**** private helper**
		- **Description**: Add a private `parseFrontmatter(spec_path: string): Record<string, unknown>` method to `NotionPublisher`. Reads the file, extracts the YAML block between the first pair of `---` delimiters, and parses it with the `yaml` package. Returns `{}` when no frontmatter block is found, the block is empty, or YAML parsing fails.
		- **Acceptance criteria**:
			- [ ] Returns all frontmatter fields as a `Record<string, unknown>` when present
			- [ ] Returns `{}` for files with no `---` delimiters, empty frontmatter block, or YAML parse error
			- [ ] `issue: null` parses as `null`; `issue: 42` parses as the number `42` (not a string)
			- [ ] Extra/unknown frontmatter fields are included in the returned map without filtering
			- [ ] Unit tests cover all cases in the Testing plan section
		- **Dependencies**: None
	- [ ] **Task: Implement ****`resolveFilenameToPageId()`**** private helper**
		- **Description**: Add a private `resolveFilenameToPageId(filename: string): Promise<string | undefined>` method to `NotionPublisher`. Queries the Specs database filtering by `Filename` equals `filename`. Returns `results[0].id` if found; returns `undefined` and logs `notion_spec.filename_lookup_failed` at warn if no results. Propagates rejection from `databases.query`.
		- **Acceptance criteria**:
			- [ ] Returns the first result's `id` when one or more results are found
			- [ ] Returns `undefined` and logs `notion_spec.filename_lookup_failed` with the filename when results are empty
			- [ ] Rejection from `databases.query` propagates to the caller (not swallowed)
			- [ ] Unit tests cover all cases in the Testing plan section
		- **Dependencies**: "Task: Add `databases.query()` to `NotionClient`"
	- [ ] **Task: Update ****`create()`**** to publish as Specs database entry with typed properties**
		- **Description**: Update `NotionPublisher.create()` to call `pages.create` with `parent: { database_id: specs_database_id }` and typed properties built from parsed frontmatter: Title, Filename, Status ("Speccing"), Specced by, Repo/Codebase (only if `repo_name` is in options), Issue # (only if non-null), Last updated, Implemented by (only if non-null), and Superseded by / Supersedes (resolved via `resolveFilenameToPageId()` if `supersedes` is set in frontmatter). Markdown write and Slack postMessage steps are unchanged.
		- **Acceptance criteria**:
			- [ ] `pages.create` called with `parent: { database_id: specs_database_id }`, not `page_id`
			- [ ] All properties set as specified in the Design changes section
			- [ ] Optional properties omitted (not set to null/empty) when their frontmatter values are absent
			- [ ] When `supersedes` filename is not found in the database, `notion_spec.filename_lookup_failed` is logged and `pages.create` still succeeds without the relation property
			- [ ] Unit tests cover all cases in the Testing plan section
		- **Dependencies**: "Task: Implement `parseFrontmatter()` private helper", "Task: Implement `resolveFilenameToPageId()` private helper", "Task: Update `WorkflowConfig.notion` type"
	- [ ] **Task: Update ****`update()`**** to sync frontmatter properties**
		- **Description**: After the existing Markdown write in `NotionPublisher.update()`, call `pages.updateProperties()` to sync `last_updated` and `implemented_by` from freshly-parsed frontmatter. If `superseded_by` is now set in frontmatter, also update Status to `"Superseded"` and set the Superseded by / Supersedes relation (resolved via `resolveFilenameToPageId()`). Always call `pages.updateProperties()` — no diffing.
		- **Acceptance criteria**:
			- [ ] `pages.updateProperties()` called after Markdown write with `last_updated` and `implemented_by`
			- [ ] `implemented_by` key omitted from payload when absent from frontmatter
			- [ ] `superseded_by` set in frontmatter: Status updated to `"Superseded"` and relation set when filename resolves
			- [ ] `superseded_by` set but filename not found: `last_updated`/`implemented_by` still synced; Status not changed; `notion_spec.filename_lookup_failed` logged
			- [ ] No diffing — `pages.updateProperties()` called even when frontmatter is unchanged
			- [ ] Unit tests cover all cases in the Testing plan section
		- **Dependencies**: "Task: Implement `parseFrontmatter()` private helper", "Task: Implement `resolveFilenameToPageId()` private helper", "Task: Add `pages.updateProperties()` to `NotionClient`"
	- [ ] **Task: Add ****`updateStatus()`**** to ****`NotionPublisher`**
		- **Description**: Add a public `updateStatus(page_id: string, status: SpecEntryStatus): Promise<void>` method to `NotionPublisher`. Calls `pages.updateProperties(page_id, { Status: { status: { name: status } } })` and logs `notion_spec.status_updated` with `page_id` and `status`. Throws if `pages.updateProperties` rejects.
		- **Acceptance criteria**:
			- [ ] Method satisfies the optional `updateStatus?()` signature on the `SpecPublisher` interface
			- [ ] Calls `pages.updateProperties` with the correct Status payload structure
			- [ ] Logs `notion_spec.status_updated` on success
			- [ ] Throws if `pages.updateProperties` rejects
			- [ ] Unit tests cover all valid `SpecEntryStatus` values and rejection propagation
		- **Dependencies**: "Task: Add `pages.updateProperties()` to `NotionClient`", "Task: Export `SpecEntryStatus` type and add optional `updateStatus?()` to `SpecPublisher`"
- [ ] **Story: ImplementationFeedbackPage database publishing**
	- [ ] **Task: Add ****`TestingGuideStatus`**** type and update ****`ImplementationFeedbackPage`**** interface**
		- **Description**: In `src/adapters/notion/implementation-feedback-page.ts`, export `TestingGuideStatus` as `'Not started' | 'In progress' | 'Waiting on feedback' | 'Approved'`. Update the `ImplementationFeedbackPage` interface: add `spec_title: string` as the third parameter to `create()`; add optional `updateStatus?(page_id: string, status: TestingGuideStatus): Promise<void>` and `setPRLink?(page_id: string, pr_url: string): Promise<void>`.
		- **Acceptance criteria**:
			- [ ] `TestingGuideStatus` type exported
			- [ ] `ImplementationFeedbackPage.create()` signature updated with `spec_title` as third parameter
			- [ ] Optional `updateStatus?()` and `setPRLink?()` added to the interface
			- [ ] TypeScript compiles with no errors
		- **Dependencies**: None
	- [ ] **Task: Update ****`NotionImplementationFeedbackPage`**** constructor and ****`create()`**** for Testing guides database**
		- **Description**: Add `testing_guides_database_id: string` as the second positional constructor parameter (before `options`). Update `create()` to post with `parent: { type: 'database_id', database_id: testing_guides_database_id }` and set typed properties: Title (`"Testing guide: {spec_title}"`), Spec relation (`[{ id: spec_page_id }]`), Status (`"Not started"`). Page body `children` (bookmark, Summary, Testing instructions, Feedback sections) are unchanged.
		- **Acceptance criteria**:
			- [ ] Constructor signature is `(client, testing_guides_database_id, options?)`
			- [ ] `create()` posts to database parent with the three required properties
			- [ ] Title passes `spec_title` through verbatim (special characters not escaped)
			- [ ] `children` blocks are unchanged from the current implementation
			- [ ] Returns `page_id` from the Notion response
			- [ ] Unit tests cover all cases in the Testing plan section
		- **Dependencies**: "Task: Add `TestingGuideStatus` type and update `ImplementationFeedbackPage` interface"
	- [ ] **Task: Implement ****`updateStatus()`**** and ****`setPRLink()`**** on ****`NotionImplementationFeedbackPage`**
		- **Description**: Implement `updateStatus(page_id, status)` by calling `pages.updateProperties(page_id, { Status: { status: { name: status } } })` and logging `notion_testing_guide.status_updated`. Implement `setPRLink(page_id, pr_url)` by calling `pages.updateProperties(page_id, { 'PR link': { url: pr_url } })` and logging `notion_testing_guide.pr_link_set`. Both throw if `pages.updateProperties` rejects.
		- **Acceptance criteria**:
			- [ ] `updateStatus()` calls `pages.updateProperties` with the correct Status payload
			- [ ] `setPRLink()` calls `pages.updateProperties` with the correct `PR link` payload
			- [ ] Both log the appropriate event on success
			- [ ] Both throw on rejection from `pages.updateProperties`
			- [ ] Unit tests cover all valid `TestingGuideStatus` values, PR link passthrough, and rejection cases
		- **Dependencies**: "Task: Add `TestingGuideStatus` type and update `ImplementationFeedbackPage` interface", "Task: Add `pages.updateProperties()` to `NotionClient`"
- [ ] **Story: Orchestrator status transitions**
	- [ ] **Task: Wire spec lifecycle status update call-sites**
		- **Description**: In `src/core/orchestrator.ts`, add best-effort `specPublisher.updateStatus?.()` calls using optional chaining + `.catch()` at three points: after `transition(run, 'reviewing_spec')` in `_startSpecPipeline` (→ "Waiting on feedback"), after `transition(run, 'speccing')` in `_handleSpecFeedback` (→ "Speccing"), and after successful `specCommitter.commit()` in `_handleSpecApproval` (→ "Approved"). Each failure logs `run.status_update_failed` with `run_id` and target `status` but does not abort the run.
		- **Acceptance criteria**:
			- [ ] `updateStatus('Waiting on feedback')` called after `reviewing_spec` transition
			- [ ] `updateStatus('Speccing')` called after `speccing` transition
			- [ ] `updateStatus('Approved')` called after successful `specCommitter.commit()`
			- [ ] Each rejection logs `run.status_update_failed` with `run_id` and `status`; rejection does not propagate to the run state machine
			- [ ] When `specPublisher` is `SlackCanvasPublisher` (no `updateStatus`), optional chaining short-circuits with no error
			- [ ] Unit tests added to `tests/core/orchestrator.test.ts` for each call-site and for rejection behavior
		- **Dependencies**: "Task: Add `updateStatus()` to `NotionPublisher`", "Task: Export `SpecEntryStatus` type and add optional `updateStatus?()` to `SpecPublisher`"
	- [ ] **Task: Wire implementation lifecycle status update call-sites**
		- **Description**: In `src/core/orchestrator.ts`, add best-effort `implFeedbackPage.updateStatus?.()` calls: before `implementer.implement()` in `_runImplementation` (→ "In progress", only if `impl_feedback_ref` is set), and after implementation completes before `transition(run, 'reviewing_implementation')` (→ "Waiting on feedback"). Add a `Promise.allSettled` block in `_handleImplementationApproval` after a successful PR creation that calls `setPRLink`, `implFeedbackPage.updateStatus('Approved')`, and `specPublisher.updateStatus('Complete')`; log each rejection individually.
		- **Acceptance criteria**:
			- [ ] `implFeedbackPage.updateStatus('In progress')` called before `implementer.implement()` when `impl_feedback_ref` is set; not called when unset
			- [ ] `implFeedbackPage.updateStatus('Waiting on feedback')` called after implementation completes
			- [ ] `Promise.allSettled` in `_handleImplementationApproval` calls all three updates; one rejection does not prevent the other two
			- [ ] Each rejection individually logged with `run.status_update_failed`
			- [ ] Unit tests added to `tests/core/orchestrator.test.ts` for each call-site and rejection behavior
		- **Dependencies**: "Task: Implement `updateStatus()` and `setPRLink()` on `NotionImplementationFeedbackPage`", "Task: Add `updateStatus()` to `NotionPublisher`"
	- [ ] **Task: Update ****`implFeedbackPage.create()`**** call with new ****`spec_title`**** parameter**
		- **Description**: In `_runImplementation` in `src/core/orchestrator.ts`, update the `implFeedbackPage.create()` call to pass `titleFromPath(run.spec_path!)` as the new third `spec_title` argument. Add a direct import for `titleFromPath` from `canvas-publisher.ts` if it is not already available in scope.
		- **Acceptance criteria**:
			- [ ] `implFeedbackPage.create()` called with `(run.publisher_ref!, specPageUrl, titleFromPath(run.spec_path!), result.summary ?? '', result.testing_instructions ?? '')`
			- [ ] `titleFromPath` imported and available in `orchestrator.ts`
			- [ ] TypeScript compiles with no errors
			- [ ] Existing orchestrator tests updated to include `spec_title` in mock expectations
		- **Dependencies**: "Task: Add `TestingGuideStatus` type and update `ImplementationFeedbackPage` interface"