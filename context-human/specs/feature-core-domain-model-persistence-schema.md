---
created: 2026-06-08
last_updated: 2026-06-08
status: implementing
issue: 11
specced_by: markdstafford
---
# Feature: Core domain model and persistence schema

## Product requirements

### What

Add Autocatalyst's normalized persistence schema for the core domain entities. From an empty SQLite database, migrations should create the full set of domain tables defined by `context-human/concepts/domain-model.md`, and each major entity should be writable and readable through a typed repository.
This feature is the storage layer for the product's noun model: projects, conversations, topics, messages, runs, artifacts, feedback, publications, pull requests, run steps, sessions, and test results. It also embeds value objects that belong to exactly one parent row, such as session cost, token breakdowns, feedback anchors, feedback threads, channel references, and testing-guide results.
### Why

Autocatalyst needs durable, queryable records before later workflow, orchestration, review, cost, and API features can behave consistently. The control plane already has the SQLite, Drizzle, migration, and repository foundation; this feature fills that foundation with the domain schema every later capability relies on.
The design must follow the existing human decisions rather than inventing a parallel model. ADR-013 fixes the entity names, ADR-014 fixes the `Conversation -> Topic -> Run` hierarchy and one-active-run invariant, ADR-017 fixes the single artifact model, ADR-018 makes feedback first-class, and ADR-019 fixes the normalized-table versus embedded-value-object boundary.
### Goals

- Add Drizzle table definitions for every entity that `domain-model.md` marks as a table.
- Preserve the committed work hierarchy: `Project -> Conversation -> Topic -> Run`, with `Message` belonging to a `Topic`.
- Enforce one main `Topic` per initialized `Conversation`; a conversation may be transiently topicless immediately after creation, but persistence must reject a second main topic.
- Enforce at most one active, non-terminal `Run` per `Topic` with a database uniqueness constraint.
- Represent the single `Artifact` model with kind, canonical record, operational location, linked issue, publications, and cached status fields.
- Represent `Feedback` as a run-parented, reopenable entity with target, lifecycle, optional anchor, and embedded attributed thread.
- Represent `Publication`, `PR`, `RunStep`, `Session`, and `TestResult` as run-parented rows.
- Embed value objects as JSON columns when they have no independent identity or lifecycle.
- Carry `owner` and `tenant` on major entities and avoid duplicating them on parent-hung records that inherit attribution.
- Add shared Zod contract schemas and inferred TypeScript types for the persisted entities.
- Add core repository interfaces and persistence implementations for the persisted entities.
- Generate and commit Drizzle migrations that build the schema from an empty database.
- Prove repository round trips for each entity in tests, including owner, tenant, relationships, and embedded value objects.
- Update `context-agent/wiki/code-map.md` during implementation with the new schema, contract, and repository modules.
### Non-goals

- Implementing the run lifecycle, workflow step machine, state transitions, or orchestration rules beyond schema-level constraints.
- Adding public API routes, SDK methods, or policy behavior for these entities.
- Building a UI for conversations, runs, feedback, costs, or artifacts.
- Computing costs, pricing sessions, or adding rollup queries beyond storing the `Session` cost value object.
- Adding cached `aggregateCost` columns, which `domain-model.md` explicitly defers.
- Adding a general anything-to-anything linking model.
- Creating new entities beyond the catalog in `domain-model.md`.
- Backfilling data from existing databases beyond applying migrations to an empty or current development database.
### Personas

- **Enzo (Engineer)** needs typed domain repositories so later orchestration and API work can persist records without writing raw SQL in feature code.
- **Phoebe (PM)** needs confidence that Autocatalyst's core concepts are now durable product records, not only documentation.
- **Opal (Operator)** needs migrations that can initialize a clean database predictably and constraints that prevent duplicate active work.
- **Dani (Designer)** is not a direct user of this backend-only feature, but future review and status surfaces depend on stable entity shapes.
### User stories

- As Enzo, I can create a `Project`, `Conversation`, `Topic`, and `Run` through repositories and read them back with their relationships intact.
- As Enzo, I can write a `Message` attributed to a `Principal` and know it belongs to the topic that received it.
- As Enzo, I can persist an `Artifact` for a run with its kind, canonical record location, cached status, and linked issue reference.
- As Enzo, I can persist `Feedback` with a target, lifecycle state, optional anchor, and attributed thread entries.
- As Enzo, I can persist `Publication`, `PR`, `RunStep`, `Session`, and `TestResult` records that hang off a run.
- As Opal, I can apply migrations to a fresh database and get the complete domain schema without manual setup.
- As Opal, I can rely on the database to reject a second non-terminal run for the same topic.
- As Phoebe, I can see tests prove that every entity in the domain-model catalog has a create-then-read-back path.
### Acceptance criteria

#### Schema coverage

- `packages/persistence/src/schema.ts` defines tables for `Project`, `Conversation`, `Topic`, `Message`, `Run`, `Artifact`, `Feedback`, `Publication`, `PR`, `RunStep`, `Session`, and `TestResult`.
- Table and column names are consistent with existing persistence conventions and with the names in `domain-model.md`.
- Parent relationships are represented with foreign keys where the current Drizzle/SQLite setup supports them.
- Required lifecycle/status fields are stored as constrained string values where practical, except run workflow position: `Run.currentStep` remains an extensible string owned by the run-machine feature.
- The run-to-issue reference is represented as a typed `TrackedIssue` value with `number`, `title`, `state`, and `url`, and the schema leaves room to resolve it by foreign key once issues are stored.
- The topic schema rejects a second `main` topic for the same conversation while allowing side topics.
- The pull-request schema rejects a second PR row for the same run.
#### Value-object embedding

- `Session` embeds `Cost` as JSON, including model identity, optional integer nano-dollar `usd` for known costs, and token breakdown.
- `Feedback` embeds its optional anchor and attributed thread as JSON.
- `Run` embeds the testing-guide result value object if the field is represented in this feature.
- Channel references and other owned value objects are embedded rather than promoted to standalone tables.
- No value object gets its own table unless the domain model marks it as independently findable, filterable, or lifecycle-bearing.
#### Ownership and tenancy

