---
created: 2026-10-22
last_updated: 2026-10-22
status: approved
issue: 114
specced_by: markdstafford
---
# Codex SDK/app-server adapter using enterprise sign-in

## Requirements

### What

Autocatalyst will add a distinct Codex agent adapter that can run existing model roles through an operator-approved Codex or ChatGPT enterprise sign-in. A configured provider profile can select this adapter for spec authoring, implementation, review, or pull-request finalization without changing workflow orchestration or replacing the existing OpenAI Agents SDK, Claude Agent SDK, Anthropic direct, or OpenAI direct adapters.

### Why

This gives Autocatalyst users another approved way to run model-backed work: through Codex with enterprise sign-in. The feature broadens provider choice so projects can use different model and authentication schemes without changing workflow orchestration.

### Goals

- A provider profile can select Codex through the existing `AgentProviderAdapter` path while existing profiles continue to behave as before.
- Enterprise Codex authentication works without requiring a Platform API key, unrelated endpoint, or copied cached token in Autocatalyst secrets.
- Workspace permissions match Autocatalyst role intent: implementers can persist changes in the run workspace and reviewers cannot change repository state.
- Runtime-resolved skills are delivered to Codex through the selected supported mechanism, and diagnostics report requested, resolved, and delivered skills.
- Existing structured-result contracts remain authoritative for spec authoring, implementation/review rounds, and PR finalization.
- Stream events, session outcomes, model identity, and available usage data flow through existing runner contracts with safe failure behavior.

### Personas

- **Phoebe (PM)** seeds issue-driven work and needs confidence that the spec and PR flow can continue when the default provider changes.
- **Enzo (Engineer)** configures and validates provider profiles, checks runtime permissions, and debugs provider failures without seeing secrets.
- **Operator** approves enterprise Codex sign-in on the host and needs the system to use exactly that identity, not a fallback billing account.

### Narrative

Enzo wants a project to use Codex with enterprise sign-in for the next feature run. He creates a Codex-backed profile that points to the approved enterprise identity and routes spec authoring to it. The run pauses at the normal spec review gate with the same artifact shape as before, but the session metadata shows Codex as the adapter and marks usage as unavailable if the app-server protocol does not report it.

Later, Phoebe approves a spec and an implementation run uses Codex as implementer while the reviewer role is configured read-only. The implementer changes files in the workspace. The reviewer attempts to inspect the repository and write a note through normal review output, but any repository write is rejected and the structured reviewer result is still captured through the adapter-owned result path.

### User stories

- As an operator, I want to configure a Codex profile that uses enterprise sign-in, so that Autocatalyst can run without unrelated provider or Platform API-key billing for that profile.
- As an engineer, I want unsupported Codex settings to fail before a session starts, so that misconfiguration does not create confusing partial runs.
- As an engineer, I want implementer and reviewer permissions enforced by the adapter, so that review cannot mutate repository state.
- As a run observer, I want Codex events and outcomes to appear in the existing event stream, so that UI and persistence code do not need provider-specific branches.
- As a workflow owner, I want Codex sessions to write or capture the same structured results as other adapters, so that downstream orchestration remains unchanged.

### Non-functional requirements

- **Security:** Do not read, copy, persist, or log raw Codex cached credentials. Authentication diagnostics must identify only safe facts such as auth mode, adapter id, account type, and redacted failure codes.
- **Billing safety:** Do not silently switch to API-key billing, unrelated provider, another account, or automatic paid retry when enterprise sign-in is missing, expired, or disallowed.
- **Compatibility:** Use one supported Codex SDK or app-server transport. Do not implement both in this issue. Validate behavior against the runtime version used by Autocatalyst, including accepted sandbox values.
- **Testability:** Deterministic tests must not consume enterprise inference by default. Live smoke checks must be opt-in and operator-authorized.
- **Maintainability:** Provider-specific protocol handling must stay inside the new adapter package and shared execution seams. Orchestrator code must not gain Codex-specific branches.

### Out of scope

