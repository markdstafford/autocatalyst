---
created: 2026-06-17
last_updated: 2026-06-17
status: complete
issue: 71
issue_url: [https://github.com/markdstafford/autocatalyst/issues/71](https://github.com/markdstafford/autocatalyst/issues/71)
specced_by: autocatalyst
---
# Feature: Start a run from an issue reference

## Product requirements

### What

Autocatalyst should let a caller start a run by pointing at an existing tracker issue instead of copying issue contents into the create request. A `POST /v1/conversations` request can either carry an explicit issue reference or a free-form instruction such as `work on issue #71`. Intake resolves that reference against the request's `Project`, reads and enriches the real issue through a provider-neutral issue-tracker port, settles the run's work kind from the enriched issue, and starts the correct workflow on the issue content.
The first provider is GitHub. The GitHub adapter reads issues through the `gh` CLI with an explicit repository target and a token resolved from the project's credential reference through the service secret store. The adapter is hidden behind the issue-tracker port, so no agent path calls `gh` directly and no tracker write is added in this feature.
### Why

Autocatalyst's primary product loop starts with a person saying "work on issue N." The current create path accepts caller-supplied `submission.workKind` and optional caller-supplied `submission.trackedIssue`, then stores those values as-is. That means the service trusts hand-supplied issue data, cannot prove the issue exists, and cannot start from the canonical tracker content.
This feature adds the missing intake stage described by `context-human/concepts/intake.md`: resolve the issue reference, pull and enrich it, settle the workflow, and bind the enriched issue to the run. It also builds the tracker read integration described by `context-human/concepts/trackers.md` without adding tracker writes or code-host behavior.
### Goals

- Add a provider-neutral, workspace-free issue-tracker port with a `read` operation that returns the canonical `TrackedIssue` value object.
- Add a GitHub issue-tracker adapter behind that port, using `gh` with an explicit repository target rather than ambient working-directory state.
- Place the neutral port and intake seam in `packages/core`, but place the GitHub adapter and shared `gh` subprocess helper in a dedicated provider-adapter package so subprocess/provider code stays out of control-plane core.
- Add one shared `gh` execution helper that receives a GitHub token resolved through `SqliteSecretStore` / `SecretResolver`, passes it safely to `gh`, and redacts secrets from logs and error details.
- Update `POST /v1/conversations` intake so an explicit issue reference does not require caller-supplied `workKind` or `trackedIssue`.
- Recognize free-form instructions that name one issue, such as `work on issue 71` or `work on issue #71`, and route them through the same two-stage create path.
- Keep general free-form submissions that do not name an issue on the existing single-stage create path.
- Settle `feature`, `enhancement`, `bug`, or `chore` from the enriched issue's labels and title/type cues, then map that work kind through `getRunWorkflowForWorkKind`.
- Persist the enriched `TrackedIssue` on the created `Run`.
- Refuse unresolved references at the entry boundary with the existing `intake_routing_error` HTTP 400 surface.
- Put reference recognition and work-kind settlement behind one seam that a later intent classifier can replace without changing the tracker port or the run bind path.
- Prove the path with tests that execute a real or realistic `gh` subprocess, parse real `gh --json` output shape, resolve credentials through the real secret-store seam, and do not inject a prebuilt `TrackedIssue` into intake.
- Update `context-agent/wiki/code-map.md` during implementation for the issue-tracker port, package-placement decision, GitHub adapter, `gh` helper, and two-stage create wiring.
### Non-goals

- Adding tracker writes, issue comments, issue filing, duplicate detection, or `mm:issue-triage` behavior.
- Adding a Jira adapter. The port should allow a later Jira adapter, but this feature implements GitHub only.
- Adding a code-host port, pull-request open/merge, or PR lifecycle behavior.
- Managing tracker or code-host settings through new API routes. This feature uses `Project.issueTrackerSetting`, `Project.hostRepository`, and `Project.credentialRefs` that are already seeded.
- Building the full intent classifier. This feature adds a narrow recognizer and work-kind settler that sit behind the classifier seam.
- Supporting multi-issue references in one submission.
- Using an agent to read the tracker, classify issue references, or settle work kind.
- Creating branches, worktrees, pushes, merges, or pull requests as part of this feature.
### Personas

- **Phoebe (PM)** can start work by saying "work on issue 71" and trust that Autocatalyst uses the actual issue content and labels.
- **Enzo (Engineer)** can rely on one tracker port and one intake seam instead of scattered GitHub CLI calls or caller-supplied issue metadata.
- **Opal (Operator)** needs tracker credentials to come from project settings and secrets, with clear failures that do not leak tokens.
- **A future classifier implementer** needs to replace the temporary issue-reference recognizer and work-kind settler in one place.
### User stories

- As Phoebe, I can submit `work on issue #71` and receive a run created from the issue's actual title, body, labels, state, and URL.
- As Phoebe, I can submit a structured issue reference and avoid filling in the work kind manually.
- As Enzo, I can add another issue tracker provider later by implementing the port instead of changing intake or orchestrator code.
- As Enzo, I can test issue-reference create without stubbing a `TrackedIssue` directly into the create request.
- As Opal, I can seed a project with a GitHub tracker target and credential reference, and the service resolves the token through the secret store at read time.
- As Opal, I get a clear `intake_routing_error` if a project lacks tracker settings, the issue does not exist, `gh` cannot authenticate, or the issue cannot be mapped to a work kind.
### Acceptance criteria

#### Issue-tracker port

- The service defines a provider-neutral issue-tracker port with a workspace-free `read(input)` operation.
- `read(input)` accepts a resolved tracker target plus an issue number.
- The port contract does not mention GitHub, Jira, `gh`, git, local repositories, or working directories.
- The port returns the shared `TrackedIssue` value object with `number`, `title`, `body`, `labels`, `state`, and `url`.
- The port is the only service-level tracker read path used by intake.
- Agents receive tracker data only through defined provider-neutral tools or host-provided context. No agent path calls `gh` or reads tracker credentials directly.
#### GitHub adapter and `gh` helper

- A GitHub adapter implements the issue-tracker port for `Project.issueTrackerSetting.provider === "github"`.
- The adapter builds the repository target explicitly from project settings or `Project.hostRepository`, such as `owner/name`.
- The adapter calls one shared `gh` execution helper to run `gh issue view` with JSON fields for number, title, body, labels, state, and URL.
- The helper passes the token through process environment, not command arguments.
- The helper never logs or returns token values, auth headers, or full environment variables. Raw `gh` stdout is returned only as bounded successful `GhExecResult.stdout` to trusted in-process adapter code for JSON parsing; raw stdout/stderr is never included in errors, logs, client details, or persisted failure reasons.
- `gh` failures are mapped to typed, sanitized tracker errors with safe codes such as `tracker_not_configured`, `issue_not_found`, `tracker_auth_failed`, `tracker_provider_unavailable`, or `tracker_response_invalid`.
- The GitHub adapter is the only production caller of `gh` for issue reads. A test or boundary assertion proves no other issue-read path shells out to `gh`.
#### Two-stage issue-reference create

- `POST /v1/conversations` accepts an explicit issue-reference submission that carries an issue number/reference and does not require caller-supplied `workKind` or `trackedIssue`.
- `POST /v1/conversations` still supports the current single-stage create shape for non-issue submissions that already carry an explicit `workKind`.
- For an explicit issue reference, intake loads the request's project, verifies that it is usable by the principal, resolves the project tracker target and credential, reads the issue through the issue-tracker port, settles the work kind, and calls `Orchestrator.createConversationWithFirstRun` with the settled work kind and enriched tracked issue.
- For a text-only free-form trigger that contains exactly one recognized issue reference, intake performs the same read/enrich/settle/bind path without requiring caller-supplied `workKind`.
- For a free-form trigger that does not contain a recognized issue reference, intake stays on the existing single-stage path when `workKind` is present and refuses with `intake_routing_error` when `workKind` is absent.
- A free-form trigger with ambiguous or multiple issue references is refused with `intake_routing_error` unless the implementation deliberately narrows recognition to one unambiguous issue and documents the ignored text.
- The created `Run.trackedIssue` contains the enriched issue returned by the port.
- The first inbound `Message.body` keeps the human's original submission text. Issue body/title content is passed as run context through `trackedIssue`, not by overwriting the human message.
#### Work-kind settlement seam

- Reference recognition and work-kind settlement live behind one named intake seam, for example an `IssueReferenceIntakeResolver` or equivalent.
- The seam accepts the submission text/shape plus the enriched issue and returns either a settled create input or a typed refusal.
- The seam maps labels and title/type cues to `feature`, `enhancement`, `bug`, or `chore`.
- Label mapping is deterministic and documented. Preferred labels are exact normalized labels: `feature`, `enhancement`, `bug`, and `chore`.
- Conventional-commit title prefixes may be used as fallback cues: `feat:` maps to `feature`, `fix:` maps to `bug`, and `chore:` maps to `chore`.
- If no cue maps to a known workflow, intake refuses the request with `intake_routing_error` instead of guessing.
- The seam calls `getRunWorkflowForWorkKind` or an equivalent workflow lookup before create, so an unmapped work kind cannot reach run creation.
- A later intent classifier can replace this seam without changing the issue-tracker port, GitHub adapter, `gh` helper, or orchestrator bind path.
#### Repository guard and error behavior

- If the request references no usable `Project`, the create request is refused before any run is created.
- If the project has no `issueTrackerSetting`, no usable target, no usable credential reference, or an unsupported tracker provider, the create request is refused before any run is created.
- If the secret store cannot resolve the required GitHub token, the create request is refused before any run is created.
- If the tracker cannot return the issue, the create request is refused before any run is created.
- Missing projects, projects outside the request tenant, and projects not usable by the principal are all treated as unusable project references for this issue-reference intake path and use the existing `ControlPlaneServiceError('intake_routing_error')` path with HTTP `400`. General request authentication/authorization that fails before project intake keeps the existing auth/forbidden surface.
- Other intake refusals use the same `ControlPlaneServiceError('intake_routing_error')` path and HTTP `400` error envelope.
- Error details are safe for clients and logs. They may include provider name, repository owner/name, issue number, and safe error code. They must not include tokens, full environment values, raw `gh` stdout/stderr, or secret handles unless existing secret-handle policy explicitly allows them.
#### End-to-end proof

- A service or network integration test starts a run by submitting an explicit issue reference and does not supply `trackedIssue` or `workKind` in that submission.
- A service or network integration test starts a run by submitting free-form text such as `work on issue #N` with no caller-supplied `workKind`, and does not inject an enriched issue directly.
- The test drives the GitHub adapter through a real or realistic `gh` executable. A deterministic test may put a fake `gh` executable on `PATH`, but intake must still call the shared `gh` helper and parse `gh --json` output.
- The deterministic fake-`gh` fixture is derived from actual `gh issue view  --json number,title,body,labels,state,url` output, including GitHub's `{ name }` label object shape, so the adapter proves the real parser path rather than a hand-shaped `TrackedIssue`.
- The deterministic integration path resolves the token through the real `SqliteSecretStore` / `SecretResolver` with a seeded test secret; only the `gh` executable is faked.
- A concrete, runnable live GitHub read test is skipped by default and runs only when credentials and environment opt in.
- The created run has the settled work kind, current workflow start step, and persisted enriched `trackedIssue`.
- A forced-failure test proves an unresolvable issue reference is refused at the boundary with `intake_routing_error` and no run is created.
- Tests assert the token is not present in thrown errors, returned details, captured logs, or persisted run failure reasons.
### Product devil's advocate pass

- **The narrow recognizer can surprise callers.** A human may paste a GitHub URL or mention two issue numbers and expect the service to infer intent. The feature deliberately refuses ambiguous or unsupported forms instead of guessing, because one run binds one canonical issue.
- **Synchronous tracker reads add entry latency and dependency failure.** The design accepts this because the workflow and `trackedIssue` are required before the first run can be created. If the broader intake model later moves all creates to immediate acknowledgement, this path will need a pending/enrichment state.
- **GitHub-only support is intentionally incomplete.** The provider-neutral port is required so Jira and other trackers can be added later, but unsupported providers fail clearly until an adapter exists.
- **Error clarity must not become secret leakage.** Operators need actionable failure codes and safe identifiers, but raw `gh` output and secret handles are excluded from public and persisted surfaces.
### Product reviewer pass

The product requirements are consistent with the intake and tracker concepts: tracker content is resolved before run creation, agents do not read credentials directly, and the run stores canonical issue context. The acceptance criteria preserve existing explicit-work submissions while allowing issue-reference and text-only free-form issue starts. Out-of-scope items protect against accidental tracker writes, branch/PR work, multi-issue handling, and a full classifier in this slice.
### References

- Issue: [https://github.com/markdstafford/autocatalyst/issues/71](https://github.com/markdstafford/autocatalyst/issues/71)
- `context-human/concepts/intake.md`
- `context-human/concepts/trackers.md`
- `context-human/adrs/adr-008-config-model.md`
- `context-human/adrs/adr-009-auth-rbac-envelope.md`
- `packages/api-contract/src/conversation-ingress.ts`
- `packages/api-contract/src/domain-value-objects.ts`
- `packages/api-contract/src/project.ts`
- `packages/core/src/control-plane-service.ts`
- `packages/core/src/orchestrator.ts`
- `packages/core/src/run-workflows.ts`
- `packages/github-issue-tracker-adapter/src/index.ts`
- `packages/persistence/src/secret-store.ts`
## Design spec

### Design scope

This is a backend service and integration feature. It does not add visual screens, client components, or user-facing copy beyond existing API error messages.
The design work is the intake experience: a caller gives a small issue reference, the service reads the real issue, and the resulting run behaves like any other feature, enhancement, bug, or chore run. The visible API should make the safe path easier than the unsafe path: clients should not need to provide issue contents or choose a work kind when the tracker already has that information.
### Caller experience

A structured issue-reference request should be compact:
```json
{
  "projectId": "proj_123",
  "identity": "Issue 71",
  "topic": { "title": "Work on issue 71" },
  "submission": {
    "kind": "issue_reference",
    "body": "please work on issue 71",
    "issue": { "number": 71 }
  }
}
```
The exact field name may be `issue`, `issueReference`, or another local convention, but the request should not require:
- `submission.workKind` for the issue-reference branch;
- `submission.trackedIssue` supplied by the caller;
- a repository string supplied outside the selected `Project`.
The existing single-stage create shape can remain available for non-issue submissions:
```json
{
  "projectId": "proj_123",
  "identity": "Direct feature brief",
  "topic": { "title": "Add export" },
  "submission": {
    "kind": "free_form",
    "body": "Add CSV export for runs",
    "workKind": "feature"
  }
}
```
A `free_form` body may also be submitted as text-only when it contains a narrow issue reference:
```json
{
  "projectId": "proj_123",
  "identity": "Issue 71",
  "topic": { "title": "Work on issue 71" },
  "submission": {
    "kind": "free_form",
    "body": "work on issue #71"
  }
}
```
If a `free_form` body says `work on issue #71`, the service treats it like the structured issue-reference request and does not require a dummy `workKind`. If it does not mention a single issue, the existing explicit `workKind` branch is unchanged until the full classifier lands; in this transition design, a text-only free-form request with no recognized issue reference is refused at intake with `intake_routing_error` rather than guessed.
### Successful flow

The successful issue-reference create flow should be:
1. The route validates the request shape and attaches the principal as it does today.
2. `DefaultControlPlaneService.createConversationWithFirstRun` authorizes `conversation.create`.
3. The service loads the `Project` for `request.projectId` and checks tenant/principal scope before run creation.
4. The intake resolver determines whether this request needs issue resolution.
5. For an issue-reference request, the resolver extracts one issue number.
6. The resolver asks the tracker registry for an issue-tracker adapter matching the project's `issueTrackerSetting.provider`.
7. The GitHub adapter resolves the token through `SecretResolver`, calls the shared `gh` helper, and returns `TrackedIssue`.
8. The intake resolver settles the work kind from the enriched issue's labels/title cues.
9. The service calls `Orchestrator.createConversationWithFirstRun` with the settled `workKind`, the original message body, and the enriched `trackedIssue`.
10. The orchestrator creates the conversation, main topic, message, run, and initial run step through the existing atomic transaction.
11. Auto-dispatch continues from the created run exactly as it does for other create requests.
This keeps tracker I/O before run creation. If the tracker read fails, there is no abandoned run waiting for context it can never get.
This is a deliberate synchronous issue-reference create path within the broader intake model in `context-human/concepts/intake.md`. The concept describes entry as resource creation and leaves room for classifier-driven work after an entry is accepted; this feature cannot safely create the run until tracker resolution and work-kind settlement finish because the workflow and canonical issue context are inputs to the first run. Non-issue explicit creates keep the existing immediate single-stage behavior, while recognized issue-reference creates are resolved before `Orchestrator.createConversationWithFirstRun` is called. If the broader intake concept later moves all creates to immediate acknowledgement, this issue-reference path will need an explicit pending/enrichment state; that state is out of scope here.
### Failure experience

Failures should happen at the entry boundary and read like intake errors, not runner failures. A caller should see HTTP 400 with `error.code: "intake_routing_error"` for these cases:
- project missing, outside the request tenant, or not usable by the principal;
- project has no issue tracker configured;
- project has an unsupported issue tracker provider;
- tracker target cannot be resolved to a repository or provider target;
- tracker credential reference is missing or cannot be resolved;
- `gh` is unavailable, cannot authenticate, or returns invalid JSON;
- issue number does not exist or cannot be read;
- enriched issue cannot be mapped to a known work kind;
- free-form text contains multiple issue references and the resolver cannot choose one.
The error message should be clear enough for a human to fix configuration or the request. Error details should use safe codes and safe identifiers. They should not include raw command stdout/stderr because it can contain provider diagnostics that are not written for public surfaces.
### Issue-reference recognition

The temporary recognizer should be intentionally narrow. It is a stand-in for the later intent classifier, not a competing classifier.
The recognizer should support:
- `submission.kind === "issue_reference"` with a structured integer issue number;
- free-form text matching common single-issue forms: `issue 71`, `issue #71`, `#71`, and `GH-71` only if that pattern is already accepted locally.
The recognizer should not attempt to parse provider URLs, cross-repository references, ranges, or batches in this feature unless the structured request already gives the number. One submission binds one issue. Multiple recognized numbers should produce an intake routing error.
### Work-kind settlement

Work-kind settlement should be deterministic and simple:
1. Normalize labels to lowercase, trim whitespace, and compare exact names.
2. If exactly one work-kind label exists among `feature`, `enhancement`, `bug`, and `chore`, use it.
3. If several work-kind labels exist, refuse as ambiguous.
4. If no work-kind label exists, inspect the title prefix:
	- `feat:` maps to `feature`;
	- `fix:` maps to `bug`;
	- `chore:` maps to `chore`.
5. If no cue maps to a workflow, refuse as unknown.
6. Call `getRunWorkflowForWorkKind` before creation and refuse if the workflow is missing.
This rule makes issue 71 map to `feature` through its `feature` label and `feat:` title. It also leaves room for the later classifier to use richer issue body analysis without changing the tracker port.
### Tracker port design

The provider-neutral port should expose only tracker concepts:
```typescript
export interface IssueTrackerPort {
  read(input: ReadTrackedIssueInput): Promise;
}

export interface ReadTrackedIssueInput {
  readonly target: IssueTrackerTarget;
  readonly issueNumber: number;
}

export interface IssueTrackerTarget {
  readonly provider: string;
  readonly repository?: {
    readonly owner: string;
    readonly name: string;
  };
  readonly projectKey?: string;
  readonly url?: string;
  readonly credentialRef?: CredentialReference;
}
```
Final names can follow project conventions. The important design constraint is that the port input is already resolved from the project and never depends on a workspace path. GitHub uses `repository.owner/name`; a future Jira adapter can use `url` and `projectKey` without changing intake.
### Credential target resolution

Issue tracker credentials resolve deterministically from the loaded `Project` before an adapter reads the issue:
1. If `Project.issueTrackerSetting.credentialRef` is present, use that reference.
2. Otherwise, inspect `Project.credentialRefs` for references with `purpose: 'issue_tracker'`.
3. If exactly one `issue_tracker` reference exists, use it.
4. If zero `issue_tracker` references exist, fail before the tracker read with `tracker_credential_missing` / `intake_routing_error`.
5. If multiple `issue_tracker` references exist and no explicit `issueTrackerSetting.credentialRef` selected one, fail before the tracker read with `tracker_credential_missing` / `intake_routing_error` and safe details indicating ambiguous issue-tracker credentials.
The resolver must use the real `CredentialReference` schema from `packages/api-contract/src/project.ts`: `purpose` is a required enum value, not an optional free-form string. It must not fall back to credentials with other purposes, repository host credentials, ambient `gh` authentication, or environment tokens. If an explicit credential reference is present but `SecretResolver` cannot resolve it to a usable token, the adapter maps that to `tracker_credential_missing`; if the provider rejects the resolved token, the adapter maps that to `tracker_auth_failed`.
### GitHub adapter design

The GitHub adapter should translate the neutral target into a `gh` invocation:
```bash
gh issue view 71 --repo owner/name --json number,title,body,labels,state,url
```
The adapter should:
- require a GitHub target with `owner` and `name`;
- resolve the credential reference through `SecretResolver` immediately before executing `gh`;
- call the shared helper with args as an array, not a shell string;
- pass the token through `GH_TOKEN` or the least-surprising `gh` token environment variable;
- receive raw `stdout` from the helper only on successful execution inside the trusted in-process adapter, solely so the adapter can schema-parse the `gh issue view --json` payload;
- parse JSON with a schema rather than untyped `JSON.parse` output;
- normalize labels to an array of names;
- normalize GitHub issue state to `open`, `closed`, or `unknown`;
- preserve `body` as an empty string if GitHub returns null or no body;
- return a `TrackedIssue` that validates against the shared contract.
### Agent and tool boundary

Agents must not use tracker credentials or call provider CLIs directly. Intake reads the issue before it dispatches a run. Later agent steps receive the issue content as service-provided run context or as defined provider-neutral tools.
A source or boundary test should scan production code for issue-read uses of `gh` outside the GitHub adapter/helper, or should assert the helper is injected only into the adapter used by the tracker registry. The goal is not to ban `gh` forever for code-host behavior; it is to ensure issue reads for this feature go through the tracker port.
## Tech spec

### Current state

The current create path is already close to the target shape but trusts caller-supplied issue data:
- `packages/api-contract/src/conversation-ingress.ts` defines one `submission` object with required `workKind` and optional `trackedIssue` for every submission kind.
- `packages/api-contract/src/domain-value-objects.ts` defines `trackedIssueSchema` with `number`, `title`, `state`, and `url`; it does not yet include issue `body` or `labels`.
- `packages/api-contract/src/project.ts` already includes `Project.issueTrackerSetting`, `Project.hostRepository`, and `Project.credentialRefs`.
- `packages/core/src/control-plane-service.ts` maps request `workKind` and optional `trackedIssue` directly into `Orchestrator.createConversationWithFirstRun`.
- `packages/core/src/orchestrator.ts` already persists `trackedIssue` on `Run` when it is supplied.
- `packages/persistence/src/domain-repositories.ts` already stores `Run.trackedIssue` as JSON.
- `packages/core/src/run-workflows.ts` exposes `getRunWorkflowForWorkKind` for `feature`, `enhancement`, `bug`, `chore`, `file_issue`, and `question`.
- `packages/core/src/secret.ts` defines the `SecretResolver` seam, and `packages/persistence/src/secret-store.ts` implements it in `SqliteSecretStore`.
The missing pieces are the issue-tracker port, a provider-adapter package for the GitHub adapter and `gh` execution helper, richer `TrackedIssue` data, and a service-level intake resolver before orchestrator creation.
### API contract changes

Update `trackedIssueSchema` in `packages/api-contract/src/domain-value-objects.ts`:
```typescript
export const trackedIssueSchema = z.object({
  number: z.number().int().min(1),
  title: z.string().min(1),
  body: z.string(),
  labels: z.array(z.string().min(1)),
  state: z.enum(['open', 'closed', 'merged', 'unknown']),
  url: z.string().url()
}).strict();
```
This is an additive change for persisted JSON parsing only if older records are tolerated. If existing tests or fixtures contain older tracked issues, add a migration-tolerant parser in persistence or a schema preprocess that defaults `body` to `""` and `labels` to `[]` for old data. Do not drop existing `state: 'merged'` support unless a separate migration removes it everywhere.
Update `createConversationWithFirstRunRequestSchema` to distinguish issue-reference submissions from current explicit-routing submissions. A discriminated union is preferred:
```typescript
const issueReferenceSubmissionSchema = z.object({
  kind: z.literal('issue_reference'),
  body: z.string().min(1),
  issue: z.object({ number: z.number().int().min(1) }).strict()
}).strict();

const explicitWorkSubmissionSchema = z.object({
  kind: z.enum(['question', 'list_to_file']),
  body: z.string().min(1),
  workKind: createRunWorkKindSchema,
  trackedIssue: trackedIssueSchema.optional()
}).strict();

const freeFormSubmissionSchema = z.object({
  kind: z.literal('free_form'),
  body: z.string().min(1),
  workKind: createRunWorkKindSchema.optional(),
  trackedIssue: trackedIssueSchema.optional()
}).strict();
```
If backward compatibility is required, the schema may temporarily accept the old issue-reference form with `workKind` and `trackedIssue`, but service intake should prefer resolving the real issue and should not trust caller-supplied `trackedIssue` for issue-reference creates.
The schema intentionally allows text-only `free_form` because the recognizer runs after request validation. Intake applies the runtime rule: a free-form body with exactly one recognized issue reference resolves through tracker enrichment; a free-form body with no recognized issue reference must include `workKind` or is refused with `intake_routing_error`; if a recognized issue reference is present, any caller-supplied `workKind` or `trackedIssue` is ignored in favor of canonical tracker settlement.
### Package placement and modules

Use a deliberate split between neutral control-plane contracts and provider/subprocess implementation:
- `packages/core/src/issue-tracker.ts` — provider-neutral port interfaces, `IssueTrackerError`, safe error codes, and target types.
- `packages/core/src/issue-reference-intake.ts` — recognition, project target resolution, tracker read, work-kind settlement, and create-input preparation seam.
- `packages/core/src/issue-tracker-registry.ts` — small provider lookup if the adapter is not injected directly.
- `packages/github-issue-tracker-adapter/src/index.ts` — GitHub adapter implementation of the port plus package-private parser helpers.
- `packages/github-issue-tracker-adapter/src/gh-exec.ts` — shared `gh` subprocess helper with redaction and timeout behavior for GitHub issue reads.
This placement follows the existing provider-adapter packaging pattern and keeps subprocess execution out of `packages/core`. Core owns the neutral port, registry, intake resolver, and service wiring; the GitHub adapter package depends on core and implements the port. Final file names may differ, but `context-agent/wiki/code-map.md` must record the chosen locations and this package-placement decision.
### Port and registry

Define typed errors at the port boundary:
```typescript
export type IssueTrackerErrorCode =
  | 'tracker_not_configured'
  | 'unsupported_tracker_provider'
  | 'tracker_target_invalid'
  | 'tracker_credential_missing'
  | 'tracker_auth_failed'
  | 'issue_not_found'
  | 'tracker_provider_unavailable'
  | 'tracker_response_invalid';

export class IssueTrackerError extends Error {
  readonly code: IssueTrackerErrorCode;
  readonly safeDetails?: Record;
}
```
The registry can be a simple map from provider string to port instance:
```typescript
export interface IssueTrackerRegistry {
  get(provider: string): IssueTrackerPort | null;
}
```
The control-plane server should construct a registry with the GitHub adapter and inject it into `DefaultControlPlaneService` or into an intake resolver dependency used by that service.
### `gh` execution helper

Implement the helper with `node:child_process` `execFile` or `spawn`, not a shell. It should accept:
- `args: readonly string[]`;
- `token: string`;
- optional `timeoutMs`;
- optional `env` or `path` override for tests;
- optional safe logger.
The helper should:
- set `GH_TOKEN` in the child environment;
- pass args as an array;
- collect bounded stdout and stderr;
- return raw bounded stdout only in `GhExecResult` for successful calls to trusted in-process code such as `GitHubIssueTracker`, so the adapter can parse `gh issue view --json`;
- parse non-zero exits into sanitized `GhExecError` codes;
- redact the token from every thrown error and log field;
- never include raw stdout or stderr in logs, thrown errors, client error details, persisted failure reasons, or other untrusted surfaces;
- support an injectable executable path for tests so integration tests can run a deterministic fake `gh` binary.
### Intake resolver

Add a service-owned resolver that returns normalized create data:
```typescript
export interface ResolvedConversationCreate {
  readonly workKind: CreateRunWorkKind;
  readonly trackedIssue?: TrackedIssue;
  readonly messageBody: string;
}
```
The resolver should receive:
- the parsed submission;
- the loaded project;
- tracker registry or port;
- secret resolver through the adapter;
- current tenant/principal context if needed for safe details.
Behavior:
1. If `submission.kind === 'issue_reference'`, require one issue number and resolve it.
2. If `submission.kind === 'free_form'`, scan `submission.body` for one issue reference. If found, resolve it without requiring `submission.workKind`. If not found, require the existing explicit `submission.workKind` and return it unchanged; if the field is absent, refuse with `IssueReferenceIntakeError('work_kind_unresolved')`, mapped to `intake_routing_error`.
3. For `question` and `list_to_file`, keep the current explicit work-kind path.
4. When resolving an issue, build the tracker target from `project.issueTrackerSetting`, `project.hostRepository`, and the credential lookup rule below.
5. Read the issue through the port.
6. Settle the work kind from labels/title.
7. Validate that `getRunWorkflowForWorkKind(workKind)` returns a workflow.
8. Return settled create data.
Map `IssueTrackerError` and resolver-specific errors to `ControlPlaneServiceError('intake_routing_error')` in `DefaultControlPlaneService`.
### Control-plane service wiring

`DefaultControlPlaneService.createConversationWithFirstRun` should change from direct request forwarding to resolved intake:
1. Authorize as today.
2. Load `Project` from `DomainRepositories.projects` or an injected `ProjectRepository` dependency.
3. Check project tenant matches the request tenant and that the project is usable by the principal. Missing, cross-tenant, and principal-unusable projects map to `ControlPlaneServiceError('intake_routing_error')` / HTTP 400 for this create-intake path, so project-reference failures do not create abandoned work or disclose which project ids exist. Authorization failures that occur before project intake still use the existing auth/forbidden policy surface.
4. Call the intake resolver.
5. Pass only resolver output into `Orchestrator.createConversationWithFirstRun`.
6. Return the existing response schema.
This may require adding `ProjectRepository` or broader `DomainRepositories` to `DefaultControlPlaneServiceOptions`. The control-plane server already wires domain repositories, so this should be an additive dependency.
### Persistence and migration tolerance

`Run.trackedIssue` is already stored as JSON. After `TrackedIssue` gains `body` and `labels`, update persistence row parsing so old rows do not break reads. Options:
- schema preprocess in `trackedIssueSchema` that defaults missing `body` and `labels`;
- persistence-specific legacy parser that upgrades old JSON before validating;
- a database migration that rewrites existing `trackedIssueJson` values.
Prefer schema or row-mapper tolerance unless a migration is already needed for other reasons. No new table is required.
### Tests

Add focused contract tests:
- `trackedIssueSchema` accepts enriched issues with `body` and `labels`.
- Legacy tracked issue JSON is tolerated if migration tolerance is implemented.
- `createConversationWithFirstRunRequestSchema` accepts the new issue-reference shape without `workKind` and rejects missing issue numbers.
- `createConversationWithFirstRunRequestSchema` accepts a text-only `free_form` submission so issue-reference text can be recognized after validation.
- Non-issue single-stage submissions still validate with explicit `workKind`.
Add tracker unit tests:
- GitHub adapter maps `gh` JSON to `TrackedIssue`.
- Labels are normalized from GitHub's `{ name }` label objects.
- Null body maps to `""`.
- Missing issue / auth failure / invalid JSON map to typed safe tracker errors.
- Token values are absent from thrown error messages and safe details.
Add intake resolver tests:
- Structured issue reference resolves, reads, settles `feature`, and returns enriched tracked issue.
- Text-only free-form `work on issue #N` resolves through the same path without a caller-supplied `workKind`.
- Free-form text with no issue stays on the explicit `workKind` path when `workKind` is present and is refused when it is absent.
- Ambiguous labels or multiple issue numbers produce `intake_routing_error`.
- Missing project tracker setting or unsupported provider produces `intake_routing_error`.
Add service/integration tests:
- A `POST /v1/conversations`-level test creates a run from an explicit issue reference with no caller-supplied `workKind` or `trackedIssue`.
- A free-form issue reference test creates a run from text only.
- A forced issue-read failure returns HTTP 400 `intake_routing_error` and no conversation/run is created.
- The created run persists the enriched `trackedIssue` and settled `workKind`.
- The `gh` path is exercised through a fake executable on `PATH` or an injectable executable path, not by injecting a `TrackedIssue`.
- The fake executable returns a fixture captured from real `gh issue view  --json number,title,body,labels,state,url` output, preserving GitHub label objects such as `{ "name": "feature" }`.
- The service/integration test seeds a test token in the real `SqliteSecretStore` and resolves it through the real `SecretResolver`; the credential seam is not faked.
- Add a skipped-by-default live proof gated behind environment variables such as `AUTOCATALYST_LIVE_GITHUB_ISSUE_READ=1`, repository owner/name, issue number, and a seeded credential handle or safe test-secret setup; CI should not require live credentials unless the project explicitly opts in.
Useful targeted commands after implementation:
```bash
pnpm nx test api-contract -- conversation-ingress.spec domain-value-objects.spec
pnpm nx test core -- issue-reference-intake.spec control-plane-service.integration.spec
pnpm nx test github-issue-tracker-adapter -- github-issue-tracker.spec gh-exec.spec
pnpm nx test control-plane -- integration.spec
pnpm nx test persistence -- domain-repositories.spec
pnpm test:boundaries
```
### Risks and open decisions

- **API compatibility:** changing `submission` to a discriminated union may require updating SDK and tests that assume every submission has `workKind`.
- **TrackedIssue compatibility:** adding `body` and `labels` requires tolerance for older persisted values and fixtures.
- **Provider semantics:** GitHub labels and title prefixes are enough for this issue, but Jira issue types will need a provider-specific adapter mapping later.
- **Package placement:** placement is settled for this feature: neutral port/registry/intake stay in `packages/core`; GitHub adapter and `gh` subprocess helper live in `packages/github-issue-tracker-adapter`, and the code map must record this decision.
- **Live test stability:** a deterministic fake `gh` executable gives reliable CI coverage; the live GitHub proof is a concrete skipped-by-default opt-in test and should not be required by CI unless credentials and network access are guaranteed.
- **Credential location:** credential lookup is settled above: prefer `Project.issueTrackerSetting.credentialRef`, otherwise use exactly one `Project.credentialRefs` entry with `purpose: 'issue_tracker'`, and fail on zero or multiple fallback matches.
### Technical devil's advocate pass

- **The ****`gh`**** helper is a security boundary by convention, not by process isolation.** The spec narrows the only raw-output return to bounded successful stdout for trusted adapter parsing and requires sanitized errors/tests so provider diagnostics cannot cross public or persisted boundaries.
- **Project-access mapping could conflict with generic service policy.** This spec chooses `intake_routing_error` HTTP 400 for missing, cross-tenant, or principal-unusable project references only within issue-reference create intake. Pre-intake authentication and authorization failures keep the existing service policy surface.
- **Contract widening can break older fixtures.** The `TrackedIssue` enrichment is paired with schema/row tolerance so legacy persisted issue JSON remains readable.
- **Real subprocess tests can be flaky if they depend on live GitHub.** The deterministic fake-`gh` path is the required CI proof; the live proof is explicitly opt-in and skipped by default.
### Technical reviewer pass

The technical design keeps provider-neutral interfaces in core and provider subprocess logic in the GitHub adapter package. Credential lookup is deterministic and avoids ambient `gh` auth. The synchronous intake flow is justified because issue content and work kind are inputs to first-run creation. Error mapping is now consistent across acceptance criteria, failure experience, resolver behavior, and control-plane wiring: project-reference and tracker/refusal failures return `intake_routing_error` HTTP 400, while unrelated pre-intake auth failures retain existing policy behavior.
## Task list

### Story 1: Expand API contracts for canonical tracked issues and issue-reference submissions

#### Task 1.1: Enrich `TrackedIssue` while preserving legacy reads

**Description:** Update `packages/api-contract/src/domain-value-objects.ts` so `trackedIssueSchema` carries canonical tracker body and labels. Keep old persisted `Run.trackedIssue` and `Artifact.linkedIssue` JSON readable by defaulting missing `body` to `""` and missing `labels` to `[]` before strict validation.
**Acceptance criteria:**
- `TrackedIssue` includes `number`, `title`, `body`, `labels`, `state`, and `url`.
- The schema still accepts existing tracked issue JSON that lacks `body` and `labels`.
- The schema remains strict after preprocessing, so unknown properties are rejected.
- Tests cover enriched issues, legacy issues, invalid labels, invalid body, and the existing `merged` state.
**Dependencies:** None.
#### Task 1.2: Add the issue-reference and free-form submission branches

**Description:** Update `packages/api-contract/src/conversation-ingress.ts` to expose `issueReferenceSubmissionSchema`, `freeFormSubmissionSchema`, `explicitWorkSubmissionSchema`, and the discriminated `createConversationSubmissionSchema`. Keep existing explicit work submissions valid for non-issue create paths, while allowing free-form issue-reference text without a dummy `workKind`.
**Acceptance criteria:**
- `submission.kind: "issue_reference"` validates with `body` and `issue.number` only, with no required `workKind` or caller-supplied `trackedIssue`.
- `submission.kind: "free_form"` validates with `body` and no `workKind`, so text such as `work on issue #N` can reach intake recognition.
- Explicit submissions for `question` and `list_to_file` still require `workKind` and may carry `trackedIssue`.
- Free-form submissions may still include `workKind` for the existing non-issue path.
- Missing or invalid issue numbers are rejected by schema validation.
- Extra properties are rejected for both submission branches.
- Tests cover the new valid issue-reference request, text-only free-form issue-reference request shape, and the existing valid explicit-work request.
**Dependencies:** Task 1.1.
#### Task 1.3: Export the new contract surface

**Description:** Update `packages/api-contract/src/index.ts`, OpenAPI generation inputs if needed, and SDK type imports that depend on the create request types.
**Acceptance criteria:**
- The new schemas and inferred types are exported from the API contract package.
- The generated OpenAPI schema for `POST /v1/conversations` includes both submission branches.
- SDK compilation uses the updated request type without local duplicate types.
- API contract and SDK tests compile against the new shape.
**Dependencies:** Task 1.2.
### Story 2: Add the provider-neutral issue-tracker core port

#### Task 2.1: Define tracker target, port, registry, and safe errors

**Description:** Add `packages/core/src/issue-tracker.ts` and `packages/core/src/issue-tracker-registry.ts` with the provider-neutral read port, target types, registry lookup, and `IssueTrackerError` codes from the tech spec.
**Acceptance criteria:**
- `IssueTrackerPort.read(input)` accepts only a resolved target and an issue number.
- Core tracker target types do not mention `gh`, git worktrees, local repositories, or workspace paths.
- `IssueTrackerError` carries a stable safe code, sanitized message, optional safe details, and optional opaque cause.
- `StaticIssueTrackerRegistry` normalizes provider lookup consistently.
- Unit tests cover registry lookup, missing providers, safe details, and error construction.
**Dependencies:** Task 1.1.
#### Task 2.2: Re-export the tracker core surface

**Description:** Update `packages/core/src/index.ts` to export only the public tracker port, registry, and error types required by server wiring and tests.
**Acceptance criteria:**
- All exports listed for tracker port and registry in this spec are available from `@autocatalyst/core`.
- Internal recognizer and work-kind settlement helper functions are not exported.
- Core index tests or type tests prove the public exports compile.
**Dependencies:** Task 2.1.
### Story 3: Implement the safe shared `gh` execution helper in the GitHub adapter package

#### Task 3.1: Add `executeGh`

**Description:** Add `packages/github-issue-tracker-adapter/src/gh-exec.ts` with a subprocess helper that runs `gh` using argv arrays, injects the token through environment, bounds output, supports test overrides, and maps failures to sanitized `GhExecError` codes.
**Acceptance criteria:**
- The helper uses `execFile` or `spawn`, never shell string execution.
- The helper sets `GH_TOKEN` for the child process and never includes the token in command arguments.
- stdout and stderr collection is bounded; returned data includes stdout and whether stdout was truncated.
- Non-zero exits, missing executable, auth failures, missing resource failures, and timeouts map to the error codes listed in this spec.
- Raw stdout is returned only on successful `GhExecResult` for trusted adapter parsing.
- Thrown errors, safe details, logs, client details, and persisted failure reasons never include token values, raw environment values, or raw stdout/stderr.
- The package follows existing adapter package conventions (`package.json`, Nx/project config, exports, and tests).
- Tests use a deterministic fake executable path or `PATH` override to prove success, failure mapping, timeout, and redaction.
**Dependencies:** Task 2.1.
#### Task 3.2: Export and boundary-test the helper

**Description:** Export the helper and its public types from the GitHub adapter package public entry point, and add a focused boundary assertion or source scan that prevents production issue reads from bypassing the helper.
**Acceptance criteria:**
- `executeGh`, `GhExecError`, and companion types are available from the GitHub adapter package public entry point for adapter tests and server wiring where needed.
- A test fails if production issue-read code shells out to `gh issue view` outside the GitHub adapter/helper path.
- The boundary assertion does not ban future unrelated code-host `gh` use; it is scoped to issue reads for this feature.
**Dependencies:** Task 3.1.
### Story 4: Implement the GitHub issue-tracker adapter

#### Task 4.1: Add `GitHubIssueTracker`

**Description:** Add `packages/github-issue-tracker-adapter/src/index.ts` implementing `IssueTrackerPort` for GitHub. Resolve the credential through `SecretResolver`, call `executeGh` with `gh issue view`, validate provider JSON with a schema, and normalize the result to `TrackedIssue`.
**Acceptance criteria:**
- The adapter requires `target.provider === "github"` and repository `owner`/`name`.
- The adapter requires a usable credential reference and calls `SecretResolver.resolveSecret` immediately before execution.
- The adapter invokes `gh issue view  --repo / --json number,title,body,labels,state,url` through the shared helper.
- GitHub label objects are normalized to label name strings.
- Null or missing GitHub body maps to `""`.
- GitHub issue state maps to `open`, `closed`, or `unknown` while preserving API contract validation.
- Invalid JSON or schema failures map to `IssueTrackerError('tracker_response_invalid')`.
- `GhExecError` failures map to safe `IssueTrackerError` codes without leaking secrets.
**Dependencies:** Task 3.1.
#### Task 4.2: Test GitHub adapter behavior and redaction

**Description:** Add adapter tests that exercise realistic `gh` JSON output and failure paths without injecting a prebuilt `TrackedIssue` into intake.
**Acceptance criteria:**
- Success tests assert issue number, title, body, labels, state, and URL mapping.
- Failure tests cover missing target fields, missing credential, secret resolution failure, auth failure, missing issue, unavailable provider, invalid JSON, and invalid schema data.
- Tests assert token values are absent from thrown messages and safe details.
- Tests prove the adapter passes the explicit `--repo owner/name` target and does not rely on current working directory.
**Dependencies:** Task 4.1.
#### Task 4.3: Export the GitHub adapter

**Description:** Export `GitHubIssueTracker` and `GitHubIssueTrackerOptions` from `packages/github-issue-tracker-adapter/src/index.ts`.
**Acceptance criteria:**
- Server wiring can import the GitHub adapter from `@autocatalyst/github-issue-tracker-adapter`.
- Public exports match this spec.
- Internal adapter parsing helpers remain package-private.
**Dependencies:** Task 4.1.
### Story 5: Add the issue-reference intake resolver seam

#### Task 5.1: Implement issue-reference recognition and target resolution

**Description:** Add `packages/core/src/issue-reference-intake.ts` with `DefaultIssueReferenceIntakeResolver`. It should identify structured issue references and narrow free-form references, validate the project, build a provider-neutral tracker target from project settings, and read through the tracker registry.
**Acceptance criteria:**
- Structured `issue_reference` submissions require one integer issue number.
- Free-form bodies recognize one supported issue reference such as `issue 71`, `issue #71`, or `#71` even when `workKind` is absent from the request.
- Free-form bodies with no recognized issue reference keep the explicit `workKind` path when `workKind` is present and produce `IssueReferenceIntakeError('work_kind_unresolved')` when it is absent.
- Multiple recognized issue numbers produce `IssueReferenceIntakeError('issue_reference_ambiguous')`.
- Missing project, cross-tenant project, missing tracker settings, unsupported provider, invalid target, missing credential, zero fallback `issue_tracker` credentials, or multiple fallback `issue_tracker` credentials produce safe intake errors before any run is created.
- The resolver uses `IssueTrackerRegistry.get(provider)` and never instantiates a provider-specific adapter directly.
**Dependencies:** Task 2.1, Task 4.1.
#### Task 5.2: Implement deterministic work-kind settlement

**Description:** Inside the resolver module, settle work kind from enriched issue labels and title cues according to the agreed deterministic rules, then validate the workflow exists with `getRunWorkflowForWorkKind` or the injected workflow lookup.
**Acceptance criteria:**
- Exact normalized labels `feature`, `enhancement`, `bug`, and `chore` are preferred over title cues.
- Exactly one work-kind label settles the work kind.
- Several work-kind labels refuse as ambiguous.
- `feat:`, `fix:`, and `chore:` title prefixes work as fallback cues when no work-kind label exists.
- Missing or unsupported cues produce `IssueReferenceIntakeError('work_kind_unresolved')`.
- Workflow lookup failure also produces `work_kind_unresolved`.
- Unit tests cover every mapping, ambiguity, and unknown case.
**Dependencies:** Task 5.1.
#### Task 5.3: Normalize resolver output and safe error wrapping

**Description:** Complete resolver output and error behavior so service code receives `ResolvedConversationCreate` or `IssueReferenceIntakeError` only. Wrap tracker failures as `tracker_read_failed` with safe `trackerCode` details.
**Acceptance criteria:**
- Resolved issue-reference creates return settled `workKind`, enriched `trackedIssue`, and the original submission body as `messageBody`.
- Non-issue explicit creates, including free-form bodies with no issue reference and a caller-supplied `workKind`, return the caller's `workKind`, optional caller-supplied `trackedIssue`, and original body.
- For free-form issue references, caller-supplied `workKind` and `trackedIssue` are ignored in favor of tracker settlement.
- Tracker failures are wrapped as `IssueReferenceIntakeError('tracker_read_failed')` with only the underlying safe tracker code exposed.
- Tests assert no secret handles or token values appear in resolver errors unless an existing secret-handle policy explicitly permits handles.
**Dependencies:** Task 5.2.
#### Task 5.4: Export the intake resolver seam

**Description:** Update `packages/core/src/index.ts` to export the resolver interface, default implementation, options, input/output types, and error types.
**Acceptance criteria:**
- Server and tests can construct `DefaultIssueReferenceIntakeResolver` from the core public entry point.
- Internal free-form regex helpers and settlement helpers are not exported.
- Core index tests or type tests prove the public exports compile.
**Dependencies:** Task 5.3.
### Story 6: Wire issue-reference intake into conversation creation

#### Task 6.1: Add project loading and intake resolver dependency to `DefaultControlPlaneService`

**Description:** Update `packages/core/src/control-plane-service.ts` so `createConversationWithFirstRun` loads the request project, calls the intake resolver, and passes only normalized create data to the orchestrator.
**Acceptance criteria:**
- `DefaultControlPlaneServiceOptions` includes the project repository and `IssueReferenceIntakeResolver` dependency described in this spec.
- The service authorizes `conversation.create` as it does today before run creation.
- The service loads the project for `request.projectId` and passes project, tenant, principal, and submission to the resolver.
- The orchestrator receives resolver-settled `workKind`, resolver-provided `trackedIssue`, and the original message body.
- `IssueReferenceIntakeError` maps to `ControlPlaneServiceError('intake_routing_error')`.
- Existing orchestrator errors still map to their current service errors.
**Dependencies:** Task 5.4.
#### Task 6.2: Prove no run is created on intake refusal

**Description:** Add or update core service tests around `DefaultControlPlaneService.createConversationWithFirstRun` for issue-reference success and failure before orchestrator creation.
**Acceptance criteria:**
- A structured issue-reference request calls the resolver and then orchestrator with settled data.
- A free-form issue-reference request preserves the first inbound message body.
- A resolver refusal returns `intake_routing_error`.
- When resolver refusal occurs, `orchestrator.createConversationWithFirstRun` is not called.
- Existing non-issue single-stage service tests remain valid.
**Dependencies:** Task 6.1.
#### Task 6.3: Wire the resolver and GitHub adapter in the control-plane server

**Description:** Update `apps/control-plane/src/server.ts` or the local composition module to import `GitHubIssueTracker` from `@autocatalyst/github-issue-tracker-adapter`, construct `GitHubIssueTracker`, `StaticIssueTrackerRegistry`, and `DefaultIssueReferenceIntakeResolver`, and use the existing `SqliteSecretStore` as the `SecretResolver`.
**Acceptance criteria:**
- Production server composition registers the GitHub tracker adapter for provider key `github`.
- The adapter receives the unlocked service secret store through the `SecretResolver` seam.
- `DefaultControlPlaneService` receives the project repository and intake resolver.
- Server tests can inject fakes or deterministic helper options without live GitHub credentials.
- Startup logs or diagnostics do not include tracker token values or secret plaintext.
**Dependencies:** Task 4.3, Task 6.1.
### Story 7: Add end-to-end issue-reference create proofs

#### Task 7.1: Add contract and persistence compatibility tests

**Description:** Add targeted tests for request schemas, tracked issue parsing, and persisted run reads after `TrackedIssue` enrichment.
**Acceptance criteria:**
- API contract tests cover issue-reference request validation and explicit-work request preservation.
- Persistence tests prove old tracked issue JSON reads with defaulted `body` and `labels`.
- Persistence tests prove enriched tracked issues persist and read back unchanged.
- Artifact linked issue parsing remains compatible with legacy and enriched tracked issue JSON.
**Dependencies:** Task 1.2, Task 1.3.
#### Task 7.2: Add service-level issue-reference integration tests with realistic fake `gh`

**Description:** Add service or network-level tests that start a run from an issue reference while exercising the GitHub adapter through a real subprocess path to a deterministic fake `gh` executable. The fake `gh` only replaces the binary; project credentials are seeded in the real `SqliteSecretStore` and resolved through `SecretResolver`.
**Acceptance criteria:**
- A `POST /v1/conversations`-level test creates a run from `submission.kind: "issue_reference"` with no caller-supplied `workKind` or `trackedIssue`.
- A second test creates a run from free-form text such as `work on issue #N`.
- The fake `gh` executable returns a fixture derived from actual `gh issue view  --json number,title,body,labels,state,url` output, including GitHub label objects with `name` properties.
- Tests assert the created run has the settled `workKind`, current workflow start step, and enriched `trackedIssue`.
- Tests assert the first inbound message remains the original human submission body.
- The test path does not inject an enriched `TrackedIssue` directly into service intake.
- The test seeds a fake token sentinel in `SqliteSecretStore`, resolves it through `SecretResolver`, and asserts the sentinel is not leaked to returned errors, logs, or persisted failure reasons.
**Dependencies:** Task 6.3.
#### Task 7.3: Add failure and redaction integration tests

**Description:** Add integration tests for unresolvable issue references, tracker/auth failures, and ambiguous work-kind settlement.
**Acceptance criteria:**
- A forced issue-read failure returns HTTP 400 with `error.code: "intake_routing_error"`.
- No conversation, run, or run-step is created for boundary refusals.
- Ambiguous issue references and ambiguous work-kind labels return `intake_routing_error`.
- Captured errors, logs, returned details, and persisted run failure reasons do not contain the token or fake secret sentinel.
- Existing active-run conflict and persistence-failure behavior is unchanged for successful intake followed by orchestrator failure.
**Dependencies:** Task 7.2.
#### Task 7.4: Add skipped-by-default live GitHub proof

**Description:** Add a concrete, runnable skipped-by-default live test that reads a real GitHub issue only when explicit environment variables and seeded credentials opt in. This is not a CI gate by default, but it must be easy to run manually at the manual-test gate.
**Acceptance criteria:**
- The live test is skipped unless an opt-in variable such as `AUTOCATALYST_LIVE_GITHUB_ISSUE_READ=1` is set.
- The live test requires repository owner/name, issue number, and a seeded credential handle or safe test secret setup that uses `SqliteSecretStore` / `SecretResolver`.
- The live test executes the real `gh issue view  --repo owner/name --json number,title,body,labels,state,url` path through the adapter and validates the adapter parser against GitHub output.
- CI does not require live GitHub credentials by default.
- Live-test skips are explicit and do not mask deterministic fake-`gh` coverage.
**Dependencies:** Task 7.2.
### Story 8: Update documentation, code map, and validation guardrails

#### Task 8.1: Update agent code map and operator notes

**Description:** Update `context-agent/wiki/code-map.md` during implementation to record the tracker port, GitHub adapter, `gh` helper, registry, intake resolver, and control-plane server wiring. Add operator notes if any new environment variables or live-test setup are introduced.
**Acceptance criteria:**
- The code map lists the chosen file locations and responsibilities for all new modules.
- The code map records targeted test commands for the issue-reference path.
- Operator docs or code-map notes explain live GitHub proof opt-in variables if added.
- No human-owned requirement, design, or tech spec content is changed without approval.
**Dependencies:** Task 6.3, Task 7.2.
#### Task 8.2: Run targeted validation

**Description:** Run the targeted tests listed in the tech spec after implementation, starting with package-level tests for changed areas.
**Acceptance criteria:**
- `pnpm nx test api-contract -- conversation-ingress.spec domain-value-objects.spec` passes, or the exact updated targeted command passes if spec file names differ.
- `pnpm nx test core -- issue-reference-intake.spec control-plane-service.spec` passes, or equivalent targeted core tests pass.
- `pnpm nx test github-issue-tracker-adapter -- github-issue-tracker.spec gh-exec.spec` passes, or equivalent targeted GitHub adapter tests pass.
- `pnpm nx test control-plane -- integration.spec` or the new focused control-plane integration test passes.
- `pnpm nx test persistence -- domain-repositories.spec` passes if persistence parsing changed.
- `pnpm test:boundaries` passes after adding the `gh` issue-read boundary assertion.
**Dependencies:** Task 7.3, Task 8.1.
#### Task 8.3: Run broad validation before handoff

**Description:** Run the repository's broader validation once targeted tests pass and document any skipped checks with the exact reason.
**Acceptance criteria:**
- `pnpm validate` passes, or each failure is documented with its failing command, relevant output summary, and whether it is related to this feature.
- Any skipped live GitHub proof is marked as unsupported in the handoff unless the opt-in environment was available and the test passed.
- The final implementation handoff names unsupported providers directly: GitHub is implemented; Jira and other providers fail through unsupported-provider behavior.
**Dependencies:** Task 8.2.
### Dependency graph

- **Critical path:** Task 1.1 → Task 1.2 → Task 1.3 → Task 2.1 → Task 3.1 → Task 4.1 → Task 5.1 → Task 5.2 → Task 5.3 → Task 5.4 → Task 6.1 → Task 6.2 → Task 6.3 → Task 7.2 → Task 7.3 → Task 8.1 → Task 8.2 → Task 8.3.
- **Parallel tracks:** Task 2.2 can follow Task 2.1 while the GitHub helper begins; Task 3.2 can follow Task 3.1 alongside Task 4.1; Task 4.2 and Task 4.3 can follow Task 4.1 in parallel; Task 7.1 can start after Tasks 1.2 and 1.3 while service wiring continues; Task 7.4 can follow Task 7.2 without blocking CI-oriented failure coverage.
- **Integration gates:** Task 6.3 is the production composition gate for end-to-end tests; Task 7.3 is the failure/redaction gate before documentation and validation.
### Task-list reviewer pass

The task list covers the contract, core tracker port, safe GitHub helper, GitHub adapter, issue-reference resolver, control-plane wiring, persistence compatibility, end-to-end proof, documentation, and validation work described in the product, design, and tech sections. Leaf tasks have concrete acceptance criteria and explicit dependencies. The main implementation risk is sequencing: adapter tests can progress with fakes, but full service-level proof depends on both production wiring and deterministic fake-`gh` composition.
### Task-list approval

Approval is pending human review. The parent spec remains `status: draft` until the task decomposition and full artifact are explicitly approved.