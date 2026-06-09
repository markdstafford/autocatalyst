# Code map

Last updated: 2026-06-08 (orchestrator service ingress: orchestrator + control-plane-service + run events + bounded dispatch + conversation ingress routes/SDK; end-to-end proven; isolated per-run workspace provisioning)

> How agents navigate the codebase. Keep this current: whenever you add, move, or significantly
> change a module, update the relevant section in the same change.

## Source tree

- `apps/control-plane/` — bootable headless Fastify control-plane service. `src/config.ts` reads `CONTROL_PLANE_PORT`/`CONTROL_PLANE_DATABASE_PATH`/`CONTROL_PLANE_BEARER_TOKEN`/`CONTROL_PLANE_MASTER_SECRET`/`AUTOCATALYST_RUN_CONCURRENCY` (default `2`) or CLI flags (`--port`, `--database-path`, `--bearer-token`, `--master-secret`, `--run-concurrency`); `src/server.ts` composes routes with persistence, unlocks `SqliteSecretStore` on startup, accepts `ControlPlaneServerOptions` (bearerToken, masterSecret, databasePath, runConcurrency, optional policy/health/extensionRegistry/providerAdapters/onProviderComposition, optional `unitOfWork: RunUnitOfWork` and `onControlPlaneReady(service)` for tests), wires `InMemoryRunEventBus`, `RunDispatchQueue`, `DefaultOrchestrator`, and `DefaultControlPlaneService`; reads persisted configuration records once during startup, invokes `composeConfiguredProviders`, exposes the structured result through `onProviderComposition`, and logs sanitized production diagnostics through `logProviderCompositionDiagnostics`; `src/main.ts` is the executable entrypoint; `src/integration.spec.ts` proves health, probe-resource persistence across restart, SSE, degraded database health, startup provider composition with fake adapters, and orchestrator ingress end-to-end over the network (`POST /v1/conversations`, `GET /v1/runs/:id`, `GET /v1/runs/:id/steps`, SSE `GET /v1/runs/:id/events` with a real `run_state_transition` frame after a tick); `src/control-plane-service.integration.spec.ts` proves the same end-to-end path at the service level with a real SQLite DB + `DrizzleConversationIngressRepository` + `DefaultOrchestrator` + `InMemoryRunEventBus` + `DefaultControlPlaneService`.
- `packages/api-contract/` — shared API contract package. `src/health.ts`, `src/probe-resource.ts`, `src/errors.ts`, and `src/sse.ts` own Zod schemas, inferred types, route constants, and status constants. `src/principal.ts` owns `principalKindSchema`, `principalSchema`, `principalDiagnosticResponseSchema`, and `principalDiagnosticPath = '/v1/principal'`. `src/secret.ts` owns `secretHandleSchema`, `secretCollectionPath = '/v1/secrets'`, `createSecretRequestSchema`, and `createSecretResponseSchema`. `src/configuration-record.ts` owns full CRUD Zod schemas: `createConfigurationRecordRequestSchema`, `configurationRecordResponseSchema`, `configurationRecordListResponseSchema`, `updateConfigurationRecordRequestSchema`, `deleteConfigurationRecordSuccessStatusCode`, and `configurationRecordCollectionPath = '/v1/configuration-records'`. `src/errors.ts` also exports error code constants: `unauthorizedErrorCode`, `validationErrorCode`, `notFoundErrorCode`, `secretStoreLockedErrorCode`. `src/openapi.ts` generates OpenAPI from those schemas and constants. Domain entity schemas (all Zod, all with inferred TS types): `src/domain-value-objects.ts` — shared value objects: `ModelIdentity`, `TokenBreakdown`, `Cost`, `TrackedIssue`, `ChannelReference`, `FeedbackAnchor`, `FeedbackThread`, `TestingGuideResult`, `InferenceSettings`, `SessionRole`, `FrontedResource`, `CredentialReference`, `JsonValue`, `NonModelPrincipal`; also exports `requireTenantMatchesOwner` helper. `src/project.ts` — `Project` + `CreateProjectInput`. `src/conversation.ts` — `Conversation` + `CreateConversationInput` (nullable `activeTopicId`). `src/topic.ts` — `Topic` + `CreateTopicInput` (`kind: main|side`, no `isActive` marker). `src/message.ts` — `Message` + `CreateMessageInput` (`direction: inbound|outbound`). `src/run.ts` — `Run` + `CreateRunInput` (`currentStep`: extensible string, `terminal`: bool; no `status`/`RunStatus`). `src/artifact.ts` — `Artifact` + `CreateArtifactInput` (`kind`, `canonicalRecord`, `cachedStatus` enums). `src/feedback.ts` — `Feedback` + `CreateFeedbackInput` (`target`, `status` enums, optional `anchor`, `thread`). `src/publication.ts` — `Publication` + `CreatePublicationInput` (`frontedResource`). `src/pull-request.ts` — `PullRequest` + `CreatePullRequestInput` (`state: open|merged|closed`). `src/run-step.ts` — `RunStep` + `CreateRunStepInput` (no owner/tenant — parent-hung). `src/session.ts` — `Session` + `CreateSessionInput` (`tokens` must equal `cost.tokens`; no owner/tenant). `src/test-result.ts` — `TestResult` + `CreateTestResultInput` (no owner/tenant). Tests: `__tests__/domain-value-objects.spec.ts`, `__tests__/domain-entities.spec.ts`. Public entry point: `packages/api-contract/src/index.ts`.
- `packages/core/` — control-plane core package. New ingress modules: `src/orchestrator.ts` owns `Orchestrator`/`DefaultOrchestrator` with `createRun`, `createConversationWithFirstRun`, `applyDirective`, `dispatch`, `tick`, the `RunUnitOfWork` seam (`{ run(input: RunWorkInput): Promise<RunWorkResult> }`), and `OrchestratorError`/`OrchestratorErrorCode` (`active_run_conflict`/`missing_run`/`terminal_run`/`invalid_transition`/`unknown_work_kind`/`forbidden`/`persistence_failed`); `src/control-plane-service.ts` owns the `ControlPlaneService` facade (`DefaultControlPlaneService`) consumed by routes — `createConversationWithFirstRun`, `getRun`, `listRunSteps`, `subscribeRunEvents`, `tick` — plus `ControlPlaneServiceError`; `src/run-events.ts` owns `RunEventBus`/`RunEventPublisher`/`RunEventSubscriber`, `RunEventSubscription`, `createRunStateTransitionEvent`, and the live-only `InMemoryRunEventBus` (per-(runId,tenant) subscribers, no durable replay; subscribers must register before the transition they want to observe); `src/run-dispatch-queue.ts` owns the bounded `RunDispatchQueue` (positive-integer `maxConcurrent`, `activeCount`/`queuedCount`, FIFO, slot released even when work rejects). `src/health.ts` owns dependency health behavior; `src/probe-resource.ts` owns proof-resource use cases and repository interfaces; `src/routes.ts` registers Fastify routes using contract schemas; `src/principal.ts` owns `principalSymbol` (Symbol-keyed request context), `attachPrincipalToRequest`, `requirePrincipalFromRequest`, and `hardcodedDevelopmentPrincipal`; `src/auth.ts` owns `registerBearerAuthHook` (Fastify preHandler hook using `timingSafeEqual`) and `BearerAuthOptions`; `src/policy.ts` owns `PolicyDecisionPoint` interface, `PolicyDecisionInput`, `PolicyResourceDescriptor` (discriminated union), `permissivePolicyDecisionPoint`, and `authorizeRequest`; `src/configuration-record.ts` owns `ConfigurationRecordRepository` interface and five thin use-case functions (`createConfigurationRecord`, `listConfigurationRecords`, `getConfigurationRecord`, `updateConfigurationRecord`, `deleteConfigurationRecord`); `src/secret.ts` owns `SecretStore` interface, `SecretStoreLockedError`, and `createSecret` use-case; `src/extension-registry.ts` owns metadata-only provider registry types, `InMemoryExtensionRegistryCatalog`, `defaultExtensionRegistryCatalog`, and advisory registry-warning generation; `src/provider-composition.ts` owns provider adapter-map types, `buildProviderAdapterKey`, `emptyProviderAdapterMap`, and `composeConfiguredProviders` startup composition diagnostics; `src/domain-repositories.ts` — narrow repository interfaces for all 12 domain entities (`ProjectRepository`, `ConversationRepository`, `TopicRepository`, `MessageRepository`, `RunRepository`, `ArtifactRepository`, `FeedbackRepository`, `PublicationRepository`, `PullRequestRepository`, `RunStepRepository`, `SessionRepository`, `TestResultRepository`) and the `DomainRepositories` collection type; no Drizzle imports — and lifecycle-recording methods `recordRunLifecycleStart` and `recordRunStepTransition` on `RunRepository` (atomic start/transition writes); lifecycle input/output types `RecordRunLifecycleStartInput`, `RecordRunLifecycleStartResult`, `RecordRunStepTransitionInput`, `RecordRunStepTransitionResult`, `LifecycleRunStepInput`; `src/run-step-catalog.ts` — run lifecycle step primitives: 18 step definitions, `waitingOn`/`phase`/`roles` catalog, derived sets `terminalSteps`/`modelActiveSteps`/`messageAcceptingSteps`, and helpers `getRunStepDefinition`, `isKnownRunStepId`, `deriveRunTerminal`; `src/run-workflows.ts` — workflow-as-data definitions for `feature`, `enhancement`, `bug`, `chore`, `file_issue`, `question` with exact step paths, transition tables (advance/revise/needs_input/pause-resume edges), and helpers `getRunWorkflowById`, `getRunWorkflowForWorkKind`, `isKnownRunWorkflowId`; `src/run-transition.ts` — pure `nextWorkflowStep(workflow, step, directive) → TransitionResult` transition rule with all typed `TransitionErrorCode` values; `src/run-lifecycle.ts` — `startRunLifecycle` and `applyRunDirective` use cases over `RunRepository` with `RunLifecycleError` and all `RunLifecycleErrorCode` values. Public entry point: `packages/core/src/index.ts`. It may import the execution package through `@autocatalyst/execution` but must not import execution internals.
- `packages/execution/` — execution-plane package. Public entry point: `src/index.ts`, which exports the runner scaffold and workspace provisioning API from `src/workspace.ts` (`ProvisionWorkspaceRequest`, discriminated `ProvisionWorkspaceResult`, `WorkspaceProvisioningError`, `provisionWorkspace`, `redactWorkspaceDiagnostic`, `summarizeWorkspaceCause`). Internal workspace modules are package-private: `src/internal/workspace-paths.ts` owns shape selection, safe segment validation, path resolution, containment checks, and branch-name derivation; `src/internal/workspace-driver.ts` owns argument-array git commands, host clone/fetch/default-branch/worktree operations, credential redaction, and guarded filesystem operations; `src/internal/workspace-provisioner.ts` orchestrates no-workspace, scratch-only, and two-root provisioning plus rollback. Tests: `src/workspace-paths.spec.ts` covers pure helpers, `src/workspace-provisioner.spec.ts` uses fake drivers for orchestration/rollback/error redaction, and `src/workspace.integration.spec.ts` creates temporary real git repositories to prove host clone/worktree/scratch behavior. Useful targeted commands: `pnpm nx test execution -- --testPathPattern=workspace-paths.spec.ts`, `pnpm nx test execution -- --testPathPattern=workspace-provisioner.spec.ts`, `pnpm nx test execution -- --testPathPattern=workspace.integration.spec.ts`, `pnpm nx build execution`, `pnpm nx lint execution`.
- `packages/persistence/` — persistence package. `src/active-run-conflict.ts` owns the typed `ActiveRunConflictPersistenceError` and the `isActiveRunConstraintViolation` recogniser used to translate raw SQLite unique-index errors into the typed conflict. `DrizzleConversationIngressRepository` (in `src/domain-repositories.ts`) implements the `ConversationIngressRepository` seam: `createConversationTopicMessageAndRun` writes conversation+topic+(optional)message+run+initial-runStep atomically in one transaction, sets `activeTopicId` on the conversation, and maps the `runs_one_active_per_topic` constraint violation to `ActiveRunConflictPersistenceError`. `src/sqlite.ts` owns the opaque SQLite handle, migrations, and reachability; `src/schema.ts` is the internal Drizzle schema — control-plane tables: `configurationRecords`, `secretStoreMetadata`, `secrets` (added in migration `0001`); domain tables added in migration `0002`: `projects`, `conversations`, `topics`, `messages`, `runs`, `artifacts`, `feedback`, `publications`, `pullRequests` (SQL: `pull_requests`), `runSteps` (SQL: `run_steps`), `sessions`, `testResults` (SQL: `test_results`); key constraints: `runs_one_active_per_topic` partial unique (WHERE `terminal=0`), `topics_one_main_per_conversation` partial unique (WHERE `kind='main'`), `pull_requests_one_per_run` unique; `src/probe-resource-repository.ts` implements the core probe-resource repository; `src/configuration-record-repository.ts` implements `ConfigurationRecordRepository` (`DrizzleConfigurationRecordRepository`, IDs prefixed `cfg_<uuid>`, settings serialized as JSON, PATCH uses read-modify-write, `credentialSecretHandle: null` removes the key); `src/secret-store.ts` implements `SecretStore` (`SqliteSecretStore`, AES-256-GCM encryption, scrypt KDF N=16384, sentinel row for unlock verification, injectable `randomBytes` for test isolation, handle format `sec_` + 32 base64url chars); `src/domain-row-mappers.ts` — `stringifyJsonValue`, `parseJsonValue`, `parseNullableJsonValue`, `nullableJsonForRow`, `validateEntity`; `src/domain-repositories.ts` — 12 Drizzle repository implementations (`DrizzleProjectRepository`, etc.), `DrizzleDomainRepositories` interface, and `createDrizzleDomainRepositories` factory; also implements lifecycle-owned `DrizzleRunRepository.recordRunLifecycleStart` and `recordRunStepTransition`, which atomically write run state and matching `RunStep` occurrence rows with transaction-computed `index` and `attempt` values. Committed migrations live under `packages/persistence/drizzle/` (migration `0002_even_victor_mancha.sql` creates all 12 domain tables). Tests: `__tests__/domain-migrations.spec.ts`, `__tests__/domain-repositories.spec.ts`, `__tests__/domain-active-run-constraint.spec.ts`. Public entry point: `packages/persistence/src/index.ts`.
- `packages/sdk/` — SDK package. `src/client.ts` exposes typed health, probe-resource, configuration-record (`createConfigurationRecord`, `listConfigurationRecords`, `getConfigurationRecord`, `updateConfigurationRecord`, `deleteConfigurationRecord`), secret (`createSecret`), and orchestrator ingress (`createConversationWithFirstRun`, `getRun`, `listRunSteps`, `subscribeRunEvents`) calls derived from `@autocatalyst/api-contract`. Accepts optional `bearerToken` in `ControlPlaneClientOptions`. Public entry point: `packages/sdk/src/index.ts`.
- `tools/boundary-tests/` — committed lint-level boundary assertions. The invalid fixture is excluded from normal
  package lint and is checked only by `pnpm test:boundaries`.