- `Project`, `Conversation`, `Topic`, `Message`, `Run`, `Artifact`, `Feedback`, `Publication`, and `PR` carry `owner` and `tenant` on the row.
- `RunStep`, `Session`, and `TestResult` inherit ownership and tenancy from their parent run and do not duplicate those fields.
- Stored owner values use the existing `Principal` contract shape from `@autocatalyst/api-contract`, constrained to non-model principals (`human` or `system`).
- The persisted tenant field is named `tenant` at the contract layer and is a non-empty string. For every row that stores both `owner` and `tenant`, repository validation must require `tenant === owner.tenantId`; parent-hung records inherit that tenant through their parent run.
- Repository tests assert that owner and tenant survive round trips for every major entity and that model principals are rejected as owners.
#### One-active-run invariant

- The database enforces at most one non-terminal run per topic.
- Terminal runs are excluded from the uniqueness constraint by the persisted terminal discriminator.
- A test creates one non-terminal run for a topic and asserts that creating a second non-terminal run for the same topic fails at the persistence boundary.
- The invariant is keyed on `Topic`, not on conversation, issue, message, or run step.
#### One-main-topic invariant

- The database enforces at most one `main` topic per conversation.
- Repository tests create the initialized conversation shape with exactly one main topic.
- A test creates one main topic for a conversation and asserts that creating a second main topic for the same conversation fails at the persistence boundary.
- A test proves side topics are still allowed for the same conversation.
- The invariant is keyed on `Conversation`, not on project, active-topic pointer, message, or run.
#### One-PR-per-run invariant

- This feature models `PR` as one-to-one with `Run`.
- The database enforces at most one PR row per run with a unique `runId` constraint.
- `PullRequestRepository.findByRun(runId)` returns the single PR for a run or `null`.
- A test creates one PR for a run and asserts that creating a second PR for the same run fails at the persistence boundary.
#### Contracts and repositories

- Entity Zod schemas and inferred types exist under `packages/api-contract/src`, following the existing contract-package style.
- Core repository interfaces exist under `packages/core/src` and do not import Drizzle internals.
- Drizzle repository implementations exist under `packages/persistence/src` and implement the core interfaces.
- Repositories expose the create/read methods needed for round-trip tests without adding broad query APIs that later features have not requested.
- `ConversationRepository.setActiveTopic` is the only update method added in this feature and exists only to maintain the authoritative active-topic pointer after topic creation.
- Package public entrypoints export the new contracts and repository interfaces needed by dependent packages.
#### Migrations and tests

- Generated Drizzle migration files are committed under `packages/persistence/drizzle`.
- `migrateSqliteDatabase` can apply the migrations to a fresh temp database created with the existing temp-database test helper pattern.
- Each entity has a create-then-read-back test through its repository.
- Round-trip tests cover embedded value objects where present.
- Tests cover the duplicate-active-run rejection path.
- The full workspace test suite passes after implementation, or any skipped checks are documented with the reason.
## Design spec

### Design scope

This is a backend-only foundation feature. There is no visual UI, human-facing interaction flow, or settings screen in this pass.
The design work is the developer and service experience: how future Autocatalyst code creates durable domain records, how tests prove the schema is complete, and how constraints make invalid domain states hard to persist.
### Developer experience

A developer should be able to work with the domain model without reading persistence internals.
1. Import entity contract types from `@autocatalyst/api-contract`.
2. Import repository interfaces from `@autocatalyst/core`.
3. Use repository methods to create and read records.
4. Let `@autocatalyst/persistence` provide Drizzle-backed implementations.
5. Rely on migrations to create the database shape before repositories run.
The public seam should mirror existing repository patterns such as `ProbeResourceRepository` and `ConfigurationRecordRepository`. Domain features that come later should not need to import `packages/persistence/src/schema.ts` or Drizzle query builders directly.
### Service behavior

The service should preserve the existing control-plane boot sequence. Startup opens SQLite, runs migrations, composes repositories, and then registers routes.
This feature does not need to wire every repository into a public route. It only needs enough composition and tests to prove the repositories work against the migrated schema. If a repository collection object or factory is useful for tests and future startup code, it should live behind the same package boundaries as current persistence composition.
### Entity relationship design

The database should make the core hierarchy visible and enforceable.
- `Project` is the top-level scope for repository, issue-tracker, code-host, workspace, and credential settings.
- `Conversation` belongs to a `Project` and carries a channel-independent identity plus any embedded channel reference.
- `Topic` belongs to a `Conversation`, marks whether it is main or side, and can be the conversation's active topic. Exactly one main topic is allowed for an initialized conversation; because a conversation row can exist before its topics, the database enforces this as "at most one main topic" and repository tests cover the initialized one-main path plus duplicate-main rejection.
- `Message` belongs to a `Topic` and stores author, two-valued direction (`inbound` or `outbound`), body, intent, and timestamps.
- `Run` belongs to a `Topic`, records workflow/work kind, current step, a minimal terminal discriminator, optional tracked issue, and embedded testing-guide result.
- `Artifact`, `Feedback`, `Publication`, `RunStep`, `Session`, and `TestResult` belong to a `Run`; `PR` is run-owned and constrained to at most one PR row per run.
The schema should prefer explicit parent ids and indexes for queries later workflow code will need: runs by topic, messages by topic and creation time, feedback by run and target/status, sessions by run/step/role, publications by run, and the single PR by run.
### Lifecycle and status design