- Account provisioning or login UI for Codex or ChatGPT.
- General raw OpenAI API access through this adapter.
- Automatic quota balancing across Platform API keys, enterprise Codex, or other provider accounts.
- Replacing existing Claude, OpenAI Agents SDK, Anthropic direct, or OpenAI direct adapters.
- Starting a new end-to-end run or approving any human gates as part of this feature.

## Design spec

This is a backend/runtime feature with no new product UI. Existing control-plane configuration surfaces continue to create credentials, endpoints, profiles, and routing tables. Operator-facing design work is limited to clear configuration names, safe diagnostics, and documentation.

### Configuration experience

- The adapter has a distinct provider/profile identity, for example `providerKind: codex` and an adapter id that names the selected transport such as `codex-app-server`.
- Profile settings show which model is requested, which inference settings are supported, and which unsupported settings are rejected.
- Authentication mode is explicit, for example enterprise app-server sign-in, and does not ask the operator to paste cached Codex credentials into Autocatalyst secrets.

### Diagnostics experience

- Startup composition reports whether the Codex adapter is registered and which connection mechanism it supports.
- Failed authentication reports an actionable safe code such as missing sign-in, expired sign-in, disallowed plan, or account mismatch when the transport can distinguish them.
- Session metadata reports model identity, adapter id, role, outcome, available token or usage fields, and unavailable usage fields as unavailable rather than zero.
- Skill diagnostics report requested, resolved, and delivered skill identifiers. A session with zero requested skills is not accepted as proof that skill delivery works.

### Documentation experience

Operator docs must describe the supported runtime version, installation or package source, login prerequisite, profile examples, filesystem permission behavior, live smoke command, and expected safe diagnostics. ADR-022 or a linked ADR addendum must explain how the chosen Codex SDK/app-server boundary fits the runner structure, especially if it uses a subprocess rather than an in-process SDK.

## Technical specification

### Overview

Add a new adapter-scoped package for a Codex agent cell and register it through the existing provider composition and routing path. The adapter implements the public `AgentProviderAdapter` contract from `@autocatalyst/execution`, confines Codex protocol details to the package, maps Codex streams to canonical runner events, enforces role permissions, delivers runtime skills, and captures structured results using existing execution result contracts. ADR-022 prefers in-process SDK adapters, so if the selected supported transport is `codex app-server --listen stdio://`, the implementation must document the process boundary and keep the orchestrator/provider abstraction intact.

### Architecture

#### Components

- **New `packages/codex-agent-adapter/`:** Implements Codex session startup, authentication probes, permission mapping, event mapping, skill materialization, structured-result capture, and contract tests.
- **`packages/execution/src/agent-provider-adapter.ts`:** Extend public types only if needed to represent explicit app-server or enterprise-account authentication safely. Reuse existing `ProviderConfigurationError`, `ProviderConnectionError`, `ProviderProtocolError`, and `UnsupportedProviderCapabilityError` where possible.
- **`packages/core/src/provider-composition.ts`:** Validate Codex adapter metadata and profile compatibility through the existing registry/composition flow.
- **`apps/control-plane/src/server.ts`:** Register the Codex adapter factory in production dispatch when available and wire configuration records to the standard agent runner factory.
- **Runtime package manifests and boundary tests:** Add dependencies and project metadata so CI can build and test the adapter reproducibly without relying on a developer PATH.
- **Docs:** Update `context-agent/wiki/code-map.md`, operator docs, and ADR-022 or an ADR addendum with runtime version, auth setup, and verification commands.

#### Boundaries

Provider-specific behavior stays in `packages/codex-agent-adapter`. Shared execution code may gain provider-neutral seams only when Codex exposes a capability that existing contracts cannot represent, such as enterprise-account auth diagnostics or usage-unavailable semantics. Core orchestration, workflow transitions, result schemas, and model routing must remain provider-neutral.

#### Data flow

