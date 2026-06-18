---
created: 2026-06-17
last_updated: 2026-06-18
status: complete
issue: 85
issue_url: [https://github.com/markdstafford/autocatalyst/issues/85](https://github.com/markdstafford/autocatalyst/issues/85)
specced_by: autocatalyst
---
# Enhancement: Reconcile merged pull requests automatically

## Product requirements

### What

Autocatalyst should move a run from `pr.human_review` to `done` automatically after the run's pull request is merged on the code host. The existing merge-detection logic already lives in `DefaultOrchestrator.tick` through `detectMerges` and `detectPullRequestMerges`; this enhancement adds a production trigger so that logic runs without a human or test manually calling `tick`.
The production trigger has two required surfaces for B1: a periodic background ticker and a client-callable `/v1` reconcile endpoint. The ticker gives the automatic "done on its own" behavior, while the endpoint gives operators and clients an explicit protected reconciliation action. Background behavior that runs inside the service must be configuration-gated, consistent with the existing auto-dispatch option and control-plane startup style. A merged pull request should be reconciled within a bounded interval, and the run should reach `done` through the same orchestrator-owned transition path used by manual merge detection today.
### Why

The pull-request lifecycle from issue 73 can open a pull request and detect merges correctly when an in-process caller invokes `orchestrator.tick` or `orchestrator.detectMerges`. However, normal production service operation does not call `tick` on an interval, and the network API has no reconcile or tick route. A run whose PR was merged by a human on GitHub can therefore remain parked at `pr.human_review` indefinitely.
That stuck state is confusing because `pr.human_review` is not a normal human reply gate for approval. Replying `approve` does not complete the run; the reply path rejects it as `invalid_transition`. Autocatalyst should own the final state transition after merge, not require an operator to know which internal method to poke.
### Goals

- Drive the existing bounded merge-detection fallback from production triggers.
- Reconcile merged pull requests and advance their runs to `done` without manual intervention.
- Keep the orchestrator as the single authority for run transitions and PR state updates.
- Keep provider reads bounded by count and time, as `detectPullRequestMerges` does today.
- Configuration-gate any periodic background ticker so operators can enable, disable, and tune it explicitly.
- Expose a protected `/v1` reconcile endpoint for client-callable or operator-driven reconciliation.
- Ensure the trigger surfaces do not re-dispatch normal run work, do not treat `pr.human_review` as an approval gate, and do not open a path around existing policy/auth seams.
- Prove the behavior with a real end-to-end test that merges a pull request and observes the run reach `done` through the production trigger, not through the test calling `tick` or `detectMerges` directly.
- Update `context-agent/wiki/code-map.md` during implementation if modules move or new modules are added.
### Non-goals

- Adding webhook-driven merge detection.
- Building a rich in-product pull-request review or merge UI.
- Changing `pr.human_review` into an approval gate.
- Resuming failed terminal runs.
- Reworking the code-host port, PR open handler, or existing merge reconciliation algorithm beyond what the trigger needs.
- Scanning all provider pull requests. Reconciliation starts from locally tracked open `PR` records.
- Making a background ticker required for every test. Targeted tests may configure it explicitly.
### Personas

- **Phoebe (PM)** wants an approved and merged run to finish on its own, without knowing about internal tick methods.
- **Opal (Operator)** needs safe, bounded reconciliation that can run in the service without unbounded provider calls or noisy failures.
- **Enzo (Engineer)** wants one production path for merge reconciliation, covered by an end-to-end test that does not substitute a manual `tick` call for the real trigger.
- **Riley (Reviewer)** wants the external PR merge to remain the final human decision, while Autocatalyst simply observes the merged state and closes the run.
### User stories

- As Phoebe, when I merge an Autocatalyst-created pull request on GitHub, the associated run becomes `done` without another command.
- As Opal, I can enable a bounded reconciliation ticker and choose an interval that matches service needs.
- As Opal, I can disable the ticker if an environment should only reconcile through explicit calls.
- As Enzo, I can call a protected reconcile endpoint and receive a safe summary of checked, merged, closed, failed, and timed-out reconciliation results.
- As Enzo, I can write an end-to-end test that proves production reconciliation completes the run without calling `tick` or `detectMerges` from the test.
- As Riley, if a pull request is closed without merge, the existing reconciliation behavior marks the run failed with a sanitized reason instead of pretending the run completed.
### Acceptance criteria

- Production triggers invoke the existing merge reconciliation path for a tenant through both required B1 surfaces:
	- a periodic background ticker running inside the control-plane service; and
	- a protected `/v1` reconcile endpoint callable by a client or operator.
- Any periodic ticker is configuration-gated. It is disabled unless explicitly enabled, or it follows an explicit documented default that operators can disable. Its interval is bounded and validated as a positive duration.
- The trigger surfaces call the orchestrator-owned reconciliation path (`detectMerges` or equivalent) rather than duplicating PR state or run-transition logic in routes, services, tests, or adapters.
- After a pull request is merged on the provider, the next production-triggered reconciliation updates the run-owned `PR` record to `merged` and advances the run to `done`.
- A merged run reaches `done` within a bounded interval in the configured service scenario.
- Closed-without-merge behavior remains the existing reconciliation behavior: update the `PR` to `closed`, fail the run with a sanitized stable reason, and do not mark it `done`.
- Reconciliation reads are bounded by the existing `maxCount` and `timeoutMs` controls or equivalent service-owned configuration.
- One failed provider read or malformed PR does not crash the entire background tick. Failures are contained and reported through the reconciliation summary and sanitized logs.
- The trigger surfaces do not call `dispatch` for ordinary run progression and do not bypass the existing auto-dispatch policy.
- `replyToRun` behavior for `pr.human_review` does not change. `approve` remains invalid for that step unless a separate future spec changes PR review semantics.
- The `/v1` endpoint is authenticated, policy-protected, additive under `/v1`, described by `api-contract` Zod schemas, and exposed through the SDK using existing SDK conventions.
- Tests prove background ticker behavior through a real started service configured with the ticker enabled.
- A real end-to-end test merges a pull request and asserts the run reaches `done` through the production trigger. The test must not call `tick`, `detectMerges`, or `detectPullRequestMerges` directly to stand in for the trigger.
- The end-to-end test uses the real code-host port path with a real or realistic `gh` executable, consistent with existing PR lifecycle integration tests.
- Secrets and raw provider output do not appear in logs captured by the test harness, thrown errors, client responses, persisted failure reasons, or reconciliation summaries.
- `context-agent/wiki/code-map.md` is updated during implementation if a module is added, moved, or significantly changed.
### Product devil's advocate pass

- A background ticker can hide operational cost if it polls too often. The interval must be explicit and bounded, and reconciliation must continue to start from locally tracked open PR records rather than provider-wide scans.
- A public-looking reconcile endpoint could become an unsafe mutation surface. It must be protected like other `/v1` routes, routed through the service and orchestrator, and limited to the authenticated tenant.
- Running both a ticker and endpoint can create duplicate reconciliation attempts. The implementation must rely on idempotent PR state updates, terminal-run guards, and per-run serialization where run transitions occur.
- Tests can accidentally prove the old manual path if they call `tick` from the test body. The end-to-end proof must start the actual trigger and then wait for the run to finish.
### Product reviewer pass

The request fits the existing architecture: merge detection already exists and belongs to the orchestrator, while the missing piece is a production trigger. This spec keeps the enhancement narrow by avoiding webhooks, new PR UI, and recovery of failed terminal runs. B1 requires both a background ticker and a protected reconcile endpoint so automatic completion and explicit operator/client reconciliation are covered by one orchestrator-owned path.
### References

- [Issue 85](https://github.com/markdstafford/autocatalyst/issues/85) — source request and acceptance criteria.
- [Issue 73](https://github.com/markdstafford/autocatalyst/issues/73) — PR lifecycle feature that added PR records, `pr.open`, and merge detection.
- [context-human/specs/](https://feature-review-open-merge-pull-request.md)[feature-review-open-merge-pull-request.md](http://feature-review-open-merge-pull-request.md) — prior PR lifecycle spec.
- [context-human/specs/](https://enhancement-auto-dispatch-runs-to-spec-gate.md)[enhancement-auto-dispatch-runs-to-spec-gate.md](http://enhancement-auto-dispatch-runs-to-spec-gate.md) — existing auto-dispatch behavior and config precedent.
- [context-human/concepts/](../concepts/orchestrator.md)[orchestrator.md](http://orchestrator.md) — single run mutation authority and tick fallback.
- [context-human/concepts/](../concepts/api.md)[api.md](http://api.md) — `/v1` additive REST surface, auth, and policy boundary.
- [context-human/concepts/](../concepts/run.md)[run.md](http://run.md) — `pr.human_review`, terminal states, and transition model.
- `packages/core/src/orchestrator.ts` — `tick`, `detectMerges`, `replyToRun`, and PR system-step orchestration.
- `packages/core/src/pr-lifecycle.ts` — `detectPullRequestMerges` bounded reconciliation logic.
- `packages/core/src/routes.ts` — current protected `/v1` routes; no reconcile endpoint exists yet.
- `apps/control-plane/src/server.ts` and `apps/control-plane/src/config.ts` — control-plane startup and runtime configuration.
## Design spec

### Design scope

This enhancement is backend-only. It changes the run lifecycle behavior exposed through existing run reads, run events, and reconcile API responses. It does not add a new screen or change how humans merge pull requests on the code host.
The desired experience is simple: once a run reaches `pr.human_review`, the human reviews and merges the pull request on GitHub or another configured code host. Autocatalyst then observes the provider state and completes the run. The human does not need to reply `approve` to the run, and the operator does not need to run an internal test hook.
### Successful reconciliation flow

1. A run opens a pull request through `pr.open` and persists the run-owned `PR` record with state `open`.
2. The workflow advances to `pr.human_review`.
3. A human merges the pull request on the code host.
4. The production trigger starts a bounded reconciliation pass for the tenant.
5. The orchestrator asks `detectPullRequestMerges` to inspect locally tracked open PRs.
6. The code-host adapter reads the provider PR state.
7. When the provider reports `merged`, the PR repository updates the run-owned `PR` record to `merged`.
8. The orchestrator applies the normal `advance` directive for the run.
9. The run reaches `done`, becomes terminal, and clients can observe the transition through existing run reads and events.
The flow should be idempotent. If the ticker runs again after the run is `done`, reconciliation should skip terminal runs or find no open PR for that run.
### Required trigger surfaces

The implementation must provide both trigger surfaces for B1. They should share the same service method and preserve the same bounded reconciliation semantics.
#### Periodic background ticker

A background ticker runs inside the control-plane process and calls tenant-scoped merge reconciliation at a configured interval. This gives the best "done on its own" experience because no external client needs to remember to call a reconcile route.
The ticker should be opt-in or explicitly configurable. Operators should be able to set at least:
- enabled or disabled;
- interval in milliseconds or seconds;
- optionally the reconciliation bounds if they are not kept as code constants.
The ticker should start only after the service has finished composing dependencies and registering routes. It should stop during server close so tests and local runs do not leave timers behind. It should not overlap its own work: if one reconciliation pass is still running when the next interval fires, the next pass should be skipped or coalesced rather than stacked.
Tenant selection must be explicit. If the current service has a single development tenant only, the ticker can use the same configured or hardcoded tenant the service already uses, but the design should not bake in provider-specific or repository-specific assumptions. If there is no reliable tenant list yet, B1 should use an explicitly configured ticker tenant while the endpoint remains tenant-scoped to the authenticated principal.
#### Protected reconcile endpoint

A `/v1` endpoint lets a client or operator trigger the same bounded reconciliation on demand. The B1 path is `POST /v1/pull-requests/reconcile`, returning a summary such as:
```json
{
  "checked": 0,
  "merged": 1,
  "closed": 0,
  "failed": 0,
  "timedOut": false
}
```
`checked` intentionally preserves the existing `detectPullRequestMerges` meaning: it counts provider PR reads that complete and still report an open PR after reconciliation. Provider reads that produce merged, closed-without-merge, or failed outcomes are counted in `merged`, `closed`, or `failed` instead, not also in `checked`; terminal or missing runs skipped before the provider read are not counted.
The endpoint should use the authenticated principal's tenant. It should be policy-protected and declared in `api-contract` with Zod schemas. It should not accept arbitrary provider tokens, repository names, PR numbers, or tenant ids in the request body for B1. The endpoint is a trigger for Autocatalyst's known open PR records, not a provider query proxy. The background ticker remains responsible for the "on its own" outcome; the endpoint provides an explicit production path for operators, clients, and tests.
### State visibility

No new run state is required. Existing reads should continue to show:
- `currentStep: "pr.human_review"` while Autocatalyst waits for a provider-side merge;
- `waitingOn: "human"` because the catalog classifies `pr.human_review` that way;
- `currentStep: "done"`, `terminal: true`, and `waitingOn: "none"` after reconciliation observes a merge.
Run events should include the same transition event produced by `applyDirective` when the run advances to `done`. If existing retained SSE replay captures this event, clients can reconnect and observe completion. If reconciliation fails for a PR, logs and any endpoint summary should expose only safe counts and stable codes, not raw provider output.
### Error and retry experience

A reconciliation pass should be best-effort and bounded. One PR read failure should increment a failed count and allow the batch to continue until the count or time bound is reached. A background ticker should log a sanitized warning for failed passes and try again on the next interval.
If a PR is closed without merge, the existing reconciliation logic should fail the run with `pull_request_closed_without_merge`. The trigger should not reinterpret that outcome. If a run is already terminal by the time reconciliation tries to apply a directive, terminal guards should prevent an unsafe second transition.
If provider credentials are missing, invalid, or rate-limited, the trigger should not expose secrets or raw command output. The run can remain at `pr.human_review` until a later pass succeeds, unless existing reconciliation code classifies a particular closed state or terminal failure.
### Operator and security experience

Operators need predictable controls. A background ticker should be named clearly in environment variables and CLI flags, following existing `AUTOCATALYST_*` style. Suggested names include `AUTOCATALYST_PR_RECONCILE_TICKER` and `AUTOCATALYST_PR_RECONCILE_INTERVAL_MS`, but exact names can follow local conventions.
The trigger surfaces must not grant new provider powers. They only read open PR state through the existing code-host port and then update Autocatalyst state through the orchestrator. The endpoint must require bearer auth, policy approval, and tenant scoping through the existing principal path.
## Tech spec

### Current state

The relevant code already exists in these places:
- `packages/core/src/orchestrator.ts` exposes `detectMerges(tenant)` and `tick(input)`. `tick` currently starts `detectMerges(input.tenant)` as a swallowed background side effect on every tick, then optionally dispatches a specific run when `runId` is provided.
- `packages/core/src/pr-lifecycle.ts` exports `detectPullRequestMerges`, which lists locally tracked open PRs, reads each provider PR through the code-host port, updates PR state, and advances merged runs to `done` through the injected `applyDirective` callback.
- `packages/core/src/control-plane-service.ts` exposes `tick` on the service facade, but routes do not expose a tick or reconcile endpoint.
- `packages/core/src/routes.ts` registers protected `/v1` routes for conversations, runs, run events, specs, feedback, replies, configuration, secrets, and probe resources. There is no reconcile/tick route today.
- `apps/control-plane/src/server.ts` wires `DefaultOrchestrator`, `DefaultControlPlaneService`, code-host dependencies, and `autoDispatch` options. It does not start a merge-reconciliation interval.
- `apps/control-plane/src/config.ts` parses control-plane runtime settings such as port, database path, run concurrency, workspace roots, and real dispatch. It does not parse PR reconciliation ticker settings.
- `apps/control-plane/src/pr-lifecycle.integration.spec.ts` proves the lifecycle by flipping a realistic fake `gh` PR to merged and then calling `orchestrator.detectMerges('tenant_dev')` directly. Issue 85 requires an end-to-end proof driven by the production trigger instead.
The core merge logic is therefore in place. The missing behavior is production scheduling and an exposed production trigger.
### Architecture

Add a small reconciliation trigger layer at the service boundary. The trigger should call the existing control-plane service or orchestrator method rather than importing `detectPullRequestMerges` directly in routes or timers.
A background ticker should be implemented in the control-plane app package because it is process lifecycle infrastructure. A likely placement is:
- `apps/control-plane/src/pr-reconciliation-ticker.ts` for timer lifecycle, no-overlap behavior, safe logging, and close handling.
- `apps/control-plane/src/config.ts` for environment and CLI parsing.
- `apps/control-plane/src/server.ts` for composing and starting the ticker after the control-plane service is built.
A reconcile endpoint needs contract, service, route, and SDK additions. A likely placement is:
- `packages/api-contract/src/pr-reconciliation.ts` for path constants and response schema.
- `packages/core/src/control-plane-service.ts` for `reconcilePullRequests(input)` that calls `orchestrator.detectMerges(principal.tenantId)`.
- `packages/core/src/routes.ts` for the protected route.
- `packages/sdk/src/client.ts` for a client helper if SDK coverage is expected for new `/v1` actions.
Both trigger surfaces are in scope for B1 and should share the same service method and response summary type.
### Background ticker design

Define runtime config with explicit validation. Suggested shape:
```typescript
interface PullRequestReconciliationTickerConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
}
```
Parsing rules:
- disabled by default unless the implementation chooses and documents an enabled default;
- boolean parser follows existing `parseBooleanEnv` behavior for `1`, `true`, `yes`, `0`, `false`, and `no`;
- interval must be a positive integer;
- optional minimum interval may be enforced to prevent accidental tight loops.
Ticker behavior:
1. On server startup, if enabled, create the ticker with the composed `ControlPlaneService` or `Orchestrator` method.
2. Run reconciliation periodically with `setInterval` or an equivalent timer.
3. Optionally run once on startup if that behavior is documented and tested.
4. Skip a tick if a previous pass is still active.
5. Catch every rejection and log only sanitized details.
6. Stop and clear the timer in the Fastify `onClose` hook.
The ticker needs a tenant. Options, in preferred order:
1. Use a service method that can reconcile all tenants with open PRs if repository support exists or is added.
2. Add a narrow repository method to list tenants that have open PRs, then call tenant-scoped `detectMerges` for each tenant.
3. For B1, use an explicit configured tenant when the service only supports a single operational tenant in practice.
Option 1 or 2 is more aligned with the multi-tenant model. Option 3 is acceptable only if documented as a B1 limitation and if the end-to-end proof configures that tenant explicitly.
### Reconcile endpoint design

The endpoint should be an action resource under `/v1` with no request body for B1. Suggested contract:
```typescript
export const pullRequestReconciliationPath = '/v1/pull-requests/reconcile';
export const reconcilePullRequestsSuccessStatusCode = 200;
export const pullRequestReconciliationResponseSchema = z.object({
  checked: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  closed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  timedOut: z.boolean()
});
```
Route behavior:
1. Authenticate through the existing `/v1` bearer hook.
2. Authorize with a new policy action such as `pull_request.reconcile` and resource kind such as `pull_request_reconciliation`.
3. Derive tenant from `requirePrincipalFromRequest(request)`.
4. Call `dependencies.controlPlane.reconcilePullRequests({ principal, tenant: principal.tenantId })` or a similar service method.
5. Return the parsed summary.
6. Map service errors through existing `handleControlPlaneServiceError` without exposing raw provider details.
The endpoint should not accept a `runId` in B1. Reconciliation is already bounded by open PR records; adding run-specific input would create more policy and state edge cases without improving the core outcome.
### Service and orchestrator changes

Keep the orchestrator API as the state authority. The existing `detectMerges(tenant)` method is the right lower-level operation. Consider adding a more product-named service method:
```typescript
interface ControlPlaneService {
  reconcilePullRequests(input: {
    readonly principal: NonModelPrincipal;
    readonly tenant: string;
  }): Promise;
}
```
The service method should:
- verify tenant/principal consistency using the same patterns as other service calls;
- call `orchestrator.detectMerges(tenant)`;
- return the bounded summary;
- map `OrchestratorError` to `ControlPlaneServiceError` consistently.
Do not make routes or the ticker call `detectPullRequestMerges` directly. Do not duplicate closed/merged handling outside `pr-lifecycle.ts`.
### Persistence and tenant discovery

If the ticker needs all-tenant reconciliation, add the narrowest repository support required. A useful repository method could be:
```typescript
listTenantsWithOpenPullRequests(): Promise;
```
or a richer page of open PR owners. The method belongs near `PullRequestRepository` only if it is needed by production ticker behavior. It should read local Autocatalyst state, not provider state. It should be covered by persistence tests.
If B1 instead configures one tenant for the ticker, no persistence schema change is required. The spec allows that shortcut but treats it as a limitation to document in `context-agent/wiki/code-map.md` or operator docs.
### End-to-end test plan

Add or update a production-trigger test that uses realistic PR lifecycle wiring.
For a background ticker implementation:
- start `createControlPlaneServer` or `startControlPlaneServer` with the ticker enabled and a short safe interval;
- drive a run through `pr.finalize`, `pr.open`, and `pr.human_review` using existing realistic fake `gh` setup;
- flip the fake provider PR state to merged;
- do not call `tick`, `detectMerges`, or `detectPullRequestMerges` from the test;
- wait for the run to become terminal `done` within a bounded timeout;
- assert the persisted `PR` state is `merged`;
- assert captured logs and client-visible responses do not contain the fake token.
For an endpoint implementation:
- start the real Fastify route stack;
- drive a run to `pr.human_review` with an open PR;
- flip the fake provider state to merged;
- call the protected `/v1` reconcile endpoint through HTTP or the SDK;
- assert the response summary has `merged: 1`;
- assert the run reaches `done`;
- do not call internal orchestrator methods from the test body.
Cover both trigger surfaces with focused tests. Both endpoint-driven and ticker-driven integration tests should exercise the PR lifecycle enough to prove that the run reaches `done` without the test calling internal merge-detection methods as the trigger.
### Validation

Recommended targeted validation after implementation:
```bash
pnpm nx test core -- pr-lifecycle.spec orchestrator.spec control-plane-service.spec routes.spec
pnpm nx test control-plane -- pr-lifecycle.integration.spec integration.spec
pnpm nx test api-contract -- openapi.spec
pnpm nx test sdk
pnpm test:boundaries
```
Run `pnpm validate` when practical after the targeted suite passes.
### Risks and mitigations

- **Ticker tenant discovery is underspecified.** Prefer an all-tenant local open-PR query. If B1 uses one configured tenant, document it as a limitation and keep the endpoint available for explicit reconciliation if possible.
- **Overlapping ticks can duplicate work.** Add a simple in-flight guard at ticker scope and rely on terminal-run guards and idempotent PR state updates for correctness.
- **Provider rate limits or outages can cause noisy failures.** Keep existing count/time bounds, contain per-PR failures, and log sanitized summaries only.
- **Endpoint can become too broad.** Scope it to the authenticated tenant and known open PR records; do not let callers pass arbitrary provider coordinates.
- **Tests may accidentally use the old manual path.** The issue-85 end-to-end test must fail code review if it calls `tick`, `detectMerges`, or `detectPullRequestMerges` directly as the trigger.
- **Provider behavior varies.** The realistic fake `gh` path proves production wiring; live provider behavior remains subject to configured code-host adapter support and credentials.
## Converged API

### Files

Path
Purpose
Exports

`packages/api-contract/src/pr-reconciliation.ts`
Defines the additive protected pull-request reconciliation action contract, including the /v1 path constant, HTTP success status, response Zod schema, and response TypeScript type.
`pullRequestReconciliationPath`, `reconcilePullRequestsSuccessStatusCode`, `pullRequestReconciliationResponseSchema`, `ReconcilePullRequestsResponse`

`packages/api-contract/src/index.ts`
Re-exports the pull-request reconciliation contract from the api-contract barrel so core, SDK, tests, and OpenAPI generation can consume it through @autocatalyst/api-contract.
`pullRequestReconciliationPath`, `reconcilePullRequestsSuccessStatusCode`, `pullRequestReconciliationResponseSchema`, `ReconcilePullRequestsResponse`

`packages/api-contract/src/openapi.ts`
Registers POST /v1/pull-requests/reconcile in the generated OpenAPI document with bearer-protected success and error responses.
`generateOpenApiDocument`

`packages/core/src/policy.ts`
Extends the policy action/resource unions with a pull-request reconciliation collection action used by the protected route and service authorization.
`PolicyAction`, `PolicyResourceDescriptor`, `authorizeRequest`, `permissivePolicyDecisionPoint`

`packages/core/src/control-plane-service.ts`
Adds a product-named service method that authorizes tenant-scoped pull-request reconciliation and delegates to the orchestrator-owned merge detection path.
`ControlPlaneService`, `DefaultControlPlaneService`, `ServiceReconcilePullRequestsInput`, `ServiceReconcilePullRequestsResult`, `ControlPlaneServiceError`

`packages/core/src/routes.ts`
Adds the protected POST /v1/pull-requests/reconcile route, derives tenant from the authenticated principal, invokes ControlPlaneService.reconcilePullRequests, and returns the sanitized reconciliation summary.
`registerControlPlaneRoutes`

`packages/sdk/src/client.ts`
Exposes an SDK helper for callers/operators to invoke the protected reconciliation endpoint using the existing ControlPlaneClient conventions.
`ControlPlaneClient`, `createControlPlaneClient`

`apps/control-plane/src/config.ts`
Adds explicit runtime configuration for the opt-in pull-request reconciliation ticker, including enabled state, interval validation, and tenant selection.
`PullRequestReconciliationTickerConfig`, `ControlPlaneAppConfig`, `readControlPlaneAppConfig`

`apps/control-plane/src/pr-reconciliation-ticker.ts`
Implements the process-lifecycle ticker that periodically calls ControlPlaneService.reconcilePullRequests without overlapping passes, reports explicit run outcomes, and can be stopped during Fastify shutdown.
`PullRequestReconciliationTickerOptions`, `PullRequestReconciliationTickerRunResult`, `PullRequestReconciliationTicker`, `createPullRequestReconciliationTicker`

`apps/control-plane/src/server.ts`
Composes the optional reconciliation ticker after the control-plane service/routes are built, synthesizes the documented system principal for that background work, and stops the ticker from the Fastify onClose hook.
`ControlPlaneServerOptions`, `StartControlPlaneServerOptions`, `createControlPlaneServer`, `startControlPlaneServer`

`context-agent/decisions/pr-reconciliation-service-result-coupling.md`
Records the B1 decision that ServiceReconcilePullRequestsResult is intentionally coupled to the sanitized API wire response until the service needs internal-only reconciliation fields.

### Public API

#### `pullRequestReconciliationPath`

```typescript
export const pullRequestReconciliationPath = '/v1/pull-requests/reconcile' as const
```
- Returns: `'/v1/pull-requests/reconcile'`
#### `reconcilePullRequestsSuccessStatusCode`

```typescript
export const reconcilePullRequestsSuccessStatusCode = 200 as const
```
- Returns: `200`
#### `pullRequestReconciliationResponseSchema`

```typescript
export const pullRequestReconciliationResponseSchema: z.ZodObject
```
- Returns: `Zod schema for ReconcilePullRequestsResponse`
#### `ControlPlaneService.reconcilePullRequests`

```typescript
reconcilePullRequests(input: ServiceReconcilePullRequestsInput): Promise
```
- Parameters:
	- `input: ServiceReconcilePullRequestsInput` — Authenticated non-model principal and tenant for the tenant-scoped reconciliation pass. ServiceReconcilePullRequestsInput.principal is NonModelPrincipal so model principals are rejected at compile time for this trigger surface; the tenant must match the principal tenant and is not accepted from public request bodies. Background ticker calls use the server-synthesized system principal documented on ControlPlaneServerOptions.pullRequestReconciliationTicker.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError with code forbidden when policy denies pull_request.reconcile.`
	- `ControlPlaneServiceError with code forbidden when the requested tenant does not match the authenticated principal tenant.`
	- `ControlPlaneServiceError with code persistence_failed for any OrchestratorError from detectMerges not classified as forbidden, missing_run, or active_run_conflict, consistent with the existing mapOrchestratorErrorCode fallback.`
#### `DefaultControlPlaneService.reconcilePullRequests`

```typescript
async reconcilePullRequests(input: ServiceReconcilePullRequestsInput): Promise
```
- Parameters:
	- `input: ServiceReconcilePullRequestsInput` — Non-model principal and tenant used to authorize and execute the reconciliation pass. The tenant must match input.principal.tenantId; model principals are outside this service method contract.
- Returns: `Promise`
- Errors:
	- `ControlPlaneServiceError with code forbidden when policy denies pull_request.reconcile.`
	- `ControlPlaneServiceError with code forbidden when input.tenant differs from input.principal.tenantId.`
	- `ControlPlaneServiceError with code persistence_failed for any OrchestratorError from detectMerges not classified as forbidden, missing_run, or active_run_conflict, consistent with the existing mapOrchestratorErrorCode fallback.`
#### `registerControlPlaneRoutes POST /v1/pull-requests/reconcile`

```typescript
protectedApp.post(pullRequestReconciliationPath, options, handler): Promise
```
- Parameters:
	- `request: FastifyRequest` — Bearer-authenticated request. No request body is accepted for B1; tenant is derived from requirePrincipalFromRequest(request), which must provide a NonModelPrincipal for this operator/system trigger before calling the service.
	- `reply: FastifyReply` — Fastify reply that sends a ReconcilePullRequestsResponse on success or an existing ErrorResponse on auth/service errors.
- Returns: `Promise`
- Errors:
	- `401 ErrorResponse when bearer authentication fails.`
	- `403 ErrorResponse when policy denies pull_request.reconcile.`
	- `500 ErrorResponse with internal_error when reconciliation fails before returning a sanitized summary.`
#### `ControlPlaneClient.reconcilePullRequests`

```typescript
reconcilePullRequests(): Promise
```
- Returns: `Promise`
- Errors:
	- `ControlPlaneClientError when the HTTP response is not ok, including unauthorized or forbidden responses from the protected endpoint.`
#### `PullRequestReconciliationTicker`

```typescript
export class PullRequestReconciliationTicker { start(): void; stop(): void; runOnce(): Promise; }
```
- Returns: `PullRequestReconciliationTicker instance with start, stop, and runOnce lifecycle methods`
- Errors:
	- `Constructor or factory throws Error when intervalMs is not a positive integer.`
	- `runOnce resolves { status: 'skipped', reason: 'in_flight' } instead of starting overlapping reconciliation when a previous pass is still in flight.`
	- `runOnce catches service failures, logs sanitized details, and resolves { status: 'failed', errorCode: 'reconciliation_failed' } for scheduled/background calls rather than crashing the process.`
#### `createPullRequestReconciliationTicker`

```typescript
export function createPullRequestReconciliationTicker(options: PullRequestReconciliationTickerOptions): PullRequestReconciliationTicker
```
- Parameters:
	- `options: PullRequestReconciliationTickerOptions` — Ticker dependencies and configuration: control-plane service, non-model principal, tenant, positive interval, and sanitized logger. The principal is explicit here so unit tests and non-server embeddings can choose the identity to authorize.
- Returns: `PullRequestReconciliationTicker`
- Errors:
	- `Error when options.intervalMs is not a positive integer.`
	- `Error when options.tenant is empty or does not match options.principal.tenantId.`
#### `readControlPlaneAppConfig`

```typescript
export function readControlPlaneAppConfig(argv?: readonly string[], env?: NodeJS.ProcessEnv): ControlPlaneAppConfig
```
- Parameters:
	- `argv: readonly string[]` — Optional CLI arguments. Adds flags such as --pr-reconcile-ticker, --pr-reconcile-interval-ms, and --pr-reconcile-tenant when implemented.
	- `env: NodeJS.ProcessEnv` — Optional environment source. Adds AUTOCATALYST_PR_RECONCILE_TICKER, AUTOCATALYST_PR_RECONCILE_INTERVAL_MS, and AUTOCATALYST_PR_RECONCILE_TENANT parsing.
- Returns: `ControlPlaneAppConfig`
- Errors:
	- `Error when the ticker boolean env value is not one of 1, true, yes, 0, false, or no.`
	- `Error when ticker is enabled and interval is missing, non-integer, or not positive.`
	- `Error when ticker is enabled and tenant is missing or empty.`
#### `createControlPlaneServer`

```typescript
export async function createControlPlaneServer(options: ControlPlaneServerOptions): Promise
```
- Parameters:
	- `options: ControlPlaneServerOptions` — Existing server composition options plus optional pullRequestReconciliationTicker configuration used to start and close the background trigger. When enabled, the server synthesizes a NonModelPrincipal with kind 'system', id 'principal_system_reconciliation', and tenantId equal to the configured ticker tenant; non-permissive PolicyDecisionPoint implementations must authorize that identity for pull_request.reconcile.
- Returns: `Promise`
- Errors:
	- `Propagates existing server composition errors.`
	- `Error when supplied ticker options are enabled but invalid.`
### Types

#### `ReconcilePullRequestsResponse`

```typescript
export type ReconcilePullRequestsResponse = z.infer;
```
`checked` counts only provider PR reads that complete and still report an open PR. Merged, closed-without-merge, and failed outcomes are counted exclusively in `merged`, `closed`, or `failed`, matching the existing `detectPullRequestMerges` result semantics.
#### `pullRequestReconciliationResponseSchema`

```typescript
export const pullRequestReconciliationResponseSchema = z.object({ checked: z.number().int().nonnegative(), merged: z.number().int().nonnegative(), closed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), timedOut: z.boolean() }).strict();
```
#### `ServiceReconcilePullRequestsInput`

```typescript
export interface ServiceReconcilePullRequestsInput { readonly principal: NonModelPrincipal; readonly tenant: string; }
```
#### `ServiceReconcilePullRequestsResult`

```typescript
export type ServiceReconcilePullRequestsResult = ReconcilePullRequestsResponse;
```
#### `PolicyResourceDescriptor pull_request_reconciliation variant`

```typescript
| { readonly kind: 'pull_request_reconciliation'; readonly path: '/v1/pull-requests/reconcile' }
```
#### `PolicyAction pull_request.reconcile variant`

```typescript
| 'pull_request.reconcile'
```
#### `PullRequestReconciliationTickerConfig`

```typescript
export interface PullRequestReconciliationTickerConfig { readonly enabled: boolean; readonly intervalMs: number; readonly tenant: string; }
```
#### `PullRequestReconciliationTickerOptions`

```typescript
export interface PullRequestReconciliationTickerOptions { readonly controlPlane: ControlPlaneService; readonly principal: NonModelPrincipal; readonly tenant: string; readonly intervalMs: number; readonly logger?: { readonly warn: (message: string, details?: unknown) => void; readonly info?: (message: string, details?: unknown) => void; }; readonly setInterval?: typeof globalThis.setInterval; readonly clearInterval?: typeof globalThis.clearInterval; }
```
#### `PullRequestReconciliationTickerRunResult`

```typescript
export type PullRequestReconciliationTickerRunResult = | { readonly status: 'completed'; readonly result: ServiceReconcilePullRequestsResult } | { readonly status: 'skipped'; readonly reason: 'in_flight' } | { readonly status: 'failed'; readonly errorCode: 'reconciliation_failed' };
```
#### `ControlPlaneAppConfig pullRequestReconciliationTicker field`

```typescript
export interface ControlPlaneAppConfig { readonly pullRequestReconciliationTicker?: PullRequestReconciliationTickerConfig; }
```
#### `ControlPlaneServerOptions pullRequestReconciliationTicker field`

```typescript
export interface ControlPlaneServerOptions { readonly pullRequestReconciliationTicker?: PullRequestReconciliationTickerConfig; }
```
### Notes

This proposal intentionally keeps merge state mutation in the existing orchestrator/pr-lifecycle path. The new endpoint and ticker are trigger surfaces only: neither accepts provider coordinates nor duplicates merged/closed transition logic. The background ticker uses an explicit configured tenant for B1 because no reliable tenant-discovery repository API exists in the current codebase; this should be documented as a limitation or replaced later with local all-tenant open-PR discovery. The server-managed ticker synthesizes the documented system principal id 'principal_system_reconciliation' for policy checks, while lower-level ticker construction still accepts an explicit NonModelPrincipal. The shared ServiceReconcilePullRequestsInput also requires NonModelPrincipal so the endpoint/ticker trigger path cannot accidentally pass model principals at compile time. PullRequestReconciliationTicker.runOnce returns a discriminated result so skipped overlap and caught failure are observable without exposing raw errors. ServiceReconcilePullRequestsResult remains a transparent alias of ReconcilePullRequestsResponse for B1, with the coupling recorded in context-agent/decisions/[pr-reconciliation-service-result-coupling.md](http://pr-reconciliation-service-result-coupling.md). The SDK method error docs intentionally match existing client conventions by documenting HTTP ControlPlaneClientError behavior only; successful-response schema parse failures propagate according to the existing client implementation but are not enumerated as a method-specific contract clause.
## Task list

### Story 1 — Add the pull-request reconciliation API contract

**Description:** Define the additive `/v1/pull-requests/reconcile` contract in `packages/api-contract` so core, SDK, OpenAPI generation, and tests share one path, status code, response schema, and response type.
**Dependencies:** None.
#### Task 1.1 — Create the reconciliation contract module

**Description:** Add `packages/api-contract/src/pr-reconciliation.ts` with the path constant, success status constant, strict response Zod schema, and inferred response type from the Converged API.
**Acceptance criteria:**
- `pullRequestReconciliationPath` equals `'/v1/pull-requests/reconcile'`.
- `reconcilePullRequestsSuccessStatusCode` equals `200`.
- `pullRequestReconciliationResponseSchema` accepts only nonnegative integer `checked`, `merged`, `closed`, and `failed` counts plus boolean `timedOut`.
- `checked` is documented and tested as the count of provider PR reads that complete and still report an open PR; merged, closed, and failed outcomes are not double-counted as checked.
- `ReconcilePullRequestsResponse` is inferred from `pullRequestReconciliationResponseSchema`.
- Contract tests cover valid responses, negative counts, fractional counts, missing fields, and unknown fields.
**Dependencies:** None.
#### Task 1.2 — Re-export the contract from the package entrypoint

**Description:** Update `packages/api-contract/src/index.ts` so callers can import the new reconciliation contract through `@autocatalyst/api-contract`.
**Acceptance criteria:**
- Every public export from `pr-reconciliation.ts` is available from the package barrel.
- Existing api-contract exports remain source-compatible.
- Entry-point or type-level tests cover the new exports if this package has export coverage.
**Dependencies:** Task 1.1.
#### Task 1.3 — Add the route to generated OpenAPI output

**Description:** Update `packages/api-contract/src/openapi.ts` to document `POST /v1/pull-requests/reconcile` as a bearer-protected action with the shared success response and existing error response shape.
**Acceptance criteria:**
- The generated OpenAPI document includes `POST /v1/pull-requests/reconcile`.
- The operation has no request body for B1.
- The operation declares bearer security.
- The `200` response uses the same response shape as `pullRequestReconciliationResponseSchema`.
- Existing OpenAPI tests pass or are updated to assert the new path.
**Dependencies:** Tasks 1.1 and 1.2.
### Story 2 — Add policy and service support for tenant-scoped reconciliation

**Description:** Add the protected service method that authorizes pull-request reconciliation for a non-model principal and delegates all state changes to the existing orchestrator merge-detection path.
**Dependencies:** Story 1.
#### Task 2.1 — Extend policy action and resource types

**Description:** Add the `pull_request.reconcile` action and `pull_request_reconciliation` resource descriptor to `packages/core/src/policy.ts`.
**Acceptance criteria:**
- `PolicyAction` includes `pull_request.reconcile`.
- `PolicyResourceDescriptor` includes `{ kind: 'pull_request_reconciliation'; path: '/v1/pull-requests/reconcile' }`.
- `permissivePolicyDecisionPoint` continues to allow the new action.
- Existing policy tests pass or are updated to cover the new action/resource pair.
**Dependencies:** Story 1.
#### Task 2.2 — Add service input and result types

**Description:** Add `ServiceReconcilePullRequestsInput` and `ServiceReconcilePullRequestsResult` to `packages/core/src/control-plane-service.ts`, using `NonModelPrincipal` and the shared API response type exactly as described by the Converged API.
**Acceptance criteria:**
- `ServiceReconcilePullRequestsInput.principal` is typed as `NonModelPrincipal`.
- `ServiceReconcilePullRequestsInput.tenant` is an explicit string used for tenant consistency checks.
- `ServiceReconcilePullRequestsResult` aliases `ReconcilePullRequestsResponse`.
- Existing control-plane service public types remain source-compatible.
**Dependencies:** Tasks 1.1 and 2.1.
#### Task 2.3 — Implement `ControlPlaneService.reconcilePullRequests`

**Description:** Add `reconcilePullRequests(input)` to the service interface and `DefaultControlPlaneService`, authorize the action, reject tenant mismatches, call `orchestrator.detectMerges(input.tenant)`, and return the sanitized summary.
**Acceptance criteria:**
- The method authorizes `pull_request.reconcile` against the `pull_request_reconciliation` resource.
- The method returns `forbidden` when policy denies the action.
- The method returns `forbidden` when `input.tenant` differs from `input.principal.tenantId`.
- The method calls `orchestrator.detectMerges` and does not import or call `detectPullRequestMerges` directly.
- `OrchestratorError` mapping follows existing service error conventions, including the `persistence_failed` fallback.
- Unit tests cover success, policy denial, tenant mismatch, and orchestrator failure mapping.
**Dependencies:** Task 2.2.
#### Task 2.4 — Preserve orchestrator-owned reconciliation behavior

**Description:** Add or update focused tests around the service/orchestrator seam to prove the new service method does not dispatch ordinary run work, does not change `replyToRun` behavior for `pr.human_review`, and does not duplicate PR state handling outside `pr-lifecycle.ts`.
**Acceptance criteria:**
- Tests prove service reconciliation calls the merge-detection path only.
- Tests prove the new service method does not call ordinary run dispatch.
- Tests prove `replyToRun` still rejects `approve` for `pr.human_review` according to existing behavior.
- Tests prove closed-without-merge results remain produced by existing reconciliation logic.
**Dependencies:** Task 2.3.
### Story 3 — Expose the protected reconcile endpoint and SDK helper

**Description:** Add the authenticated `/v1` route and SDK client helper that invoke the service method without accepting provider coordinates, tenant ids, or run ids from the request body.
**Dependencies:** Stories 1 and 2.
#### Task 3.1 — Register `POST /v1/pull-requests/reconcile`

**Description:** Update `packages/core/src/routes.ts` to register the protected route using the shared path constant, authenticated principal, existing policy/service error mapping, and strict response schema.
**Acceptance criteria:**
- The route is registered under the existing protected `/v1` route stack.
- The route requires bearer authentication through existing route hooks.
- The route derives tenant from `requirePrincipalFromRequest(request)` and does not accept a tenant in the body.
- The route passes a `NonModelPrincipal` and matching tenant to `controlPlane.reconcilePullRequests`.
- The route returns status `200` with a `ReconcilePullRequestsResponse` on success.
- Service errors flow through existing `handleControlPlaneServiceError` behavior without raw provider details.
**Dependencies:** Task 2.3.
#### Task 3.2 — Cover endpoint authentication, authorization, and response behavior

**Description:** Add route tests for successful reconciliation, missing or invalid auth, policy denial, service failure, and unsupported request body assumptions.
**Acceptance criteria:**
- A successful authenticated request returns the service summary.
- Missing or invalid bearer auth returns the existing unauthorized response.
- Policy denial returns the existing forbidden response.
- Service failures return sanitized error responses.
- Tests verify no request body is required and no caller-supplied tenant, run id, repository, token, or PR number is used.
**Dependencies:** Task 3.1.
#### Task 3.3 — Add `ControlPlaneClient.reconcilePullRequests`

**Description:** Update `packages/sdk/src/client.ts` with a `reconcilePullRequests(): Promise` helper that uses the shared path and existing client error conventions.
**Acceptance criteria:**
- The client method sends `POST` to `pullRequestReconciliationPath`.
- The method does not require or send a request body.
- Successful responses are parsed as `ReconcilePullRequestsResponse`.
- Non-OK HTTP responses throw `ControlPlaneClientError` consistently with existing methods.
- SDK tests cover success and at least one non-OK response.
**Dependencies:** Task 3.1.
### Story 4 — Implement the configurable background reconciliation ticker

**Description:** Add an opt-in control-plane process ticker that periodically calls the service reconciliation method for an explicitly configured tenant, skips overlapping runs, and stops cleanly when the server closes.
**Dependencies:** Story 2.
#### Task 4.1 — Parse ticker configuration

**Description:** Update `apps/control-plane/src/config.ts` with `PullRequestReconciliationTickerConfig` and config parsing for enabled state, interval, and tenant using the documented environment variables and CLI flags.
**Acceptance criteria:**
- `ControlPlaneAppConfig` includes optional `pullRequestReconciliationTicker`.
- The ticker is disabled by default.
- `AUTOCATALYST_PR_RECONCILE_TICKER` and the matching CLI flag parse booleans consistently with existing boolean config.
- `AUTOCATALYST_PR_RECONCILE_INTERVAL_MS` and the matching CLI flag require a positive integer when the ticker is enabled.
- `AUTOCATALYST_PR_RECONCILE_TENANT` and the matching CLI flag require a non-empty tenant when the ticker is enabled.
- Config tests cover defaults, enabled config, invalid booleans, invalid intervals, and missing tenant.
**Dependencies:** Story 2.
#### Task 4.2 — Build `PullRequestReconciliationTicker`

**Description:** Create `apps/control-plane/src/pr-reconciliation-ticker.ts` with the lifecycle class, factory, no-overlap guard, sanitized logging, injectable timer functions, and `runOnce` result union from the Converged API.
**Acceptance criteria:**
- `createPullRequestReconciliationTicker` validates positive `intervalMs`.
- Factory or constructor validation rejects an empty tenant or a tenant that differs from `principal.tenantId`.
- `start()` creates one interval and is idempotent.
- `stop()` clears the interval and is idempotent.
- `runOnce()` calls `controlPlane.reconcilePullRequests` with the configured principal and tenant.
- `runOnce()` returns `{ status: 'skipped', reason: 'in_flight' }` when another pass is active.
- `runOnce()` catches service failures, logs only sanitized details, and returns `{ status: 'failed', errorCode: 'reconciliation_failed' }`.
- Unit tests cover start/stop, successful `runOnce`, overlap skipping, validation failures, and sanitized failure logging.
**Dependencies:** Task 2.3.
#### Task 4.3 — Compose the ticker in the control-plane server

**Description:** Update `apps/control-plane/src/server.ts` so `createControlPlaneServer` and `startControlPlaneServer` accept ticker config, synthesize the documented system principal, start the ticker after service composition, and stop it in the Fastify `onClose` hook.
**Acceptance criteria:**
- `ControlPlaneServerOptions` and `StartControlPlaneServerOptions` include optional `pullRequestReconciliationTicker`.
- When enabled, the server creates a system `NonModelPrincipal` with id `principal_system_reconciliation` and tenant id equal to the configured ticker tenant.
- The ticker starts after dependencies and routes are composed.
- The ticker stops during Fastify close.
- When disabled or omitted, no reconciliation interval is created.
- Server tests cover enabled composition, disabled composition, invalid ticker config propagation, and close cleanup.
**Dependencies:** Tasks 4.1 and 4.2.
#### Task 4.4 — Document the B1 tenant limitation for the ticker

**Description:** Record the implementation note that B1 ticker reconciliation uses an explicitly configured tenant because no all-tenant open-PR discovery API exists yet.
**Acceptance criteria:**
- Agent-facing documentation or code comments identify the configured-tenant limitation.
- The documentation makes clear that reconciliation still starts from locally tracked open PR records for that tenant.
- The note does not change the Converged API or broaden the public request surface.
**Dependencies:** Task 4.3.
### Story 5 — Prove merged PR reconciliation through production triggers

**Description:** Add tests that merge a realistic provider pull request and observe the run reach `done` through the new endpoint and background ticker surfaces, without the test body calling internal orchestrator merge-detection methods as the trigger.
**Dependencies:** Stories 3 and 4.
#### Task 5.1 — Add endpoint-driven PR lifecycle integration coverage

**Description:** Add or update an integration test that starts the real route stack, drives a run to `pr.human_review` with an open PR, flips the realistic fake `gh` provider state to merged, calls the protected reconcile endpoint through HTTP or SDK, and observes the run complete.
**Acceptance criteria:**
- The test starts production route/service wiring rather than calling an internal orchestrator method as the trigger.
- The test drives the run through the existing PR lifecycle to `pr.human_review`.
- The test flips the fake provider PR state to merged using the same realistic fake `gh` path as existing lifecycle tests.
- The test calls `POST /v1/pull-requests/reconcile` or `ControlPlaneClient.reconcilePullRequests`.
- The response summary includes `merged: 1` and, for a single merged PR with no other open outcomes, `checked: 0`.
- The run reaches terminal `done`.
- The persisted `PR` record state is `merged`.
- The test body does not call `tick`, `detectMerges`, or `detectPullRequestMerges` as the trigger.
**Dependencies:** Story 3.
#### Task 5.2 — Add ticker-driven PR lifecycle integration coverage

**Description:** Add or update an integration test that starts `createControlPlaneServer` or `startControlPlaneServer` with the ticker enabled for `tenant_dev`, drives the realistic PR lifecycle to `pr.human_review`, flips the fake provider PR to merged, and waits for the run to complete.
**Acceptance criteria:**
- The test configures a short safe reconciliation interval and explicit tenant.
- The server-managed ticker is the only reconciliation trigger in the test.
- The run reaches terminal `done` within a bounded timeout.
- The persisted `PR` record state is `merged`.
- The test proves no interval is left running after server close.
- The test body does not call `tick`, `detectMerges`, or `detectPullRequestMerges` as the trigger.
**Dependencies:** Story 4.
#### Task 5.3 — Cover closed-without-merge and failure containment

**Description:** Add focused tests for closed-without-merge behavior and contained provider read failures through the new trigger surface that is cheapest to run.
**Acceptance criteria:**
- A provider PR reported as closed without merge updates the PR record to `closed`.
- The associated run fails with the existing sanitized `pull_request_closed_without_merge` reason.
- A provider read failure increments the failed count or returns a sanitized failed ticker result without crashing the route or ticker process.
- Raw provider output, fake tokens, and raw command details do not appear in client responses, thrown errors, persisted failure reasons, or captured logs.
**Dependencies:** Story 3 or Story 4.
### Story 6 — Record implementation decisions and run validation

**Description:** Update agent-facing documentation for new modules and the B1 service-result coupling decision, then run targeted and broad validation where practical.
**Dependencies:** Stories 1 through 5.
#### Task 6.1 — Record the service-result coupling decision

**Description:** Add `context-agent/decisions/pr-reconciliation-service-result-coupling.md` using the repository decision format to document why `ServiceReconcilePullRequestsResult` aliases the API wire response for B1.
**Acceptance criteria:**
- The decision file includes date, accepted status, decision, rationale, constraints, and rejected alternatives.
- The decision states that the service result can diverge later if internal-only fields become necessary.
- The decision does not create or change human-owned ADRs.
**Dependencies:** Task 2.2.
#### Task 6.2 — Update the agent code map

**Description:** Update `context-agent/wiki/code-map.md` for every new or significantly changed module added by this enhancement.
**Acceptance criteria:**
- The code map mentions the new api-contract reconciliation module.
- The code map mentions the service/route reconciliation path.
- The code map mentions the control-plane ticker module and config fields.
- The code map mentions the SDK helper if added.
- Existing code-map entries remain accurate.
**Dependencies:** Stories 1 through 4.
#### Task 6.3 — Run targeted validation

**Description:** Run the recommended focused tests for contract, core service/routes, SDK, control-plane config/server/ticker, and PR lifecycle integration coverage before broader validation.
**Acceptance criteria:**
- `pnpm nx test core -- pr-lifecycle.spec orchestrator.spec control-plane-service.spec routes.spec` passes, or any skipped/unavailable target is documented with the exact reason.
- `pnpm nx test control-plane -- pr-lifecycle.integration.spec integration.spec` passes, or any skipped/unavailable target is documented with the exact reason.
- `pnpm nx test api-contract -- openapi.spec` passes, or any skipped/unavailable target is documented with the exact reason.
- `pnpm nx test sdk` passes, or any skipped/unavailable target is documented with the exact reason.
- Failures are fixed before moving to broad validation unless they are unrelated and explicitly documented.
**Dependencies:** Stories 1 through 5.
#### Task 6.4 — Run broad repository validation

**Description:** Run final project validation after targeted checks pass.
**Acceptance criteria:**
- `pnpm test:boundaries` passes, or any skipped/unavailable target is documented with the exact reason.
- `pnpm validate` passes when practical, or the exact reason it could not be run is documented.
- The final handoff summarizes tests run, results, and any remaining provider-specific risks.
**Dependencies:** Task 6.3.