This feature stores lifecycle fields, but it does not own lifecycle behavior.
- `Run` stores `currentStep` as an extensible string plus a minimal terminal discriminator needed by the active-run uniqueness constraint.
- `Artifact` stores a cached operational status, while committed spec frontmatter remains the document-intrinsic source of truth.
- `Feedback` stores its reopenable lifecycle: `open`, `addressed`, `resolved`, or `wont_fix`.
- `PR` stores its provider state: `open`, `merged`, or `closed`, with a unique `runId` because this persistence feature intentionally treats PR as one-to-one with its run for all time. A run that closes a PR does not open a replacement PR under this model.
- `RunStep`, `Session`, and `TestResult` store occurrence/result state, not transition rules.
Validation should reject invalid enum values at contract/repository boundaries where practical. Run `currentStep` is the exception: it is workflow-owned and must remain an extensible string so issue #2 and ADR-015 can define the step catalog and transition rules without changing this migration.
### Value-object design

Embedded JSON should be used deliberately, not as a shortcut around modeling.
Use embedded JSON for values that are attributes of exactly one row:
- `Cost` on `Session`.
- Token breakdown inside `Cost`.
- Feedback anchor on `Feedback`.
- Feedback thread on `Feedback`.
- Channel reference on `Conversation` or related channel-bound records.
- Testing-guide result on `Run`, if represented now.
- Tracked issue reference on `Run`, unless implementation adds a dedicated stored issue row in a later feature.
These JSON values should still have Zod schemas in the contract package. Tests should prove repositories serialize and parse them without losing shape.
`Cost.usd` is nullable/optional to represent unknown cost when usage or pricing data is unavailable. `0` means a known zero nano-dollar cost; `null` or omission means unknown and must not be coerced to zero. `Session.tokens` is the session's query-friendly usage breakdown, and `Session.cost.tokens` is the same breakdown embedded with the cost snapshot. This intentionally preserves the redundancy in `domain-model.md`; contract and repository validation must reject sessions unless the two token breakdowns are identical.
### Empty state

A freshly migrated database should contain no domain rows. Repository `findById` and other single-record lookup methods should return `null` when records are absent, and list methods should return empty arrays according to existing project conventions.
The empty state is valid. The feature's proof is that migrations create the shape and repositories can write the first rows.
### Error handling

- Repository reads for missing ids should follow the current repository convention instead of throwing unexpectedly.
- Repository creates should fail clearly when required parent records do not exist.
- Duplicate non-terminal run creation should fail at the database boundary and surface as a deterministic persistence error in tests.
- JSON parse or validation failures should be treated as corrupted stored data and should not silently coerce invalid records.
- Migration failures should propagate during startup or tests, as existing persistence code does today.
### Observability and diagnostics

This feature does not add a new logging or telemetry surface. Repository errors should remain ordinary exceptions unless the existing persistence layer already wraps them.
The important diagnostic value is in tests: migration succeeds from empty state, every entity round-trips, and duplicate non-terminal runs are rejected.
## Tech spec

### Current state

The repository already has the control-plane persistence foundation:
- `packages/persistence/src/sqlite.ts` owns SQLite handles, migration application, and reachability checks.
- `packages/persistence/src/schema.ts` currently defines the internal Drizzle schema for probe resources, configuration records, secret metadata, and secrets.
- `packages/persistence/drizzle/` contains committed migrations for the current schema.
- `packages/core/src/probe-resource.ts` and `packages/persistence/src/probe-resource-repository.ts` show the repository-interface and Drizzle-implementation pattern.
- `packages/core/src/configuration-record.ts` and `packages/persistence/src/configuration-record-repository.ts` show the newer configuration repository pattern.
- `packages/api-contract/src/principal.ts` defines the `Principal` contract used for owner and author attribution.
- `context-agent/wiki/code-map.md` records the current package layout and must be updated when implementation adds modules.
The domain model and ADRs already settle the conceptual shape. This feature should implement that shape rather than reopen the product model.
### Proposed package shape

Keep the feature inside existing packages.
- `packages/api-contract/` owns Zod schemas and inferred TypeScript types for domain entities and embedded value objects.
- `packages/core/` owns repository interfaces and thin use-case helpers if needed for testable creation/read flows.
- `packages/persistence/` owns Drizzle tables, migrations, row mapping, and repository implementations.
- `apps/control-plane/` should not need public route changes for this feature.
- `packages/sdk/` should not change unless implementation unexpectedly adds API routes, which is out of scope.
Recommended contract files:
- `packages/api-contract/src/project.ts`
- `packages/api-contract/src/conversation.ts`
- `packages/api-contract/src/topic.ts`
- `packages/api-contract/src/message.ts`
- `packages/api-contract/src/run.ts`
- `packages/api-contract/src/artifact.ts`
- `packages/api-contract/src/feedback.ts`
- `packages/api-contract/src/publication.ts`
- `packages/api-contract/src/pull-request.ts`
- `packages/api-contract/src/run-step.ts`
- `packages/api-contract/src/session.ts`
- `packages/api-contract/src/test-result.ts`
- `packages/api-contract/src/domain-value-objects.ts` for shared embedded schemas, if that reduces duplication.
Recommended core files may either be one file per entity or grouped by domain area. Prefer the option that matches repository test readability and keeps exports clear.
Recommended persistence files:
- Keep Drizzle table definitions in `packages/persistence/src/schema.ts`.
- Add one repository implementation file per entity or per tightly related aggregate.
- Export repository implementations from `packages/persistence/src/index.ts`.
### Identifier and timestamp conventions

Use the existing project conventions for generated ids, timestamps, and test determinism.
- Entity ids should be opaque strings with stable prefixes where existing conventions favor prefixed ids.
- `createdAt` and `updatedAt` fields should be present on lifecycle-bearing major entities unless the domain model explicitly does not need them.
- Repository tests should use fixed timestamps or injectable clocks where needed to avoid brittle assertions.
- Foreign-key fields should use explicit names such as `projectId`, `conversationId`, `topicId`, and `runId` at the contract layer, mapped to the project's chosen SQL column naming convention in Drizzle.
### Schema details

The implementation should translate the domain model into concrete Drizzle tables. The exact column list can be refined during implementation, but it must preserve these minimum fields.
#### Project