1. Control-plane startup registers the Codex adapter in the `AgentProviderAdapterRegistry`.
2. Model routing resolves a step and role to a Codex profile.
3. The agent runner factory creates an `AgentConnection` and an agent orchestrator runner for the adapter.
4. Execution materialization provisions workspace roots, scratch root, tool policy, environment, and resolved skills.
5. The Codex adapter starts the selected SDK/app-server session using enterprise sign-in, maps tool permissions from the role, and delivers resolved skills.
6. The adapter streams Codex output and tool activity as canonical `RunnerEvent` values.
7. Structured output is captured to the configured scratch result file or native structured-output channel, then validated by the existing execution entry point.
8. Session metadata and usage availability flow back through the orchestrator and session recorder.

#### Integration points

- Codex SDK or app-server protocol, with exactly one transport selected for implementation.
- Existing enterprise Codex/ChatGPT sign-in on the host, verified without exposing raw cached credentials.
- Existing runtime skills catalog and resolver.
- Existing workspace provisioning and role-based tool policy.
- Existing result contract registry for spec authoring, implementation reviewer/implementer rounds, and PR finalization.

### Data model

No new durable domain entity is expected. Configuration records may need new allowed values for Codex provider kind, adapter id, endpoint connection mechanism, and profile settings. Session records should continue to store provider/model metadata and token usage when available; unavailable Codex usage must be represented as unavailable/degraded metadata, not fabricated zero-cost usage.

### API contracts and interfaces

- Existing configuration-record APIs continue to create endpoint and provider-profile records. Any schema change should be additive and typed, such as allowing a Codex provider kind and a Codex enterprise auth mode.
- `AgentProviderAdapter` remains the main interface. The adapter must implement `startSession(input)` and return a session with canonical events, metadata, token usage when available, and safe degraded-capability notes.
- `structuredResultCapture` from `RunnerRunInput` must be honored. If Codex cannot support native schema-constrained output for a contract, the adapter must use an adapter-owned capture path that does not require reviewer repository write access.
- Unsupported inference settings must throw a clear `UnsupportedProviderCapabilityError` or typed configuration error before paid work begins.

### Authentication and permissions

The adapter must use an explicit operator-approved enterprise sign-in mode. Missing, expired, disallowed, or mismatched sign-in fails safely with redacted diagnostics. The adapter must not fall back to `OPENAI_API_KEY`, unrelated provider endpoints, another account, or copied cached tokens.

Implementer sessions can write to the run workspace according to the materialized tool policy. Reviewer sessions must enforce read-only repository access. A rejected reviewer write attempt must leave repository contents unchanged while still allowing the reviewer result to be captured through scratch, native structured output, or another adapter-owned non-repository channel.

### Skills

The adapter must materialize `ResolvedSkill[]` from the runtime catalog through the supported Codex mechanism. Tests and diagnostics must cover at least one nonempty requested skill. Missing skills and delivery failures fail explicitly and report requested, resolved, and delivered skill facts safely. The adapter must not depend on unrelated personal skills, plugins, or host-local extensions.

### Structured results

Existing schemas remain authoritative. The adapter must support:

- spec authoring output through `autocatalyst.spec_author.v1` to `step-result.json`;
- implementation reviewer output through `autocatalyst.reviewer_result.v1` to the per-round reviewer result file;
- implementation implementer dispositions through `autocatalyst.implementer_dispositions.v1` to the per-round implementer result file;
- PR finalization through `autocatalyst.pr_finalize.v1` to `pr-finalize-result.json`, never stale `step-result.json`.

Missing, malformed, duplicate, or unsupported structured output must fail explicitly. The adapter must not fabricate successful results.

### Error handling and observability

- Cancellation, timeout, abnormal app-server exit, protocol errors, and authentication failures terminate cleanly with redacted diagnostics.
- No automatic paid retry is allowed after a Codex protocol or auth failure. Bounded transport retry is acceptable only where the selected protocol and existing execution connection layer already support safe transient retry.
- Stream events must include assistant turns, tool activity, progress/notification events where available, terminal outcome, model identity, and degraded capabilities.
- Session continuity, if used, must be scoped by run and role and must not leak across runs.

### Testing strategy