## Key entry points

- Root workspace metadata: `package.json`, `pnpm-workspace.yaml`, `.npmrc`.
- Nx task graph and cache defaults: `nx.json`.
- Shared TypeScript paths and compiler settings: `tsconfig.base.json`.
- Lint and module-boundary rules: `eslint.config.mjs`.
- Package project metadata and tags: `packages/*/project.json`.

## Build / test / run commands

Run these from the repository root on Node.js 22+:

```bash
pnpm install
pnpm nx show projects
pnpm nx run-many -t build
pnpm nx run-many -t lint
pnpm nx run-many -t test
pnpm test:boundaries
pnpm validate
```

`pnpm validate` runs build, lint, test, then the committed execution-boundary test.

## Control-plane service envelope commands

```bash
# Start the service
CONTROL_PLANE_BEARER_TOKEN=dev-token CONTROL_PLANE_MASTER_SECRET=dev-master-secret CONTROL_PLANE_PORT=3000 CONTROL_PLANE_DATABASE_PATH=.data/control-plane.sqlite pnpm nx serve control-plane

# Run tests
pnpm nx test control-plane
pnpm nx test api-contract
pnpm nx test core
pnpm nx test persistence
pnpm nx test sdk

# Targeted orchestrator-ingress proofs
pnpm nx test core -- orchestrator.spec.ts
pnpm nx test control-plane -- control-plane-service.integration.spec.ts
pnpm nx test persistence -- domain-active-run-constraint.spec.ts
pnpm nx test control-plane -- integration.spec.ts

# Generate future migrations from schema (do not run before adding new schema changes)
pnpm drizzle-kit generate --config packages/persistence/drizzle.config.ts

# Full validation
pnpm validate
```