- `id`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- `displayName`
- `repoUrl`
- `hostRepository`: structured reference with `{ provider: string, owner: string, name: string, url?: string }`, where all required strings are non-empty
- `workspaceRootOverride`: nullable absolute or workspace-relative path string; `null` means use the default workspace layout
- `issueTrackerSetting`: nullable project setting reference with `{ provider: string, projectKey?: string, url?: string, credentialRef?: CredentialReference }`
- `codeHostSetting`: nullable project setting reference with `{ provider: string, organization?: string, url?: string, credentialRef?: CredentialReference }`
- `credentialRefs`: array of credential references used by the project settings, each shaped as `{ id: string, purpose: "repo" | "issue_tracker" | "code_host" | "publisher" | "other", label?: string }`; credential refs are identifiers only and must not contain secret material
- timestamps
#### Conversation

- `id`
- `projectId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- channel-independent identity
- embedded channel reference
- active topic reference, nullable during initial creation if needed
- timestamps
`Conversation.activeTopicId` is the authoritative active-topic pointer. It is nullable only for a transient uninitialized conversation row before the first active topic is selected. After initialization, repository APIs must preserve exactly one active topic by requiring a non-null active topic pointer. `ConversationRepository.setActiveTopic(conversationId, topicId)` accepts a non-null `topicId` and is the supported way to set the first active topic or switch it after topics exist; the implementation must reject `null` and must reject a topic from a different conversation. `TopicRepository.create` must not implicitly switch the active topic.
#### Topic

- `id`
- `conversationId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- title or objective summary
- main/side marker
- no active/current marker; active status is derived from `Conversation.activeTopicId`
- timestamps
The database must reject a second `main` topic for the same `conversationId`, preferably with a partial or composite unique index scoped to rows where `kind = 'main'`. Repository tests must create the initialized one-main conversation shape and assert that duplicate main-topic creation fails.
#### Message

- `id`
- `topicId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- author `Principal`
- direction: `inbound` or `outbound`
- body/content
- optional `MessageIntent`
- creation timestamp
#### Run

- `id`
- `topicId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- work kind or workflow kind
- `currentStep` as an extensible workflow-step string
- minimal terminal discriminator used by the uniqueness constraint, stored as `terminal` boolean for now
- no closed `status` or `RunStatus` column; run vocabulary and transitions belong to ADR-015 / issue #2
- typed tracked issue reference
- embedded testing-guide result, if represented now
- timestamps
#### Artifact

- `id`
- `runId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- kind: `feature_spec`, `enhancement_spec`, `bug_triage`, or `chore_plan`
- canonical record: `file`, `issue`, `other`, or `none`
- location or operational handle
- cached status: `draft`, `ready_for_review`, `approved`, `published`, `superseded`, or `unknown`; `unknown` is used when the canonical record has no parseable status
- linked issue reference if present
- publication references if represented directly rather than queried through `Publication`
- timestamps
#### Feedback

- `id`
- `runId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- target: `artifact`, `implementation`, `docs`, or `pr`
- status: `open`, `addressed`, `resolved`, or `wont_fix`
- title or summary
- body/details
- embedded anchor
- embedded attributed thread
- timestamps
#### Publication