- Unit tests for adapter metadata, profile/settings translation, authentication failure classification, event mapping, structured-result capture, permission mapping, cancellation, timeout, and abnormal process exit.
- Contract tests with a fake Codex SDK/app-server transport; no real enterprise inference in default tests.
- Integration tests proving provider composition, routing/profile selection, control-plane factory registration, and existing OpenAI/Claude adapter tests still pass.
- Workspace tests proving implementer writes persist and reviewer write attempts are rejected with repository contents unchanged.
- Skill tests proving nonempty requested skill delivery and missing-skill failure behavior.
- Result tests proving spec output, distinct implementation/reviewer rounds, invalid/missing outputs, and PR finalization when stale `step-result.json` is present.
- Opt-in live smoke procedure using approved enterprise sign-in. Record adapter/model, auth mode without secrets, terminal outcome, skill delivery, permissions, and result capture.

### Operational concerns

- Pin or document the supported Codex CLI/SDK/app-server version. The 2026-10-22 probe used Codex CLI 0.160.1 and accepted sandbox value `read-only`; implementation must validate against the supported runtime rather than assuming documentation examples.
- Startup must fail or degrade clearly if required Codex runtime dependencies are unavailable.
- Logs must redact tokens, account caches, raw app-server messages that may contain secrets, request headers, and filesystem paths that expose credential locations.
- Live smoke tests are opt-in and must not start new E2E runs or approve gates automatically.

### Open questions

- Select the supported transport: Codex SDK as a library or Codex app-server over stdio. This should be decided before implementation and documented in ADR-022 or a follow-up ADR.
- Determine the exact provider kind, adapter id, and connection mechanism names accepted by configuration schemas.
- Confirm whether Codex reports token/usage data through the selected transport and how unavailable usage should be represented in session metadata.
- Confirm the safest Codex mechanism for skill delivery and structured result capture under reviewer read-only permissions.

## Task list

### Story 1: Choose and scaffold the Codex adapter cell

Create the new adapter package and make one explicit transport decision before integrating behavior.

#### T-001: Record the Codex transport decision

**Description:** Decide whether the adapter uses the supported Codex SDK or app-server protocol. Document how the chosen process or library boundary fits ADR-022 and why the other option is out of scope for this issue.

**Acceptance criteria:**
- ADR-022 or a linked ADR/addendum states the selected transport and supported runtime version.
- The document explains auth, event streaming, structured output, and process lifecycle implications.
- The document states that implementing both transports is out of scope.

**Dependencies:** none.

#### T-002: Generate `packages/codex-agent-adapter/`

**Description:** Add the adapter-scoped package using project conventions, package metadata, exports, and placeholder tests.

**Acceptance criteria:**
- Package builds, lints, and tests through Nx targets.
- Package imports only public APIs from `@autocatalyst/execution`.
- `context-agent/wiki/code-map.md` documents the new package and test command.

**Dependencies:** T-001.

### Story 2: Implement Codex session protocol and safe authentication

Make Codex sessions start, fail, and close safely through enterprise sign-in.

#### T-003: Implement adapter metadata and profile validation

**Description:** Implement `AgentProviderAdapter` metadata, settings translation, and fail-fast validation for unsupported inference settings.

**Acceptance criteria:**
- Adapter exposes distinct provider kind, adapter id, mode, and connection mechanism.
- Supported inference settings reach Codex in tests.
- Unsupported required settings fail with typed safe errors before session start.

**Dependencies:** T-002.

#### T-004: Implement enterprise sign-in authentication checks

**Description:** Start Codex using explicit enterprise sign-in and classify missing, expired, disallowed, or mismatched auth without reading or logging cached credentials.

**Acceptance criteria:**
- Tests cover success and each deterministic auth failure class exposed by the fake transport.
- The adapter does not fall back to `OPENAI_API_KEY`, unrelated provider, or another account.
- Logs and thrown errors contain no raw credentials, cached token paths, or upstream secret text.

**Dependencies:** T-003.

#### T-005: Map Codex streaming lifecycle to runner events

**Description:** Convert Codex assistant output, tool activity, progress, terminal outcomes, usage, and protocol errors into canonical runner events and metadata.