Orchestrator service ingress routes (added by Story 7-9):

- `POST /v1/conversations` — create a conversation, topic, optional message, run, and initial run step atomically; returns the created `Conversation`/`Topic`/`Message?`/`Run`/`RunStep`. Body schema: `createConversationWithFirstRunRequestSchema` from `@autocatalyst/api-contract`.
- `GET /v1/runs/:id` — return the run for the authenticated tenant. 404 if missing; 403 if cross-tenant.
- `GET /v1/runs/:id/steps` — list run-steps for a run ordered by `(startedAt, id)`. 404/403 like above.
- `GET /v1/runs/:id/events` — Server-Sent Events stream of `run_state_transition` events for the given run+tenant. Headers include `content-type: text/event-stream; charset=utf-8` and `cache-control: no-cache, no-transform`. A `: connected\n\n` comment is flushed immediately after headers so SSE clients (including Node's `fetch`) resolve before the first real event; the bus does not replay history, so subscribers must register before the transition they want to observe. `Last-Event-ID` header is forwarded to the bus.

Provider composition test seams:

- Core registry/composition behavior is covered by `packages/core/src/extension-registry.spec.ts` and `packages/core/src/provider-composition.spec.ts`.
- Control-plane startup composition is inspected through `ControlPlaneServerOptions.onProviderComposition`; production startup logs sanitized summaries through `logProviderCompositionDiagnostics`.

Runtime startup applies committed migrations with `migrateSqliteDatabase(database)`. Use the Drizzle Kit command only to generate future migrations from `packages/persistence/src/schema.ts`; do not require migration generation before running tests or the app.

## Package generation path

Use the built-in Nx JavaScript library generator. This concrete example creates an adapter-scoped package named `example-provider`; use the same command shape for each future package and change only the two shell variable values before running it:

```bash
PACKAGE_NAME=example-provider
PACKAGE_SCOPE=adapter
pnpm nx g @nx/js:library "packages/${PACKAGE_NAME}" \
  --bundler=tsc \
  --unitTestRunner=vitest \
  --linter=eslint \
  --importPath="@autocatalyst/${PACKAGE_NAME}" \
  --strict=true \
  --minimal=true
```

After generation, verify or add these concrete fields for the `example-provider` package in `packages/example-provider/project.json`:

```json
{
  "projectType": "library",
  "tags": ["type:lib", "scope:adapter"],
  "targets": {
    "build": {},
    "lint": {},
    "test": {}
  }
}
```

Use the established initial tags as examples:

- `api-contract`: `type:lib`, `scope:contract`
- `core`: `type:lib`, `scope:core`, `plane:control`
- `control-plane`: `type:app`, `scope:control-plane`, `plane:control`
- `execution`: `type:lib`, `scope:execution`, `plane:execution`
- `persistence`: `type:lib`, `scope:persistence`, `plane:control`
- `sdk`: `type:lib`, `scope:sdk`

## Boundary enforcement

- `@nx/enforce-module-boundaries` is active in `eslint.config.mjs` for TypeScript files.
- `no-restricted-imports` blocks `@autocatalyst/execution/src/*` and relative execution `src/*` patterns.
- `pnpm test:boundaries` lints two committed fixtures:
  - `tools/boundary-tests/fixtures/valid-control-plane-import.ts` must pass with `@autocatalyst/execution`.
  - `tools/boundary-tests/fixtures/invalid-execution-internal-import.ts` must fail with `no-restricted-imports`.