- `id`
- `runId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- provider
- url
- label
- `frontedResource`: `{ kind: "artifact" | "pull_request" | "issue" | "external"; id?: string; reference?: string; url?: string }`, requiring `id` for `artifact` and `pull_request`, and requiring at least one of `reference` or `url` for `issue` and `external`
- timestamps
#### PR

- `id`
- `runId`
- `owner`
- `tenant`: non-empty string equal to `owner.tenantId`
- provider
- unique `runId`; this feature stores at most one PR per run
- number
- url
- state: `open`, `merged`, or `closed`
- branch
- timestamps
#### RunStep

- `id`
- `runId`
- `phase`: extensible lower snake_case string, nullable when the step is not part of a named workflow phase
- `step`: non-empty workflow step string matching the run-machine step name stored in `Run.currentStep` when applicable
- `role`: extensible lower snake_case string using the same validation as `Session.role`
- startedAt
- endedAt
- duration if stored rather than computed
- `occurrence`: object shaped as `{ index: integer >= 0, attempt: integer >= 1, key?: string }`, where `index` distinguishes repeated appearances of the same phase/step/role tuple and `attempt` distinguishes retries
#### Session

- `id`
- `runId`
- nullable phase for bounded direct calls
- step
- role, including the `none` role for bounded direct calls
- round
- resolved model
- inference settings: object shaped as `{ temperature?: number, topP?: number, maxOutputTokens?: integer, reasoningEffort?: "low" | "medium" | "high", seed?: integer, extra?: Record }`; unknown provider-specific options must live under `extra`
- startedAt
- endedAt
- duration
- normalized token breakdown
- usage availability flag
- assistant-turn count
- tool-call count
- outcome
- embedded `Cost`
#### TestResult

- `id`
- `runId`
- tester `Principal`
- outcome: `passed`, `failed`, `blocked`, or `inconclusive`
- evidence: nullable object shaped as `{ kind: "log" | "artifact" | "publication" | "external"; id?: string; url?: string; summary?: string }`, requiring `id` for `artifact` and `publication` evidence and requiring at least one of `url` or `summary` for `log` and `external` evidence
- feedback references raised by this pass
- timestamps
### One-active-run database constraint

The database must reject two non-terminal runs for the same topic. SQLite supports partial unique indexes, which is the preferred representation if compatible with the current Drizzle setup.
Conceptual SQL:
```sql
CREATE UNIQUE INDEX runs_one_active_per_topic
ON runs(topic_id)
WHERE terminal = 0;
```
Use `terminal` as a stand-in discriminator in this feature. ADR-015 makes terminality derive from a step primitive's intrinsic `waiting_on` value (`none` means terminal), but the step-primitives catalog belongs to the run-machine work. When that catalog exists, reconcile this stored discriminator to the `waiting_on`-derived source of truth without introducing a closed run-status vocabulary here. The chosen representation must make the test obvious: two non-terminal runs for the same topic fail; a non-terminal run after a terminal run for the same topic succeeds.
### Contract schemas

Each entity should have Zod schemas for the stored response shape and create input shape needed by repositories. Keep the contract package as the shared type source; do not define separate incompatible entity shapes in core and persistence.
Recommended shared value-object schemas:
- `trackedIssueSchema`
- `costSchema`
- `tokenBreakdownSchema`
- `modelIdentitySchema`
- `feedbackAnchorSchema`
- `feedbackThreadSchema`
- `feedbackThreadEntrySchema`
- `channelReferenceSchema`
- `testingGuideResultSchema`, if represented now
Concrete value-object schema rules:
- `trackedIssueSchema`: `{ number: integer >= 1, title: non-empty string, state: "open" | "closed" | "merged" | "unknown", url: non-empty URL string }`.
- `modelIdentitySchema`: `{ provider: non-empty string, model: non-empty string, displayName?: string }`.
- `tokenBreakdownSchema`: strict object with integer `input`, `output`, `cacheRead`, and `cacheWrite` counts, all `>= 0`.
- `costSchema`: strict object with `model`, optional nullable integer nano-dollar `usd`, and `tokens`; omitted or `null` `usd` means unknown.
- `channelReferenceSchema`: `{ provider: string, channelId: string, threadId?: string, messageId?: string, url?: string, label?: string }`, with required strings non-empty. It identifies the external conversation surface and is opaque to persistence beyond this shape.
- `feedbackAnchorSchema`: discriminated object with `kind: "artifact" | "file_range" | "message" | "run_step" | "external"`. `artifact` requires `artifactId`; `file_range` requires `path` plus one-based `startLine` and `endLine`; `message` requires `messageId`; `run_step` requires `runStepId`; `external` requires `url`.
- `feedbackThreadEntrySchema`: `{ id: string, author: Principal, body: non-empty string, createdAt: timestamp string }`; `feedbackThreadSchema` is a non-empty ordered array of those entries.
- `testingGuideResultSchema`: `{ status: "not_run" | "passed" | "failed" | "blocked", summary?: string, checkedAt?: timestamp string, evidence?: TestResultEvidence[] }`.
- `inferenceSettingsSchema`: `{ temperature?: number, topP?: number, maxOutputTokens?: integer >= 1, reasoningEffort?: "low" | "medium" | "high", seed?: integer, extra?: Record }`, stored as JSON on sessions and validated without interpreting provider-specific `extra` keys.
- JSON value objects should be strict unless a field is explicitly named `extra`; values under `extra` are intentionally opaque JSON and must be JSON-serializable objects, arrays, strings, numbers, booleans, or `null`.
Schemas should reuse `principalSchema` for author, tester, and thread attribution. Owner fields should reuse a narrowed non-model principal schema that accepts `human` and `system` principals and rejects `model`; `Message.author` and other attribution fields may still accept model principals where the domain model allows generated contributions.
`sessionRoleSchema` should validate roles as extensible snake_case strings rather than a closed enum. Canonical examples include `none`, `proposer`, `reviewer`, `implementer`, `tester`, `operator`, `publisher`, and `orchestrator`, but future workflow-defined values such as mediator roles must remain schema-valid when they match the snake_case pattern.
### Repository interfaces

Start with narrow repository contracts that satisfy the acceptance criteria and avoid guessing future query needs.
A representative interface shape is:
```typescript
export interface ProjectRepository {
  create(input: CreateProjectInput): Promise;
  findById(id: string): Promise;
}
```
Apply the same simple create/read shape to the other entities. Add list methods only where tests or parent composition need them, such as listing messages by topic or feedback by run and target. Keep complex lifecycle transitions out of this feature.
The one narrow exception is `ConversationRepository.setActiveTopic(conversationId, topicId)`, which exists because a conversation can be created before its topics and active-topic switching must update the authoritative `Conversation.activeTopicId` pointer after the target topic row exists. This method accepts a non-null `topicId`, should return the updated `Conversation`, should reject `null`, and should validate that the topic belongs to the conversation.
### Persistence implementation

Drizzle repositories should perform explicit row mapping instead of leaking raw database rows to core callers.
- Serialize embedded value objects to JSON on write.
- Parse and validate embedded value objects on read.
- Convert database timestamp representations to the contract's chosen timestamp representation consistently.
- Preserve the contracts' explicit distinction between nullable fields and omitted optional fields.
- Let foreign-key and unique-constraint violations surface in tests with clear assertions.
If the amount of mapping code becomes large, introduce small mapper helpers near the persistence repositories rather than duplicating JSON parse/stringify logic across files.
### Migration generation

After updating `packages/persistence/src/schema.ts`, generate a new Drizzle migration with the existing command recorded in the code map:
```bash
pnpm drizzle-kit generate --config packages/persistence/drizzle.config.ts
```
Commit the generated SQL under `packages/persistence/drizzle/`. Do not hand-author schema changes only in tests; the migration is part of the feature's deliverable.
### Testing plan

Add targeted tests before relying on the full workspace validation.
- Contract tests for new Zod schemas, including principal reuse and value-object validation.
- Core tests for repository interface helpers if helpers are added.
- Persistence migration test that applies migrations to a fresh temp database.
- Repository round-trip tests for each entity.
- Embedded value-object round-trip tests for `Cost`, feedback anchor/thread, and tracked issue references.
- One-active-run constraint test for duplicate non-terminal runs on one topic.
- Positive one-active-run test showing a new non-terminal run can exist after the prior run is terminal.
- Main-topic constraint test showing a second main topic for the same conversation is rejected while side topics are allowed.
- Active-topic pointer test showing `ConversationRepository.setActiveTopic` updates `Conversation.activeTopicId` and rejects topics from other conversations.
- Active-topic pointer test showing an uninitialized conversation may start with `activeTopicId: null`, but `setActiveTopic` rejects `null` and initialized conversations retain a non-null active-topic pointer.
- PR uniqueness test showing a second PR for the same run is rejected and `PullRequestRepository.findByRun` returns the single run-owned PR or `null`.
- Existing package index/export tests updated for new public exports.
Then run the broader validation commands required by the repository:
```bash
pnpm nx test api-contract
pnpm nx test core
pnpm nx test persistence
pnpm validate
```
### Documentation updates

Implementation must update `context-agent/wiki/code-map.md` with:
- New contract files and exported schemas.
- New core repository interfaces or grouped domain repository module.
- New persistence schema tables and repository implementation files.
- New migration filename.
- Any useful targeted test commands discovered during implementation.
Human-owned concept docs and ADRs should not change unless implementation discovers a mismatch with the accepted decisions. If a mismatch appears, stop and surface it rather than silently changing the product model.
### Risks and open questions

- **Schema breadth:** This feature touches many entities at once. Keep repository APIs narrow so breadth does not turn into premature behavior design.
- **Run-machine ownership:** ADR-015 and issue #2 own the workflow step catalog, `waiting_on` semantics, and transition rules. This feature stores only `currentStep` plus a temporary terminal discriminator for the partial index, so the run vocabulary is not frozen in this migration.
- **SQLite partial-index support through Drizzle:** If Drizzle cannot express the partial unique index cleanly, use the least surprising migration-supported approach and document the choice in code comments and tests.
- **Tracked issue storage:** The issue reference is typed now, but a full stored issue table is outside this feature. Keep the representation easy to migrate when issue storage arrives.
- **JSON validation:** Embedded values are convenient but can hide malformed data if reads skip validation. Repositories should validate parsed JSON before returning contract objects.
## Task list

### Story 1: Contract value objects and entity schemas

#### Task 1.1: Add shared domain value-object contracts

**Description:** Create `packages/api-contract/src/domain-value-objects.ts` with Zod schemas and inferred types for `ModelIdentity`, `TokenBreakdown`, `Cost`, `TrackedIssue`, `ChannelReference`, `FeedbackAnchor`, `FeedbackThreadEntry`, `FeedbackThread`, and `TestingGuideResult`.
**Acceptance criteria:**
- `tokenBreakdownSchema` accepts only integer `input`, `output`, `cacheRead`, and `cacheWrite` counts.
- `costSchema` accepts an integer nano-dollar `usd` value when cost is known, accepts `null`/omitted `usd` when cost is unknown, and reuses `modelIdentitySchema` and `tokenBreakdownSchema`.
- Feedback, channel, tracked issue, and testing-guide value-object schemas match the type shapes described in this spec and the domain model.
- Inferred TypeScript types are exported from the same file.
**Dependencies:** None.
#### Task 1.2: Add persisted domain entity contracts

**Description:** Add one contract file per entity under `packages/api-contract/src` for project, conversation, topic, message, run, artifact, feedback, publication, pull request, run step, session, and test result.
**Acceptance criteria:**
- Each file exports the entity schema, create-input schema, entity type, and create-input type named by this spec.
- Entity schemas reuse `principalSchema` for author, tester, and feedback-thread attribution, and reuse a narrowed non-model principal schema for owner fields.
- Major entities include `owner` and `tenant`; `owner` rejects `kind: 'model'`; `tenant` is a non-empty string equal to `owner.tenantId`; `RunStep`, `Session`, and `TestResult` do not add owner or tenant.
- `PullRequestState`, `SessionRole`, and `SessionOutcome` are exported where specified; `SessionRole` is an extensible lower snake_case string type validated by `sessionRoleSchema`. Do not export or define a closed `RunStatus` enum.
- Optional and nullable fields preserve the exact `null` versus omitted behavior specified by the contracts.
**Dependencies:** Task 1.1.
#### Task 1.3: Model run current step without a closed status enum

**Description:** Define run contracts around `currentStep` plus a minimal `terminal` boolean discriminator. Do not define `RunStatus` or validate terminality against a closed status vocabulary.
**Acceptance criteria:**
- `runSchema` and `createRunInputSchema` include `currentStep` as a non-empty string.
- `runSchema` and `createRunInputSchema` include `terminal` as the temporary discriminator used by the one-active-run database constraint.
- The schemas do not export or depend on a closed `RunStatus` enum.
- Contract comments or field descriptions note that ADR-015 expects terminality to be reconciled to the step catalog's `waiting_on`-derived source of truth when the run-machine feature lands.
**Dependencies:** Task 1.2.
#### Task 1.4: Export all new contract APIs

**Description:** Update `packages/api-contract/src/index.ts` so downstream packages can import every schema and type added by this feature.
**Acceptance criteria:**
- The package entrypoint exports all value-object schemas and types.
- The package entrypoint exports all entity schemas, create-input schemas, entity types, create-input types, and public enum-like type aliases.
- Existing package exports continue to work.
**Dependencies:** Tasks 1.1, 1.2, 1.3.
#### Task 1.5: Add contract schema tests

**Description:** Add `domain-value-objects.spec.ts` and `domain-entities.spec.ts` under `packages/api-contract/src/__tests__/`.
**Acceptance criteria:**
- Tests cover valid and invalid token and nano-dollar integer values.
- Tests cover unknown cost with `usd` null or omitted and prove it is not coerced to zero.
- Tests prove non-model principal validation for owner and general principal reuse for author, tester, and thread attribution.
- Tests cover validation for run `currentStep`/`terminal`, artifact kind and cached status, publication fronted resource, feedback status and anchor/thread shapes, pull request state, run-step phase/role/occurrence fields, session inference settings and outcome, and test result outcome/evidence shape, plus lower snake_case validation and future-value acceptance for session roles.
- Tests prove arbitrary non-empty `currentStep` values are valid, no `status` field is accepted or required, and run terminality is represented only by the temporary discriminator.
- Tests prove message direction accepts only `inbound` and `outbound`, with no `internal` direction.
- Tests prove `Session.tokens` and `Session.cost.tokens` must match exactly.
- Tests cover Conversation active-topic modeling through `activeTopicId` and absence of `Topic.isActive`.
**Dependencies:** Tasks 1.1, 1.2, 1.3, 1.4.
### Story 2: Core repository interfaces

#### Task 2.1: Add narrow domain repository interfaces

**Description:** Create `packages/core/src/domain-repositories.ts` with create/read interfaces for every persisted domain entity.
**Acceptance criteria:**
- Interfaces match the names and method shapes specified by this feature.
- `findById` returns `Promise` for every repository.
- `ConversationRepository` includes `setActiveTopic(conversationId, topicId)` and no broad conversation update API.
- Parent list/find methods exist only where specified: messages by topic, runs by topic, run-owned artifacts, feedback, publications, run steps, sessions, and test results by run, plus `PullRequestRepository.findByRun` for the single run-owned PR.
- The file imports shared entity and create-input types from `@autocatalyst/api-contract`.
- The file does not import Drizzle, SQLite, or persistence implementation types.
**Dependencies:** Story 1.
#### Task 2.2: Export domain repository interfaces

**Description:** Update `packages/core/src/index.ts` to export the new repository interfaces.
**Acceptance criteria:**
- All repository interfaces added by this feature are publicly exported.
- Existing core exports remain unchanged.
- TypeScript consumers can import the interfaces from `@autocatalyst/core`.
**Dependencies:** Task 2.1.
### Story 3: Drizzle schema and migrations

#### Task 3.1: Add domain tables to the Drizzle schema

**Description:** Extend `packages/persistence/src/schema.ts` with Drizzle SQLite table definitions for the domain entities.
**Acceptance criteria:**
- Tables are defined for `projects`, `conversations`, `topics`, `messages`, `runs`, `artifacts`, `feedback`, `publications`, `pullRequests`, `runSteps`, `sessions`, and `testResults`.
- Foreign keys represent the hierarchy: project to conversation, conversation to topic, topic to message, topic to run, and run to all run-owned records.
- Conversations store nullable `activeTopicId` for transient uninitialized rows, and the repository update path must reject `null` and validate the referenced topic belongs to that conversation.
- Major entity tables include owner and tenant columns; run-step, session, and test-result tables inherit ownership and tenancy through `runId`; owner values are validated as non-model principals and `tenant` is validated to equal `owner.tenantId` before persistence returns contract entities.
- JSON columns exist for embedded owner/principal values and value objects such as channel references, tracked issues, feedback anchors/threads, testing-guide results, token breakdowns, inference settings, metadata, and cost.
- Indexes support later reads by parent ids and creation time where specified in the tech spec.
**Dependencies:** Story 1.
#### Task 3.2: Add the one-active-run partial unique index

**Description:** Add the database constraint that rejects more than one non-terminal run per topic.
**Acceptance criteria:**
- The generated database schema includes a unique index keyed by topic for rows where `terminal = 0`.
- The constraint allows multiple terminal runs for the same topic.
- The constraint allows one non-terminal run after a prior terminal run for the same topic.
- The implementation uses the least surprising Drizzle-supported approach and documents any raw SQL fallback in code comments or migration notes.
**Dependencies:** Task 3.1.
#### Task 3.2a: Add main-topic and PR uniqueness constraints

**Description:** Add database constraints for one main topic per conversation and one PR per run.
**Acceptance criteria:**
- The generated database schema includes a unique index that rejects a second topic with `kind = 'main'` for the same conversation.
- The constraint allows multiple side topics for the same conversation.
- The generated database schema includes a unique constraint or unique index on pull request `runId`.
- Repository tests assert duplicate main-topic and duplicate PR creation fail at the persistence boundary.
**Dependencies:** Task 3.1.
#### Task 3.3: Generate and commit the domain schema migration

**Description:** Run the existing Drizzle generation command and commit the generated SQL migration under `packages/persistence/drizzle/`.
**Acceptance criteria:**
- A new migration file creates the domain tables, foreign keys, indexes, one-active-run partial unique index, one-main-topic uniqueness, and PR-by-run uniqueness.
- The migration applies to an empty SQLite database using the existing migration runner.
- No schema change exists only in tests or application code without a committed migration.
- The generated migration filename replaces the placeholder in the implementation and code-map updates.
**Dependencies:** Tasks 3.1, 3.2, and 3.2a.
### Story 4: Persistence row mapping

#### Task 4.1: Add shared JSON and timestamp mapper helpers

**Description:** Create `packages/persistence/src/domain-row-mappers.ts` with helpers for serializing, parsing, and validating embedded JSON values and timestamp fields.
**Acceptance criteria:**
- Helpers expose `parseJsonValue`, `parseNullableJsonValue`, and `stringifyJsonValue` for repository mapper use.
- Parse helpers validate decoded JSON with the relevant Zod schema before returning data.
- Invalid stored JSON or schema mismatches throw rather than silently coercing values.
- Helpers preserve existing timestamp representation conventions used by the persistence package.
**Dependencies:** Story 1.
#### Task 4.2: Map database rows to contract entities

**Description:** Add row-to-contract and input-to-row mapping logic near the persistence repositories for every domain entity.
**Acceptance criteria:**
- Mapping returns contract entity shapes, not raw Drizzle rows.
- Mapping serializes embedded value objects on write and parses them on read.
- Mapping preserves `null` and optional fields according to the contracts.
- Mapping handles owner/principal JSON values consistently for all major entities.
- Mapping validates every returned entity with its contract schema before exposing it to core callers.
- Session mapping validates that `tokens` and `cost.tokens` are identical and preserves unknown cost as `null`/omitted rather than `0`.
**Dependencies:** Task 4.1 and Story 3.
### Story 5: Drizzle repository implementations

#### Task 5.1: Add Drizzle-backed repositories for top-level hierarchy records

**Description:** Implement `DrizzleProjectRepository`, `DrizzleConversationRepository`, `DrizzleTopicRepository`, `DrizzleMessageRepository`, and `DrizzleRunRepository` in `packages/persistence/src/domain-repositories.ts`.
**Acceptance criteria:**
- Each repository implements the matching core interface.
- `create` inserts a validated row and returns the persisted contract entity.
- `findById` returns the entity or `null` following existing repository conventions.
- `DrizzleConversationRepository.setActiveTopic` updates and returns the conversation, rejects `null`, and rejects topics from other conversations.
- `DrizzleTopicRepository.create` does not mutate `Conversation.activeTopicId`; callers must use `setActiveTopic` to switch the pointer.
- `MessageRepository.listByTopic` returns messages for a topic in deterministic creation order.
- `RunRepository.listByTopic` returns runs for a topic in deterministic creation order.
- Foreign-key and duplicate active-run failures surface as persistence errors that tests can assert.
**Dependencies:** Stories 2, 3, and 4.
#### Task 5.2: Add Drizzle-backed repositories for run-owned records

**Description:** Implement repositories for artifact, feedback, publication, pull request, run step, session, and test result persistence.
**Acceptance criteria:**
- Each repository implements the matching core interface.
- Each repository supports `create`, `findById`, and the specified `listByRun` method, except `PullRequestRepository`, which supports `findByRun` for the single run-owned PR.
- Embedded values round-trip for artifact linked issue, feedback anchor/thread, session token/cost data, run-step metadata, and test-result feedback ids.
- Run-owned repositories rely on the parent run for ownership and tenancy where the contract omits those fields.
- Pull request creation rejects a second PR for the same run.
**Dependencies:** Stories 2, 3, and 4.
#### Task 5.3: Add repository collection factory and exports

**Description:** Add `DrizzleDomainRepositories` and `createDrizzleDomainRepositories`, then update `packages/persistence/src/index.ts`.
**Acceptance criteria:**
- The collection contains every repository added by this feature.
- The factory accepts the existing public `SqliteDatabase` type.
- The persistence package entrypoint exports all repository classes, the collection type, and the factory.
- Existing persistence exports remain unchanged.
**Dependencies:** Tasks 5.1 and 5.2.
### Story 6: Migration and repository verification

#### Task 6.1: Add fresh-database migration coverage

**Description:** Add `packages/persistence/src/__tests__/domain-migrations.spec.ts` to verify that committed migrations create the full domain schema.
**Acceptance criteria:**
- The test applies migrations to a fresh temp SQLite database using the existing test helper pattern.
- The test asserts every domain table exists.
- The test asserts key indexes exist, including the one-active-run partial unique index, one-main-topic uniqueness, and PR-by-run uniqueness.
- The test fails if the generated migration is missing from the committed migration set.
**Dependencies:** Story 3.
#### Task 6.2: Add per-entity repository round-trip coverage

**Description:** Add `packages/persistence/src/__tests__/domain-repositories.spec.ts` covering create, read, and parent-list behavior for every domain repository.
**Acceptance criteria:**
- Tests create a valid parent hierarchy before creating child rows.
- Every entity has a create-then-`findById` assertion.
- Parent list/find methods return the expected rows for topic-owned and run-owned records, including `PullRequestRepository.findByRun`.
- Tests assert owner and tenant survive round trips for every major entity and that `owner.kind === 'model'` is rejected at the contract or repository boundary.
- Tests assert embedded value objects survive round trips for channel reference, tracked issue, testing-guide result, feedback anchor/thread, and session cost.
- Tests assert `ConversationRepository.setActiveTopic` updates the authoritative pointer, does not rely on `TopicRepository.create` side effects, rejects `null`, and rejects a topic from a different conversation.
- Tests assert each initialized conversation has one main topic, duplicate main-topic creation is rejected, and side topics remain allowed.
- Tests assert unknown session cost remains null/omitted and `Session.tokens` must match `Session.cost.tokens`.
- Tests use deterministic ids and timestamps to avoid brittle assertions.
**Dependencies:** Stories 4 and 5.
#### Task 6.3: Add active-run constraint coverage

**Description:** Add `packages/persistence/src/__tests__/domain-active-run-constraint.spec.ts` for duplicate non-terminal-run behavior.
**Acceptance criteria:**
- Creating a second non-terminal run for the same topic fails at the persistence boundary.
- Creating a terminal run for a topic does not block a new non-terminal run for that same topic.
- Contract validation proves `currentStep` is extensible, no `status` field is required, and no closed run-status vocabulary is required before rows reach the database.
- The invariant is keyed on topic id, not conversation id, issue reference, message id, or run step.
**Dependencies:** Tasks 3.2, 5.1, and 6.2.
### Story 7: Documentation and validation

#### Task 7.1: Update the agent code map

**Description:** Update `context-agent/wiki/code-map.md` with the new contract, core, persistence, migration, and test locations.
**Acceptance criteria:**
- The code map lists the new contract files and public exports.
- The code map lists the new core repository interface file.
- The code map lists the new persistence schema tables, mapper helpers, repository implementations, and repository factory.
- The code map records the generated migration filename.
- The code map records useful targeted validation commands discovered during implementation.
**Dependencies:** Stories 1, 2, 3, 4, 5, and 6.
#### Task 7.2: Run targeted package checks

**Description:** Run the package-level checks for the contract, core, and persistence changes.
**Acceptance criteria:**
- `pnpm nx test api-contract` passes.
- `pnpm nx test core` passes, or no-op behavior is documented if that package has no tests for this feature.
- `pnpm nx test persistence` passes.
- Any skipped or unavailable command is documented with the exact reason.
**Dependencies:** Stories 1, 2, 5, and 6.
#### Task 7.3: Run full workspace validation

**Description:** Run the repository-wide validation command after targeted checks pass.
**Acceptance criteria:**
- `pnpm validate` passes.
- If validation fails for an unrelated existing issue, the failure is documented with enough detail for the implementer to reproduce it.
- No branch, push, merge, worktree, or PR action is performed by the implementer as part of this feature.
**Dependencies:** Task 7.2.