**Acceptance criteria:**
- Streamed events arrive before terminal completion in tests.
- Metadata includes adapter id, model identity, outcome, usage when available, and degraded usage when unavailable.
- Cancellation, timeout, abnormal exit, and protocol violation tests terminate cleanly.

**Dependencies:** T-003, T-004.

### Story 3: Enforce workspace permissions and deliver skills

Ensure Codex obeys Autocatalyst execution context for each role.

#### T-006: Map tool policy to Codex filesystem permissions

**Description:** Translate materialized implementer and reviewer tool policies into Codex sandbox/filesystem permissions.

**Acceptance criteria:**
- Implementer writes persist in the run workspace.
- Reviewer write attempts are rejected.
- Repository contents remain unchanged after rejected reviewer writes.
- If Codex cannot enforce reviewer read-only, reviewer sessions fail with a safe unsupported-capability error.

**Dependencies:** T-005.

#### T-007: Materialize runtime skills for Codex

**Description:** Deliver resolved runtime skills to Codex through the selected supported mechanism and report requested/resolved/delivered skills.

**Acceptance criteria:**
- A test with at least one requested skill proves delivery through Codex-visible diagnostics.
- Missing-skill behavior fails explicitly.
- The adapter does not depend on personal host skills, plugins, or non-catalog paths.

**Dependencies:** T-005.

### Story 4: Capture structured results without weakening role permissions

Make Codex produce the same output contracts as existing adapters.

#### T-008: Project and capture Codex structured results

**Description:** Implement Codex structured-result capture for existing step result contracts, using native schema output if supported or an adapter-owned scratch capture path otherwise.

**Acceptance criteria:**
- Spec authoring writes a valid `step-result.json`.
- Implementation implementer and reviewer rounds write distinct per-round files.
- Reviewer result capture works without repository write access.
- Missing, duplicate, malformed, or unsupported structured output fails explicitly.

**Dependencies:** T-005, T-006.

#### T-009: Verify PR finalization result isolation

**Description:** Ensure Codex PR finalization writes and validates `pr-finalize-result.json` and never consumes stale `step-result.json`.

**Acceptance criteria:**
- Tests include stale `step-result.json` plus valid `pr-finalize-result.json` and pass.
- Tests include missing/invalid `pr-finalize-result.json` and fail safely.
- No finalization path fabricates an advance result.

**Dependencies:** T-008.

### Story 5: Register Codex in composition and document operations

Expose the adapter through normal configuration and give operators reproducible validation steps.

#### T-010: Register Codex in provider composition and control-plane startup

**Description:** Add Codex adapter registration, configuration validation, and routing/profile selection support through existing registries.

**Acceptance criteria:**
- Composition tests cover Codex profile selection and misconfiguration failures.
- Control-plane startup can register Codex without affecting existing OpenAI/Claude adapters.
- Existing adapter tests and routing tests continue to pass.

**Dependencies:** T-003.

#### T-011: Add deterministic integration coverage

**Description:** Add tests that exercise Codex through the production dispatch path using fake transport credentials and no paid calls.

**Acceptance criteria:**
- Tests cover streamed completion, cancellation, timeout, abnormal process exit, auth failures, skills, permissions, and structured results.
- `pnpm validate` passes.
- Boundary tests prove the new package respects public execution imports.

**Dependencies:** T-006, T-007, T-008, T-009, T-010.

#### T-012: Document operator setup and live smoke procedure

**Description:** Document clean-checkout installation, configuration records, enterprise sign-in prerequisite, safe diagnostics, and opt-in live smoke validation.

**Acceptance criteria:**
- Operator docs include supported runtime version and exact verification commands.
- Live smoke procedure records adapter/model, auth mode without secrets, terminal outcome, skill delivery, permissions, and result capture.
- Docs state that live smoke does not start a new E2E run or approve human gates automatically.

**Dependencies:** T-010, T-011.

### Dependency graph

Critical path: T-001 → T-002 → T-003 → T-004/T-005 → T-006/T-007 → T-008 → T-009 → T-011 → T-012.

Parallel work: T-004 and T-005 can proceed after T-003; T-006 and T-007 can proceed after T-005; T-010 can proceed after T-003 and then join before T-011.
