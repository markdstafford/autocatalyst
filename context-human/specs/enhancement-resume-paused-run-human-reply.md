---
created: 2026-06-15
last_updated: 2026-06-15
status: implementing
issue: 63
specced_by: autocatalyst
---
# Enhancement: Resume a paused run from a human reply

## Product requirements

### What

Autocatalyst should let a human reply to a run that is paused on a human step and move that run forward through the existing workflow table. The first supported pauses are the spec review gate, the implementation review gate, and the convergence-escalation `awaiting_input` pause produced by `implementation.build`.
A reviewer can approve the spec gate, send spec feedback, approve the implementation gate, send implementation feedback, or provide guidance for a convergence escalation. Approval produces an `advance` directive. Feedback produces a tracked `Feedback` item and a `revise` directive. Escalation guidance resumes the recorded producing step by advancing out of `*.awaiting_input`. Gate-question `answer` replies that do not move the run are explicitly deferred.
### Parent feature

This enhances the human-in-the-loop run lifecycle built by prior flow work:
- `feature-spec-artifact-feedback-gate.md` made specs file-canonical, created first-class artifact feedback, and paused runs at `spec.human_review`.
- `enhancement-spec-review-api-surface.md` exposed spec reads and artifact feedback create/list over `/v1`.
- `enhancement-auto-dispatch-runs-to-spec-gate.md` made run creation and post-transition dispatch automatic until a human or terminal step.
- The convergence-loop and descending-altitude gate work made `implementation.build` run real implementer/reviewer convergence and pause at `implementation.awaiting_input` when max rounds or escalation conditions require a person.
This enhancement adds the missing reply path that lets a person resume those paused runs.
### Current behavior

Runs can reach human steps, and reads expose `waitingOn: "human"`. A feature or enhancement run can pause at `spec.human_review`; `DefaultOrchestrator.applyDirective` already has spec-gate approval behavior that co-resolves the approver's addressed artifact feedback, blocks on open or addressed artifact feedback, finalizes spec approval, then advances through the workflow. `implementation.build` can converge and move a run to `implementation.human_review`, or exhaust and move it to `implementation.awaiting_input`.
The missing behavior is the public and service-level ingress for a human reply. Existing feedback endpoints can create artifact feedback and append feedback thread replies, but they do not classify a reply into `advance` or `revise`, do not move the run, and do not support implementation-target feedback as a gate reply. `dispatch` refuses human steps, and `applyDirective` currently blocks `advance` from human steps except for the spec-gate special case, so an implementation-gate approval or an `awaiting_input` reply cannot advance through the normal API path. The first real spec approval also exposes a critical workflow seam: feature and enhancement workflows advance from `spec.human_review` to `implementation.plan` before `implementation.build`, but `implementation.plan` currently has no production producing handler, so the real path must make that step traversable instead of accidentally running an undefined prompt or skipping it.
### Proposed behavior

Add a `/v1` run reply ingress, exposed through the service facade and SDK, that accepts authenticated non-model principals and only operates when the target run's current step has `waitingOn: "human"`.
For gate steps:
- At `spec.human_review`, an approval reply classifies to `advance`; it co-resolves the approver's own addressed `artifact` feedback, refuses while any `artifact` feedback remains `open` or `addressed`, finalizes spec approval, advances via `next(workflow, step, advance)`, and lets auto-dispatch continue into implementation.
- At `spec.human_review`, a feedback reply creates `artifact` feedback from the reply, classifies to `revise`, transitions to `spec.author`, and lets auto-dispatch re-author the spec. The producing `spec.author` step must consume open artifact feedback for the run and mark each item `addressed` when incorporated or `wont_fix` with a rationale when intentionally not incorporated before returning to the review gate.
- At `implementation.human_review`, an approval reply classifies to `advance`; it co-resolves the approver's own addressed `implementation` feedback, refuses while any `implementation` feedback remains `open` or `addressed`, advances via `next(workflow, step, advance)`, and lets auto-dispatch continue toward the docs and PR phases.
- At `implementation.human_review`, a feedback reply creates `implementation` feedback from the reply, classifies to `revise`, transitions to `implementation.build`, and lets auto-dispatch rerun the implementation convergence path. The producing `implementation.build` convergence path must consume open implementation feedback for the run and mark each item `addressed` when incorporated or `wont_fix` with a rationale when intentionally not incorporated before returning to the review gate.
No new public human lifecycle route is required for this slice beyond the reply endpoint. The unblock path after a revise reply is producer disposition (`open` → `addressed` or `wont_fix`) followed by approval. Approval co-resolves the approving principal's own `addressed` feedback to `resolved`; any other remaining `open` or `addressed` target feedback still blocks approval and requires another revise/disposition cycle or an existing/future lifecycle operation outside this reply slice.
For the implementation plan seam:
- Approval from `spec.human_review` must advance to `implementation.plan`, because that is the workflow table path for feature and enhancement runs. This issue must make `implementation.plan` executable on the production path. Acceptable implementations are a minimal real plan handler that records an implementation plan artifact/checkpoint and advances to `implementation.build`, or an explicit deterministic passthrough handler that records that planning is intentionally skipped for this slice and advances to `implementation.build`. It must not dispatch an AI step with `prompt: undefined`, and the e2e must observe the run traverse `implementation.plan` before implementation convergence begins.
For convergence escalation pauses:
- At `implementation.awaiting_input`, a guidance reply resumes the producing step by applying `advance` from the pause step to `implementation.build`. The reply is recorded in the active pause step's durable `RunStep.checkpointResult`, and the transition to the destination `implementation.build` step must copy or reference that guidance in the new current build step's checkpoint context so the build dispatch can read it from the current execution context. The model-question flavor of `awaiting_input` remains out of scope.
Replies to runs that are not waiting on a human are refused with a clear client error. Replies from model principals are refused. Replies to terminal runs are refused with guidance that terminal recovery is not part of this slice.
### Why

A run that pauses for review is not useful unless a person can move it again. Autocatalyst can now create a spec, pause at the spec gate, collect feedback, auto-dispatch implementation work, converge implementation through altitude gates, and pause at the implementation gate. Without a reply ingress, the first gate is a dead end for real clients.
This enhancement completes the first interactive loop. A person can approve a generated spec, watch implementation run, ask for changes at the implementation gate, and approve the revised implementation so the workflow can continue toward the pull-request phase.
### Goals

- Expose a typed `/v1` reply endpoint for runs that are waiting on a human.
- Classify supported structured replies into `advance`, `revise`, or escalation-resume behavior without building the full free-form intent classifier.
- Use the existing workflow transition table for every run movement.
- Keep the orchestrator as the single authority for run state changes.
- Preserve auto-dispatch as the mechanism that continues work after a reply moves the run to an AI or system step.
- Apply the same feedback completion gate to spec and implementation approvals, with target-specific feedback checks.
- Create gate feedback and route the run back to the producing step in one reply action.
- Support convergence-escalation resume through the same reply endpoint and run transition machinery.
- Prove the full interactive path end to end using production reply ingress, production classification, production re-dispatch, real implementation convergence, and no test-only pump.
- Update `context-agent/wiki/code-map.md` during implementation for the reply ingress and gate wiring.
### Non-goals

- Full natural-language intent classification for arbitrary chat messages.
- The model-question flavor of `awaiting_input`.
- Gate-question `answer` replies that record an answer without moving the run. This slice supports gate `approve` and `feedback`, plus convergence-escalation `guidance`, and should return a clear unsupported/invalid reply error for `answer` if a client attempts it.
- Explicit recovery for failed or canceled runs.
- The `set-step` operator override.
- PR opening, PR merging, or pull-request phase completion beyond advancing out of the implementation gate toward that phase.
- New desktop, mobile, or web screens.
- Feedback lifecycle PATCH routes for all statuses. This enhancement may add only the lifecycle operations required by reply approval/revise behavior.
- Changing existing workflow step IDs or replacing the workflow-as-data transition table.
### Personas

- **Phoebe (Product owner / reviewer)** needs to approve or revise paused work from a client without calling internal orchestrator methods.
- **Enzo (Engineer / client developer)** needs a typed API and SDK method that turns a human review action into the correct workflow transition.
- **Opal (Operator / security owner)** needs replies to be tenant-scoped, principal-attributed, safe on terminal runs, and free of secret or workspace-path leakage.
- **A future adapter author** needs chat, desktop, and mobile surfaces to call one service operation rather than each inventing pause-and-resume behavior.
### User stories

- As Phoebe, I can approve a run at `spec.human_review`, so that implementation starts without a manual tick or internal tool call.
- As Phoebe, I can reply with spec feedback at `spec.human_review`, so that the feedback is tracked and the run revises the spec.
- As Phoebe, I can approve a run at `implementation.human_review`, so that the workflow continues toward docs and PR preparation.
- As Phoebe, I can reply with implementation feedback at `implementation.human_review`, so that the feedback is tracked and implementation reruns.
- As Phoebe, I can provide guidance for a convergence escalation, so that the run re-dispatches the producing implementation step with human guidance.
- As Enzo, I can call one typed SDK method for run replies and receive the updated run state.
- As Opal, I can rely on clear refusals when a reply targets a non-human, cross-tenant, model-authored, terminal, or unsupported pause.
### Acceptance criteria

#### Reply ingress

- `POST /v1/runs/:id/replies` or an equivalent route-level reply ingress exists under `/v1`.
- The route is authenticated and policy-checked.
- The service rejects model principals; only non-model principals can reply.
- The service verifies the run belongs to the caller's tenant.
- A reply to a run whose current step does not have `waitingOn: "human"` is refused with a clear error.
- A reply to a terminal run is refused with a clear error and does not recover the run.
- The route returns the updated run state and the applied directive/classification summary.
- The SDK exposes a typed method for the reply endpoint.
#### Reply classification

- An approval reply at a supported gate classifies to `advance`.
- A feedback reply at a supported gate creates a `Feedback` item for that gate target and classifies to `revise`.
- The target is derived from the current step, not trusted from the request: `spec.human_review` uses `artifact`, and `implementation.human_review` uses `implementation`.
- Classification for this slice is deterministic from the structured reply shape. The full intent classifier is not required.
- Unsupported reply kinds at a supported pause return a clear validation or invalid-transition error.
#### Spec gate

- At `spec.human_review`, an `advance` reply co-resolves the approver's own addressed artifact feedback.
- At `spec.human_review`, an `advance` reply is refused while any artifact-target feedback remains `open` or `addressed` after co-resolution.
- At `spec.human_review`, a successful `advance` reply finalizes spec approval, transitions via the workflow table, and auto-dispatches into implementation.
- At `spec.human_review`, a feedback reply creates artifact feedback, transitions via `revise` to `spec.author`, and auto-dispatches spec revision.
- The revised `spec.author` production path consumes open artifact feedback and marks each consumed item `addressed` or `wont_fix` before returning to `spec.human_review`, so a subsequent approval can reach an unblocked state.
#### Implementation plan traversal

- A successful spec approval transitions to `implementation.plan`, not directly to `implementation.build`.
- `implementation.plan` has a production dispatch handler before the e2e relies on it.
- The handler either records a minimal real implementation plan and advances to `implementation.build`, or records an explicit deterministic passthrough checkpoint and advances to `implementation.build`.
- The handler never invokes an AI provider with `prompt: undefined`.
- The production-path e2e observes `implementation.plan` complete before real implementation convergence starts.
#### Implementation gate

- At `implementation.human_review`, an `advance` reply co-resolves the approver's own addressed implementation feedback.
- At `implementation.human_review`, an `advance` reply is refused while any implementation-target feedback remains `open` or `addressed` after co-resolution.
- At `implementation.human_review`, a successful `advance` reply transitions via the workflow table toward the docs and pull-request phases.
- At `implementation.human_review`, a feedback reply creates implementation feedback, transitions via `revise` to `implementation.build`, and auto-dispatches implementation revision.
- The revised `implementation.build` production path consumes open implementation feedback and marks each consumed item `addressed` or `wont_fix` before returning to `implementation.human_review`, so a subsequent approval can reach an unblocked state.
#### Convergence escalation

- A convergence max-round or escalation pause at `implementation.awaiting_input` can be resumed through the same reply endpoint.
- The reply records human guidance in the current `implementation.awaiting_input` `RunStep.checkpointResult`.
- The transition to `implementation.build` creates or updates the destination build run-step checkpoint with either a copy of the guidance or a `resumedFromAwaitingInputStepId` reference to the guidance-bearing pause step.
- The reply advances from `implementation.awaiting_input` to `implementation.build` through the workflow table and auto-dispatches the producing step with that guidance available from the current build execution context.
- The model-question pause flavor of `awaiting_input` remains unsupported and returns the stable `unsupported_pause` error if encountered.
#### Tests and documentation

- A focused test proves approval versus feedback replies classify to `advance` and `revise`.
- A focused test proves approval is blocked while target feedback is `open` or `addressed`, and succeeds after all target feedback is `resolved` or `wont_fix`, with approver-owned addressed feedback co-resolved in the same action.
- A focused test proves revise-created artifact and implementation feedback is consumed by the producing step and moved from `open` to either `addressed` or `wont_fix` before the next approval attempt.
- A focused test proves an implementation-gate reply uses the `implementation` target rather than the artifact target.
- A focused test proves a convergence escalation reply advances from `implementation.awaiting_input` to `implementation.build` and re-dispatches that producing step with the persisted guidance visible from the current build context.
- A focused serialization test proves simultaneous replies to the same paused run are applied through the orchestrator's run-level serialization primitive so only one reply applies; later contenders observe the updated run state and do not duplicate feedback, checkpoint guidance, or transitions.
- A focused test proves `implementation.plan` is traversable on the production path and advances to `implementation.build` through either a minimal real plan handler or a documented deterministic passthrough, never through an undefined prompt.
- A real end-to-end test drives: create run → auto-author spec → pause at spec gate → approve through the reply endpoint → traverse `implementation.plan` on the production path → real implementation convergence and altitude gates run → pause at implementation gate → send implementation feedback through the reply endpoint → implementation reruns → approve through the reply endpoint → run advances out of the implementation gate toward the pull-request phase.
- The end-to-end proof uses production reply ingress, classification, transition, and auto-dispatch paths. It does not call a test-only pump and does not mock human replies.
- `context-agent/wiki/code-map.md` is updated during implementation for the reply contracts, service methods, orchestrator reply handling, implementation-gate checks, escalation resume behavior, tests, and SDK method.
### Non-functional requirements

- **Security:** Replies are tenant-scoped and principal-attributed. Responses and logs must not expose secrets, provider raw errors, or absolute workspace paths.
- **Compatibility:** The `/v1` API evolves additively. Existing run, feedback, spec, and event endpoints keep their behavior.
- **Reliability:** A reply either records its feedback/checkpoint side effects and transition together at the service/orchestrator boundary or fails without moving the run. Reply classification, side effects, and transition must be serialized by a run-level authority shared with runner work. The current global bounded dispatch queue is not sufficient by itself when `maxConcurrent > 1`; implement or reuse a per-run queue, per-run mutex, or expected-current-step transaction/lock before applying replies. If the current persistence layer cannot atomically commit all side effects with the transition, the implementation must define safe retry behavior that prevents duplicate feedback, duplicate guidance, and duplicate transitions.
- **Consistency:** The workflow table remains the only source for next steps. Gate target mapping remains a small deterministic table tied to step ids.
- **Observability:** Successful replies publish the normal `run_state_transition` event. Feedback creation continues to be visible through feedback list endpoints and future event surfaces.
- **Least privilege:** Route handlers do not mutate repositories directly; they call the control-plane service or orchestrator methods.
### Impact on existing behavior

- Human-gate advancement becomes reachable through `/v1` instead of internal tests or direct orchestrator calls.
- `applyDirective` or its replacement must distinguish human-origin directives from runner-origin directives so runner dispatch still cannot leapfrog human gates.
- Feedback helper functions need to support `implementation` target checks in addition to existing artifact checks.
- Existing spec-gate behavior remains the same for successful approval, but it moves behind the new human reply path for public use.
### Devil's advocate pass

- **A generic ****`applyDirective`**** endpoint would be unsafe.** The route must accept review replies, not arbitrary directives. Classification should be constrained by the current step and request shape.
- **Relaxing the human-step guard can reopen a runner race.** The implementation should not simply allow `advance` from all human steps. It should thread an explicit origin or add a dedicated reply method so only human-origin actions can move human steps.
- **Creating feedback then failing to revise can leave surprising state.** The implementation should either make feedback creation plus transition atomic or return a clear retry-safe result that tells the client the feedback was recorded but the run did not move.
- **Implementation-gate checks can accidentally reuse artifact rules.** Gate target mapping should be explicit and tested for `implementation.human_review`.
- **Escalation replies need context.** If the producing step cannot see the human guidance after resume, the run may rerun without the decision it asked for. The reply body must be persisted on the `implementation.awaiting_input` checkpoint and copied or referenced by the destination `implementation.build` checkpoint before dispatch, because build dispatch reads the current build step rather than the prior pause step.
### Reviewer pass

This enhancement matches the existing concept docs. `hitl.md` defines one pause-and-resume mechanism; `feedback.md` defines target-specific gate blocking; `run.md` and `workflow.md` define `next(workflow, step, directive)`; and `intents.md` frames approval as `advance` and feedback as `revise`. The main technical risk is preserving the runner/human boundary while making human-origin transitions possible. A dedicated orchestrator reply method or explicit transition origin is the safest way to avoid weakening the existing dispatch guard.
## Design spec

### Design scope

This is a backend workflow and API design. It adds no visual screens or design-system components. It defines the client-visible reply flows, API responses, and gate state changes a future desktop, mobile, or chat adapter can use.
### Design goals

- Give users one clear action surface for paused runs.
- Make approval and feedback outcomes predictable from the current gate.
- Keep replies tied to existing run, feedback, and event resources.
- Avoid exposing raw workflow directives as a public command language.
### Reply shapes

The public request should be structured enough to avoid full intent classification in this slice. Suggested shape:
```json
{
  "kind": "approve",
  "body": "Looks good to build."
}
```
```json
{
  "kind": "feedback",
  "title": "Add failure-mode handling",
  "body": "Please explain what happens if the provider fails after a terminal event.",
  "anchor": { "kind": "artifact_range", "from": 120, "to": 180 }
}
```
```json
{
  "kind": "guidance",
  "body": "Prefer the public API option. Do not expand scope into authentication changes."
}
```
`approve` and `feedback` are valid at supported gates. `guidance` is valid only at supported convergence-escalation pauses. Gate-question `answer` replies are not part of this issue even though the broader HITL model allows them; they should be rejected with a clear unsupported/invalid reply response until a later slice implements non-moving answers. The route may use different final names, but the contract should keep the same semantic split: approval, feedback, and escalation guidance.
### User flow: Approve the spec gate

1. The client reads the run and sees `currentStep: "spec.human_review"` with `waitingOn: "human"`.
2. The client reads the spec and feedback list if needed.
3. The reviewer submits an approval reply.
4. The service verifies the run is still at `spec.human_review`.
5. The reply classifies to `advance`.
6. The orchestrator co-resolves the approver's addressed artifact feedback, checks for remaining artifact blockers, finalizes spec approval, and advances to `implementation.plan`.
7. Auto-dispatch runs the production `implementation.plan` handler. The handler either produces a minimal durable implementation plan and advances to `implementation.build`, or records a deterministic passthrough decision and advances to `implementation.build`; it must not dispatch an empty/undefined AI prompt.
8. Auto-dispatch continues through implementation build/convergence until the next human or terminal step.
9. The response returns the updated run and classification summary.
### User flow: Request spec revision

1. The client reads the run at `spec.human_review`.
2. The reviewer submits a feedback reply.
3. The service derives target `artifact` from the current step and creates an `open` feedback item.
4. The reply classifies to `revise`.
5. The orchestrator advances through the workflow table from `spec.human_review` to `spec.author`.
6. Auto-dispatch reruns `spec.author` to revise the spec.
7. The response returns the updated run, classification summary, and created feedback id.
### User flow: Approve the implementation gate

1. The client reads the run and sees `currentStep: "implementation.human_review"` with `waitingOn: "human"`.
2. The client shows the implementation review payload and implementation feedback list.
3. The reviewer submits an approval reply.
4. The service verifies the run is still at `implementation.human_review`.
5. The reply classifies to `advance`.
6. The orchestrator co-resolves the approver's addressed implementation feedback and refuses if implementation blockers remain.
7. The run advances via the workflow table toward `docs.update` and the later pull-request phase.
8. Auto-dispatch continues until the next human or terminal step.
### User flow: Request implementation revision

1. The client reads the run at `implementation.human_review`.
2. The reviewer submits a feedback reply.
3. The service derives target `implementation` and creates an `open` feedback item.
4. The reply classifies to `revise`.
5. The run transitions to `implementation.build`.
6. Auto-dispatch reruns the implementation convergence loop, including altitude gates, over the existing branch state and feedback context.
### User flow: Answer convergence escalation

1. The implementation convergence loop reaches its escalation condition and transitions to `implementation.awaiting_input`.
2. The client reads the run and escalation payload.
3. The reviewer submits a guidance reply.
4. The service verifies the pause is a convergence escalation; unsupported model-question or unknown pause flavors return `409 unsupported_pause`.
5. The reply body is persisted in the active `implementation.awaiting_input` `RunStep.checkpointResult`.
6. The transition from `implementation.awaiting_input` to `implementation.build` stores `resumedFromAwaitingInputStepId` and/or a copy of `humanGuidance` on the destination `implementation.build` run-step checkpoint before dispatch.
7. Auto-dispatch reruns the producing step, and the implementation-build context loader reads guidance from the current build step checkpoint or follows the recorded pause-step reference to load the guidance.
### Response states and errors

- `200` or `202` returns when a reply is accepted and the run transition is committed. The response includes the updated run, the current step's `waitingOn`, the classified directive, and any created feedback id.
- `400` returns for malformed request bodies or reply kinds that are not valid for an otherwise supported current pause (`invalid_transition`).
- `403` returns for unauthorized principals or model principals where the existing route style uses forbidden.
- `404` returns for missing or cross-tenant runs.
- `409` returns when the run is not currently waiting on a human, when feedback blocks approval, when the current human pause flavor is unsupported (`unsupported_pause`, including model-question `implementation.awaiting_input`), or when the run step changed before the reply was applied.
- `500` returns only through the standard safe error envelope for unexpected persistence or orchestration failures.
### Client interaction notes

Clients should treat the reply response as the committed state immediately after the human action, not as the final state after auto-dispatch. Auto-dispatch is fire-and-return. Clients should use `GET /v1/runs/:id/events`, `GET /v1/runs/:id`, and feedback list endpoints to observe follow-on execution and later gates.
A client should not send `target` for a gate reply. The target is a server decision based on the current step. This keeps one button or form from accidentally creating implementation feedback while the spec is under review, or vice versa.
### Design system updates

None.
### Accessibility and responsive behavior

No UI is introduced. Future clients should label the action clearly as approve, request changes, or provide escalation guidance; announce the updated run state after the reply; and keep feedback forms keyboard accessible. They should not expose a gate-question answer action until the later non-moving answer slice exists.
### Reviewer pass

The design keeps the public surface small and review-oriented. It gives clients enough structure to avoid ambiguous classifier behavior while still matching the intent model. The main user-experience caveat is that a successful reply does not mean the run has completed all subsequent work; clients must continue watching run reads and events.
## Tech spec

### Overview

Add a typed run-reply contract, service method, route, SDK method, and orchestrator-owned reply application path. The reply path classifies supported structured replies against the run's current step, applies target-specific feedback behavior, calls the existing workflow transition machinery, and relies on existing auto-dispatch to continue execution after the transition.
The implementation should reuse the current run-step catalog, workflow tables, feedback lifecycle, spec approval finalizer, run event publisher, and auto-dispatch scheduling infrastructure. It should generalize the spec-only gate guard into reusable human-review gate behavior instead of duplicating spec and implementation logic.
### Current state

Relevant existing modules:
- `packages/api-contract/src/feedback.ts` defines feedback entities and current spec-review feedback routes. `createRunFeedbackRequestSchema` currently accepts only `target: "artifact"`.
- `packages/core/src/control-plane-service.ts` exposes `createRunFeedback`, `listRunFeedback`, and `appendRunFeedbackThreadReply`, but no reply method that moves a run.
- `packages/core/src/routes.ts` registers spec, feedback, run, steps, and event routes, but no run reply route.
- `packages/core/src/orchestrator.ts` owns `applyDirective`, `dispatch`, auto-dispatch scheduling, spec-gate guard behavior, and spec approval finalization.
- `packages/core/src/feedback-lifecycle.ts` owns feedback creation, status movement, blocking-feedback listing, approver co-resolution, and thread append behavior, but its blocking/co-resolution inputs are currently artifact-specific.
- `packages/core/src/spec-review-gate.ts` checks only `spec.human_review` and `artifact` feedback.
- `packages/core/src/run-workflows.ts` already carries the needed transition edges: `spec.human_review -> implementation.plan` on `advance`, `spec.human_review -> spec.author` on `revise`, `implementation.plan -> implementation.build` on `advance`, `implementation.human_review -> implementation.build` on `revise`, and `implementation.awaiting_input -> implementation.build` on `advance`.
- `packages/core/src/run-transition.ts` already supports the directive vocabulary consumed by workflows.
- `packages/sdk/src/client.ts` exposes spec and feedback methods, but no run reply method.
### API contract

Add a new contract module or extend `packages/api-contract/src/run.ts` with route-level reply schemas. Suggested dedicated module: `packages/api-contract/src/run-replies.ts`.
Suggested path and status constants:
```typescript
export const runRepliesPath = '/v1/runs/:id/replies' as const;
export const createRunReplySuccessStatusCode = 200 as const;
```
Suggested request schema:
```typescript
export const runReplyRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('approve'),
    body: z.string().min(1).optional()
  }).strict(),
  z.object({
    kind: z.literal('feedback'),
    title: z.string().min(1),
    body: z.string().min(1),
    anchor: feedbackAnchorSchema.optional()
  }).strict(),
  z.object({
    kind: z.literal('guidance'),
    body: z.string().min(1)
  }).strict()
]);
```
Suggested response schema:
```typescript
export const runReplyClassificationSchema = z.object({
  directive: z.enum(['advance', 'revise']),
  target: feedbackTargetSchema.optional(),
  createdFeedbackId: z.string().min(1).optional()
}).strict();

export const runReplyResponseSchema = z.object({
  run: runSchema,
  classification: runReplyClassificationSchema
}).strict();
```
If escalation guidance needs a distinct response value, keep it close to the directive that the transition table receives. For example, `directive: "advance"` with `pauseKind: "convergence_escalation"` is preferable to adding a public directive that the workflow table does not understand.
Update `packages/api-contract/src/index.ts` and `packages/api-contract/src/openapi.ts` so SDK and OpenAPI consumers receive the new route.
### Policy and route layer

Update `packages/core/src/policy.ts`:
- Add resource descriptor `{ kind: 'run_replies'; id: string; path: '/v1/runs/:id/replies' }`.
- Add action `run_replies.create`.
Update `packages/core/src/routes.ts`:
- Register `POST /v1/runs/:id/replies` under the authenticated protected app.
- Parse params with a small `{ id: z.string().min(1) }` schema or reuse existing run param parsing.
- Parse body with `runReplyRequestSchema`.
- Require the principal from request context.
- Call `controlPlane.replyToRun({ tenant, principal, runId, request })`.
- Map service errors to existing safe envelopes. Malformed bodies and unsupported reply kinds at supported pauses map to `400 invalid_transition`; unsupported human pause flavors map to `409 unsupported_pause`; gate-blocked approval, terminal runs, non-human steps, and replies that lose the serialization race and find the run no longer at the original pause map to `409 Conflict`. Add safe typed service error codes as needed so routes, SDK, OpenAPI, and tests use the same mapping.
Routes must not call `orchestrator.applyDirective` or feedback lifecycle functions directly.
### Service facade

Add `replyToRun(input)` to `ControlPlaneService` and `DefaultControlPlaneService`.
Suggested input:
```typescript
export interface ReplyToRunInput {
  readonly tenant: string;
  readonly principal: Principal;
  readonly runId: string;
  readonly request: RunReplyRequest;
}
```
The service should:
1. Authorize `run_replies.create`.
2. Require a non-model principal.
3. Load the run and verify tenant ownership. Cross-tenant access returns `not_found`.
4. Verify `getRunStepDefinition(run.currentStep)?.waitingOn === 'human'`.
5. Delegate to an orchestrator reply method, passing the non-model principal and request.
6. Map orchestrator errors to service errors without leaking internal messages.
7. Return the updated run mapped through `mapRunToApiRun` plus classification metadata.
The service may let the orchestrator reload the run for concurrency safety. The service's pre-check is for clearer errors and policy scoping; the orchestrator remains authoritative.
### Orchestrator reply application

Add a dedicated method to the orchestrator, for example:
```typescript
interface ReplyToRunInput {
  readonly runId: string;
  readonly tenant: string;
  readonly principal: NonModelPrincipal;
  readonly request: RunReplyRequest;
}

interface ReplyToRunResult extends OrchestratedRunResult {
  readonly classification: {
    readonly directive: 'advance' | 'revise';
    readonly target?: FeedbackTarget;
    readonly createdFeedbackId?: string;
  };
}
```
This method should reload the run, verify tenant and non-terminal state, verify the current step is a supported human pause, classify the request against the current step, apply any feedback/checkpoint side effect, and transition the run using the normal lifecycle transition path.
The method must make reply application concurrency-safe by reusing the orchestrator as the single state-change authority and adding a run-level serialization primitive where one does not already exist. The repository's global bounded dispatch queue alone must not be treated as per-run serialization, because two workers can otherwise operate on the same run when concurrency is greater than one. Preferred implementation: enqueue runner dispatch and the whole reply application through a per-run queue or per-run mutex, so runner work and human replies for the same run cannot interleave. Within that serialized operation, classification, feedback/checkpoint side effects, and transition should run in one persistence transaction or expected-current-step lock when available. This issue should not introduce a broad public ETag/If-Match contract. If a second reply runs after the first has moved the run, it should receive the normal `409` non-human/changed-step conflict and must not commit duplicate feedback, checkpoint guidance, or transitions.
Do not expose a generic public directive endpoint. Do not let route handlers pass arbitrary `RunDirective` values.
#### Implementation plan production path

Spec approval must not skip `implementation.plan`. Add a production handler for `implementation.plan` before relying on the interactive e2e:
- Preferred behavior is a minimal real plan step that builds a deterministic planning prompt/task input from the approved spec, records a durable plan summary or checkpoint, and applies `advance` to `implementation.build` through the workflow table.
- If a real plan prompt is too large for this issue, an explicit deterministic passthrough is acceptable only if it records a checkpoint such as `{ kind: 'implementation_plan_passthrough', reason: 'not implemented in issue 63' }`, emits the normal step/transition events, and applies `advance` to `implementation.build`.
- Dispatch must never run `implementation.plan` as an AI step with `prompt: undefined`. The handler should be registered in the same real dispatch path used by `spec.author` and `implementation.build`, not in a test-only pump.
- `implementation.build` should receive any plan summary/checkpoint through normal run context when available. The initial slice may tolerate an empty passthrough plan, but it must be explicit and observable.
#### Human versus runner origin

The current `applyDirective` guard blocks `advance` from human-waiting steps except `spec.human_review`. Preserve that protection for runner-origin directives.
Preferred implementation:
- Add an internal `origin?: 'runner' | 'human' | 'system'` or `source?: 'dispatch' | 'reply'` field to `ApplyOrchestratedDirectiveInput`.
- Default origin to `runner` for existing `dispatch` calls.
- Let the new reply method call `applyDirective` with `origin: 'human'`.
- Keep the human-step guard active for runner origin.
- For human origin, allow only steps and directives that the reply classifier produced.
An alternate implementation is a private transition helper shared by `applyDirective` and `replyToRun`. The same invariant must hold: runner dispatch cannot advance human gates, but a validated human reply can.
### Gate target mapping

Create a small explicit mapping in core:
```typescript
type HumanReviewGateStep = 'spec.human_review' | 'implementation.human_review';

const gateFeedbackTargetByStep = {
  'spec.human_review': 'artifact',
  'implementation.human_review': 'implementation'
} as const;
```
Use this mapping for both feedback creation and approval blocking. Do not trust a target field from the request.
### Feedback lifecycle generalization

Generalize feedback lifecycle helpers so they accept `FeedbackTarget` or a narrower gate target union instead of only `artifact`:
- `listBlockingFeedback({ runId, target })` should accept `artifact | implementation | docs | pr` or at least `artifact | implementation`.
- `resolveApproverAddressedFeedback({ runId, target, approver })` should accept the same target union.
- Add a `createGateFeedback` or generalized `createFeedback` use case that creates an `open` feedback item for the target derived by the gate. Keep `createArtifactFeedback` as a wrapper if existing callers use it.
- Add internal producer disposition helpers, or reuse existing lifecycle operations, so `spec.author` and `implementation.build` can mark target feedback `addressed` when the requested change was incorporated or `wont_fix` with a durable rationale when it was intentionally not incorporated.
Feedback creation must keep the first thread entry authored by the replying principal and must use the run owner/tenant from the run.
### Gate approval checks

Replace or supplement `spec-review-gate.ts` with a generic gate check, for example `human-review-gate.ts`:
```typescript
export async function assertHumanReviewGateCanAdvance(
  input: { run: Run; target: FeedbackTarget },
  deps: { listBlockingFeedback(input: { runId: string; target: FeedbackTarget }): Promise }
): Promise;
```
Rules:
- `spec.human_review` must use target `artifact`.
- `implementation.human_review` must use target `implementation`.
- The check fails when any matching feedback is `open` or `addressed`.
- The check ignores other targets.
Keep spec approval finalization only for the spec gate and only on successful approval. The implementation gate does not update spec approval frontmatter.
### Producer disposition after revise

Reply-created feedback starts as `open` and would block the next approval if left untouched. The producing step reached by `revise` is responsible for dispositioning that feedback before it sends the run back to human review:
1. `spec.author` loads open `artifact` feedback for the run, uses it as revision input, and marks each applicable item `addressed` after updating the spec or `wont_fix` with a rationale if it intentionally declines the request.
2. `implementation.build` loads open `implementation` feedback for the run, passes it into the implementer/reviewer convergence context, and marks each applicable item `addressed` after implementing it or `wont_fix` with a rationale if it intentionally declines the request.
3. A producing step that cannot safely determine a disposition should leave the item `open` and may still return to the gate, but the next approval must remain blocked until a later revise cycle or lifecycle operation moves the item to `addressed`, `resolved`, or `wont_fix`.
4. The e2e path that submits implementation feedback must use this producer disposition path: implementation feedback is created `open`, the rerun moves it to `addressed` or `wont_fix`, and the subsequent approval either co-resolves the approving principal's own `addressed` feedback or observes no remaining `open`/`addressed` blockers.
This slice does not require new public PATCH routes for humans to manually set every feedback status. If existing lifecycle routes already support safe manual resolution or wont-fix, they may remain available; otherwise, manual lifecycle expansion is deferred.
### Feedback reply transition order

For a gate feedback reply:
1. Load and verify the current gate.
2. Derive target.
3. Create the feedback item.
4. Apply `revise` from the gate.
5. Publish the normal run transition event through `applyDirective`.
6. Auto-dispatch proceeds from the revised step.
Feedback creation and run transition must share the reply serialization boundary. Prefer a single per-run serialized operation plus transaction/lock that commits feedback plus transition together. If the current repository abstractions cannot support a shared transaction, implement a retry-safe two-phase approach inside the same per-run serialization primitive: verify the run is still at the expected human pause immediately before creating feedback and immediately before transition commit, and guarantee a losing reply cannot leave duplicate gate feedback or move the run. Any non-atomic fallback must return a safe error that states whether feedback was recorded when an unrelated persistence failure occurs, and tests must cover retry behavior.
### Approval transition order

For a gate approval reply:
1. Load and verify the current gate.
2. Derive target.
3. Co-resolve the approver's own addressed feedback for that target.
4. Check for remaining blockers on that target.
5. Run gate-specific finalizers, currently spec approval finalization only.
6. Apply `advance` through `applyRunDirective`.
7. Publish the transition event.
8. Auto-dispatch proceeds from the destination step if it waits on `system` or `ai`.
The co-resolution-before-check order preserves current spec-gate semantics.
### Convergence escalation resume

A run at `implementation.awaiting_input` needs enough context to distinguish convergence escalation from unsupported model questions. Current durable checkpoint data is stored on `RunStep.checkpointResult`, so convergence helpers must load and update the relevant current run step rather than treating `Run` as the checkpoint container. Existing convergence checkpoints include fields such as round records and `openFeedbackIds`. Extend the active awaiting-input step checkpoint schema only if needed to include a pause flavor, for example:
```typescript
pause: {
  kind: 'convergence_escalation',
  producingStep: 'implementation.build',
  humanGuidance?: string
}
```
The reply method should:
- Verify the current step is `implementation.awaiting_input`.
- Load the current open/latest `RunStep` for the run and verify its `stepId` matches `implementation.awaiting_input`. Prefer an explicit repository query such as `getCurrentRunStepForUpdate(run.id)` inside the reply transaction/lock; otherwise query the latest non-terminal step for the run and reject it if it no longer matches the run's current step.
- Verify that step's `checkpointResult.pause.kind` is `convergence_escalation` and not `model_question` or an unknown flavor.
- Persist the guidance body back to that same `RunStep.checkpointResult` or equivalent current run-step record before applying `advance`.
- Apply `advance`, which the workflow table maps back to `implementation.build`.
- Let auto-dispatch rerun `implementation.build`.
`implementation.build` context construction or convergence engine input must read the persisted guidance so the implementer/reviewer loop can act on it. Concretely, when dispatching the current `implementation.build` step, the orchestrator/convergence boundary must inspect that current build `RunStep.checkpointResult` for `humanGuidance`; if it instead contains `resumedFromAwaitingInputStepId`, it must load that referenced `implementation.awaiting_input` run step and read `checkpointResult.pause.humanGuidance`. Provider adapters must receive the guidance as normal task input and must not read database state directly.
### Data model and persistence

No new top-level domain table is required for this slice if reply metadata can be represented by existing `Message`, `Feedback`, `RunStep.checkpointResult`, and run transition records.
Possible persistence choices:
- Store approval and guidance reply text as a thread entry when tied to feedback, and as checkpoint guidance for escalation.
- Store a human reply as an inbound `Message` if the message spine is ready for run-addressed replies. If used, the message should carry the authenticated principal, run/conversation context, and classification. This is the best long-term fit with `intents.md`, but it may be larger than issue 63 needs.
- Do not store a separate reply row unless existing entities cannot represent the required audit trail.
Feedback rows remain the durable record for actionable comments. Run step rows and run transition events remain the durable and live records for movement.
### SDK

Update `packages/sdk/src/client.ts`:
- Add `replyToRun(id, request): Promise` to `ControlPlaneClient`.
- Parse request with `runReplyRequestSchema` before sending.
- Send `POST /v1/runs/:id/replies` with the same bearer-token behavior as existing methods.
- Validate response with `runReplyResponseSchema`.
- Add client tests for approval, feedback, guidance, validation failure, and non-2xx error handling.
### OpenAPI

Update `packages/api-contract/src/openapi.ts` to document the reply endpoint, request union, response shape, and common error responses. Include `400 invalid_transition` for malformed bodies and unsupported reply kinds at supported pauses. Include `409` for not-waiting, human-gate-blocked, changed-step reply conflicts and `409 unsupported_pause` for unsupported human pause flavors.
### Test plan

Recommended focused tests:
- `packages/api-contract`: parse valid approve, feedback, and guidance request bodies; reject malformed bodies; parse the response schema; OpenAPI includes `POST /v1/runs/{id}/replies`.
- `packages/core/src/feedback-lifecycle.spec.ts`: generalized blocking and co-resolution work for `artifact` and `implementation` targets.
- `packages/core/src/feedback-lifecycle.spec.ts`: producer disposition helpers move revise-created artifact and implementation feedback from `open` to `addressed` or `wont_fix` with durable attribution/rationale.
- `packages/core/src/human-review-gate.spec.ts`: target mismatch fails; spec gate uses artifact blockers; implementation gate uses implementation blockers; other targets do not block.
- `packages/core/src/orchestrator.spec.ts`: human reply approval at spec gate uses existing finalizer and advances; feedback at spec gate creates artifact feedback and revises; approval at implementation gate advances; feedback at implementation gate creates implementation feedback and revises; runner-origin advance at human steps remains blocked.
- `packages/core/src/orchestrator.spec.ts`: approval blocked by open/addressed feedback and succeeds after resolved/wont_fix, with approver-owned addressed feedback co-resolved before checking.
- `packages/core/src/orchestrator.spec.ts`: after feedback revise, the producing step disposition path lets the next gate approval become unblocked without test-only feedback mutation.
- `packages/core/src/orchestrator.spec.ts`: `implementation.awaiting_input` guidance records checkpoint guidance on the current run step, advances to `implementation.build`, and schedules auto-dispatch.
- `packages/core/src/orchestrator.spec.ts`: simultaneous replies to the same paused run are serialized through the added/reused per-run serialization primitive; only one reply commits and contenders do not create duplicate feedback, checkpoint guidance, or transitions.
- `packages/core/src/control-plane-service.spec.ts`: rejects model principals, cross-tenant runs, terminal runs, non-human steps, unsupported pauses, and changed-step reply conflicts with the documented stable error codes.
- `packages/core/src/routes.spec.ts`: route parsing, policy call, service delegation, success status, and error mapping.
- `packages/sdk/src/client.spec.ts`: typed client method sends and parses reply requests/responses.
- `apps/control-plane/src/integration.spec.ts`: route-level integration with SQLite persistence for spec approval, implementation feedback revise, and implementation approval.
- End-to-end interactive proof: create run, reach spec gate, approve through HTTP reply, traverse the production `implementation.plan` handler, run real implementation convergence/altitude gates, reach implementation gate, submit feedback through HTTP reply, rerun implementation, approve through HTTP reply, and observe transition out of `implementation.human_review`.
### Validation

Recommended targeted validation after implementation:
```bash
pnpm nx test api-contract -- feedback.spec run-replies.spec openapi.spec
pnpm nx test core -- feedback-lifecycle.spec human-review-gate.spec orchestrator.spec control-plane-service.spec routes.spec
pnpm nx test sdk -- client.spec
pnpm nx test control-plane -- integration.spec implementation-build-convergence.smoke.spec
pnpm test:boundaries
```
Run `pnpm validate` when practical after targeted tests pass.
### Risks and mitigations

- **Runner gate bypass:** Keep origin-aware transition handling so only human-origin replies can advance human steps.
- **Partial feedback-plus-transition failure:** Prefer a shared transaction. If not available, return explicit safe state and cover retries.
- **Target drift:** Use one target mapping table and test both spec and implementation gates.
- **Escalation context loss:** Persist guidance before advancing, stamp or reference it on the destination build checkpoint, and verify `implementation.build` receives it from the current execution context.
- **Auto-dispatch race:** Reply responses should not promise follow-on steps are complete. Clients should observe events and reads.
- **Provider behavior varies:** The full e2e should use production paths. If live providers are unavailable in CI, keep deterministic integration coverage and make live provider proof opt-in with clear unsupported-provider behavior.
## Task list

### Story 1: Publish the reply API contract

**Description:** Add the shared `/v1/runs/:id/replies` contract surface so core, routes, SDK code, OpenAPI, and tests use one request and response shape.
**Leaf tasks:** T-001 Add run reply schemas and types; T-002 Export and document the route contract; T-003 Add policy descriptors and actions; T-004 Add the SDK reply method.
#### T-001: Add run reply schemas and types

**Description:** Create `packages/api-contract/src/run-replies.ts` with the agreed reply path, success status, structured request union, classification schema, response schema, and inferred TypeScript types.
**Acceptance criteria:**
- `runRepliesPath` is `'/v1/runs/:id/replies' as const`.
- `createRunReplySuccessStatusCode` is `200 as const`.
- `runReplyRequestSchema` accepts only strict `approve`, `feedback`, and `guidance` variants with the fields defined in the API contract section above.
- `runReplyClassificationSchema` includes `directive`, optional server-derived `target`, optional `createdFeedbackId`, and optional `pauseKind: 'convergence_escalation'`.
- `runReplyResponseSchema` returns `{ run, classification }` and reuses the existing `runSchema`.
- Schema tests cover valid approve, feedback, and guidance bodies; malformed bodies; extra properties; and response parsing.
**Dependencies:** none.
#### T-002: Export and document the route contract

**Description:** Wire the new contract into the package barrel and OpenAPI generator without changing existing run or feedback endpoint behavior.
**Acceptance criteria:**
- `packages/api-contract/src/index.ts` re-exports all run reply constants, schemas, and types.
- `packages/api-contract/src/openapi.ts` documents `POST /v1/runs/{id}/replies`.
- OpenAPI includes approve, feedback, and guidance request variants; the reply response schema; and documented `400`, `403`, `404`, `409`, and `500` responses.
- Existing feedback create contract remains artifact-only for `POST /v1/runs/:id/feedback`.
- OpenAPI tests prove the reply path and error responses are present.
**Dependencies:** T-001.
#### T-003: Add policy descriptors and actions

**Description:** Extend the core policy model so the protected reply route has its own child-resource action and descriptor.
**Acceptance criteria:**
- `PolicyAction` includes `run_replies.create`.
- `PolicyResourceDescriptor` includes `{ kind: 'run_replies'; id: string; path: '/v1/runs/:id/replies' }`.
- Route or service tests can assert the reply operation checks `run_replies.create`.
- Existing run, spec, feedback, and event policy actions keep their current behavior.
**Dependencies:** T-001.
#### T-004: Add the SDK reply method

**Description:** Add `ControlPlaneClient.replyToRun(id, request)` so clients can call the reply endpoint through the typed SDK.
**Acceptance criteria:**
- The SDK validates the request with `runReplyRequestSchema` before sending.
- The SDK sends `POST /v1/runs/:id/replies` with existing bearer-token behavior.
- The SDK validates the response with `runReplyResponseSchema`.
- SDK tests cover approve, feedback, guidance, request validation failure, response validation failure, and non-2xx propagation for `400 invalid_transition` and `409 conflict`.
**Dependencies:** T-001 and T-002.
### Story 2: Add the authenticated service and route ingress

**Description:** Expose a protected route and service facade that validate principals, tenancy, run state, and request shape before delegating all state changes to the orchestrator.
**Leaf tasks:** T-005 Add `ControlPlaneService.replyToRun`; T-006 Register `POST /v1/runs/:id/replies`; T-007 Normalize service and route errors.
#### T-005: Add `ControlPlaneService.replyToRun`

**Description:** Implement the service-level reply facade in `packages/core/src/control-plane-service.ts` using the input and result types from the API contract schemas.
**Acceptance criteria:**
- `ControlPlaneService` and `DefaultControlPlaneService` expose `replyToRun(input)`.
- The method authorizes `run_replies.create` with the run reply resource descriptor.
- The method rejects model principals before orchestration.
- The method loads the run, verifies tenant ownership, and returns `not_found` for missing or cross-tenant runs.
- The method refuses terminal runs and runs whose current step is not `waitingOn: 'human'` with `conflict`.
- The method delegates mutation to `orchestrator.replyToRun` and maps the result to `RunReplyResponse`.
- Service tests cover authorization, model-principal rejection, tenant ownership, terminal conflicts, non-human conflicts, unsupported pauses, changed-step reply conflicts, and successful response shaping.
**Dependencies:** T-001 and T-003.
#### T-006: Register `POST /v1/runs/:id/replies`

**Description:** Add the route in `packages/core/src/routes.ts` under the existing authenticated `/v1` app.
**Acceptance criteria:**
- The route parses `{ id }` from params and validates the body with `runReplyRequestSchema`.
- The route obtains the authenticated principal and tenant from the existing request context.
- The route calls `controlPlane.replyToRun({ tenant, principal, runId: id, request })`.
- The route returns status `200` and the `RunReplyResponse` body when the service succeeds.
- Route handlers do not call orchestrator or feedback lifecycle helpers directly.
- Route tests cover param/body parsing, policy-protected delegation, success, and safe error envelopes.
**Dependencies:** T-005.
#### T-007: Normalize service and route errors

**Description:** Make reply errors safe, stable, and consistent across the service, routes, OpenAPI, and SDK expectations.
**Acceptance criteria:**
- Unsupported reply kinds at the current supported pause map to `invalid_transition` and HTTP `400`.
- Malformed request bodies map to HTTP `400`.
- Policy denial and model-principal rejection map to HTTP `403`.
- Missing and cross-tenant runs map to HTTP `404`.
- Unsupported human pause flavors, including model-question `implementation.awaiting_input`, map to stable service code `unsupported_pause` and HTTP `409`.
- Terminal runs, non-human steps, step conflicts, and feedback blockers map to HTTP `409`.
- Unexpected persistence or orchestration failures use the standard safe `500` envelope.
- Error responses and logs do not include secrets, raw provider output, or absolute workspace paths.
**Dependencies:** T-005 and T-006.
### Story 3: Generalize feedback and human-review gate checks

**Description:** Reuse one target-aware feedback lifecycle and gate checker for spec and implementation review gates while preserving existing spec-gate imports and behavior.
**Leaf tasks:** T-008 Generalize feedback lifecycle helpers; T-009 Add the human-review gate helper and compatibility wrapper; T-010 Test target-specific feedback blocking and co-resolution.
#### T-008: Generalize feedback lifecycle helpers

**Description:** Update `packages/core/src/feedback-lifecycle.ts` so reply-derived gate feedback and blocker checks work for both `artifact` and `implementation` targets.
**Acceptance criteria:**
- `createGateFeedback` creates an `open` feedback item with the server-derived target, authenticated non-model owner, optional anchor, and first thread entry.
- `createArtifactFeedback` remains exported as a wrapper over `createGateFeedback({ target: 'artifact' })` for existing callers.
- `listBlockingFeedback({ runId, target })` accepts `FeedbackTarget` or at least `artifact | implementation`.
- `resolveApproverAddressedFeedback({ runId, target, approver })` co-resolves only the approver's addressed feedback for that target.
- Existing feedback routes keep artifact-only request behavior.
- Feedback lifecycle errors remain safe and typed.
**Dependencies:** T-001.
#### T-009: Add the human-review gate helper and compatibility wrapper

**Description:** Add `packages/core/src/human-review-gate.ts` and keep `packages/core/src/spec-review-gate.ts` as a wrapper over the generic helper.
**Acceptance criteria:**
- `gateFeedbackTargetByStep` maps `spec.human_review` to `artifact` and `implementation.human_review` to `implementation`.
- `isHumanReviewGateStep` and `getHumanReviewGateFeedbackTarget` expose the mapping safely.
- `HumanReviewGateError` exports stable `feedback_gate_blocked`, `invalid_step`, and `target_mismatch` codes.
- `assertHumanReviewGateCanAdvance` fails when the run is not at a supported gate, when the target does not match the gate, or when matching `open` or `addressed` feedback remains.
- `assertHumanReviewGateCanAdvance` ignores blockers for unrelated targets.
- `spec-review-gate.ts` preserves `SpecReviewGateBlockedError` and `assertSpecReviewGateCanAdvance` for existing imports.
**Dependencies:** T-008.
#### T-010: Test target-specific feedback blocking and co-resolution

**Description:** Add focused unit coverage for the generalized feedback lifecycle and gate helpers.
**Acceptance criteria:**
- `feedback-lifecycle.spec.ts` proves blocking and co-resolution work for artifact and implementation targets.
- `feedback-lifecycle.spec.ts` proves `createArtifactFeedback` remains compatible with existing service and route callers.
- `feedback-lifecycle.spec.ts` proves `createGateFeedback` sets ownership and initial thread content from the replying principal.
- `human-review-gate.spec.ts` proves spec gates use artifact blockers and implementation gates use implementation blockers.
- `human-review-gate.spec.ts` proves target mismatch, invalid-step, ignored-target, and blocked-gate errors use stable codes.
**Dependencies:** T-008 and T-009.
### Story 4: Apply human replies through the orchestrator

**Description:** Add an orchestrator-owned reply path that classifies structured replies, applies feedback side effects, preserves runner/human boundary checks, transitions through the workflow table, and schedules normal auto-dispatch.
**Leaf tasks:** T-011 Preserve runner-origin human-step guards; T-012 Implement gate reply classification and feedback side effects; T-013 Apply approval and revise transitions through workflow state; T-013A Disposition revise-created feedback in producing steps; T-014 Test orchestrator reply behavior.
#### T-011: Preserve runner-origin human-step guards

**Description:** Extend `ApplyOrchestratedDirectiveInput` with an internal origin field so human replies can move supported human pauses without allowing runner dispatch to leapfrog gates.
**Acceptance criteria:**
- `ApplyOrchestratedDirectiveInput.origin` accepts `'runner' | 'human' | 'system'`.
- Existing dispatch paths default to `origin: 'runner'`.
- Runner-origin directives remain blocked from advancing human-waiting steps.
- The reply path uses `origin: 'human'` only after classifying a supported structured reply.
- The reply path and runner dispatch share a per-run serialization primitive, added in this slice if necessary, so runner-origin dispatch and human-origin replies for the same run cannot overlap. The global bounded dispatch queue alone does not satisfy this criterion.
- Existing public API shapes do not expose arbitrary directives or origin selection.
- Unit tests prove runner-origin advance from human steps remains blocked.
**Dependencies:** T-009.
#### T-012: Implement gate reply classification and feedback side effects

**Description:** Add `Orchestrator.replyToRun` logic for `approve` and `feedback` replies at `spec.human_review` and `implementation.human_review`.
**Acceptance criteria:**
- The method reloads the run and verifies tenant ownership, non-terminal state, and a supported human pause.
- The method performs classification and side effects inside the serialized reply operation and, where supported, the same persistence transaction or run-level lock as the transition.
- `approve` at a supported gate classifies to `advance` with the target from `gateFeedbackTargetByStep`.
- `feedback` at a supported gate creates gate feedback using the derived target and classifies to `revise`.
- The method never trusts a target from the request body.
- Unsupported reply kinds at a supported gate fail with `invalid_transition`.
- The result includes the updated run and classification metadata, including `createdFeedbackId` for feedback replies.
**Dependencies:** T-008, T-009, and T-011.
#### T-013: Apply approval and revise transitions through workflow state

**Description:** Wire the classified gate reply outcomes to existing workflow transitions and gate-specific finalizers.
**Acceptance criteria:**
- Spec approval co-resolves the approver's addressed artifact feedback, checks remaining artifact blockers, finalizes spec approval, applies `advance`, and schedules normal auto-dispatch.
- Spec feedback creates artifact feedback, applies `revise` to `spec.author`, and schedules normal auto-dispatch.
- Implementation approval co-resolves the approver's addressed implementation feedback, checks remaining implementation blockers, applies `advance`, and schedules normal auto-dispatch.
- Implementation feedback creates implementation feedback, applies `revise` to `implementation.build`, and schedules normal auto-dispatch.
- All transitions use the workflow table through the existing run lifecycle path.
- Transition commit happens while the reply owns the per-run serialization primitive; a contender that observes the run has already left the original pause maps to `409` and does not commit feedback or transition side effects.
- If feedback creation succeeds but transition fails without a shared transaction, the thrown error includes safe retry-state details and does not leak internal paths or provider output.
**Dependencies:** T-012.
#### T-013A: Disposition revise-created feedback in producing steps

**Description:** Ensure the producing steps reached by gate `revise` replies consume and disposition reply-created feedback so subsequent approvals can be unblocked without test-only feedback mutation.
**Acceptance criteria:**
- `spec.author` loads open artifact feedback for the run and includes it in revision context.
- `spec.author` marks consumed artifact feedback `addressed` when incorporated or `wont_fix` with a durable rationale when intentionally declined before returning to `spec.human_review`.
- `implementation.build` loads open implementation feedback for the run and includes it in implementation convergence context.
- `implementation.build` marks consumed implementation feedback `addressed` when incorporated or `wont_fix` with a durable rationale when intentionally declined before returning to `implementation.human_review`.
- Producing-step disposition uses the same feedback lifecycle helpers as approval blocking, so target matching is consistent.
- The implementation-feedback e2e path reaches an approval-unblocked state through this producer disposition path before approving through the reply endpoint.
**Dependencies:** T-008, T-013, and T-014A.
#### T-014: Test orchestrator reply behavior

**Description:** Add orchestrator unit tests for all supported gate reply outcomes and guardrails.
**Acceptance criteria:**
- Tests prove spec approval uses the existing finalizer and advances.
- Tests prove spec feedback creates artifact feedback and revises.
- Tests prove implementation approval advances using implementation blockers.
- Tests prove implementation feedback creates implementation feedback and revises.
- Tests prove approval is blocked by remaining `open` or `addressed` target feedback and succeeds after blockers are `resolved` or `wont_fix`.
- Tests prove approver-owned addressed feedback is co-resolved before blocker checks.
- Tests prove revise-created feedback is dispositioned by `spec.author` or `implementation.build` before the next approval succeeds.
- Tests prove unrelated target feedback does not block a gate.
- Tests prove auto-dispatch is scheduled after successful reply transitions.
- Tests prove simultaneous replies to the same pause result in one committed reply and one changed-step/non-human `409`, with no duplicate feedback, checkpoint guidance, or transition.
**Dependencies:** T-011, T-012, T-013, and T-013A.
#### T-014A: Make `implementation.plan` traversable on the production path

**Description:** Add the minimal production behavior required for runs approved at `spec.human_review` to pass through `implementation.plan` before `implementation.build`.
**Acceptance criteria:**
- `implementation.plan` is handled by production dispatch code, not a test-only pump.
- The handler either produces a minimal durable implementation plan/checkpoint and applies `advance`, or records an explicit deterministic passthrough checkpoint and applies `advance`.
- The handler never runs an AI task with `prompt: undefined`.
- Step records and transition events show `spec.human_review -> implementation.plan -> implementation.build`.
- Integration or e2e coverage proves spec approval reaches real `implementation.build` only after `implementation.plan` completes.
**Dependencies:** none.
### Story 5: Resume convergence escalation guidance

**Description:** Support `guidance` replies at `implementation.awaiting_input` only for convergence escalation pauses, persist the guidance, and make the resumed implementation build consume it.
**Leaf tasks:** T-015 Add convergence checkpoint helpers; T-016 Wire guidance into reply and implementation dispatch; T-017 Test convergence guidance resume.
#### T-015: Add convergence checkpoint helpers

**Description:** Create `packages/core/src/convergence-checkpoint.ts` for the durable convergence escalation pause shape and read/write helpers.
**Acceptance criteria:**
- `ConvergenceEscalationPauseCheckpoint` contains `pause.kind: 'convergence_escalation'`, `pause.producingStep: 'implementation.build'`, and optional `pause.humanGuidance`.
- `ConvergenceCheckpointError` exposes `invalid_pause`, `changed_step`, and `persistence_failed` codes.
- `getConvergenceEscalationPause({ run, expectedStepId }, deps)` loads the current open/latest `RunStep` for `implementation.awaiting_input` and returns the pause only when that step's `checkpointResult` matches the supported convergence escalation shape.
- `recordConvergenceEscalationGuidance({ run, runStep, guidance }, deps)` persists guidance back to the same `RunStep.checkpointResult` before any transition is applied and rejects mismatches where the serialized operation finds the run step is no longer current.
- Helper errors stay low-level and are wrapped by the orchestrator boundary.
**Dependencies:** none.
#### T-016: Wire guidance into reply and implementation dispatch

**Description:** Extend `Orchestrator.replyToRun` and the `implementation.build` dispatch path so guidance replies resume the producing step with durable context.
**Acceptance criteria:**
- `guidance` at `implementation.awaiting_input` verifies the pause is a convergence escalation.
- Model-question or unknown `awaiting_input` pause flavors fail with stable `unsupported_pause` and HTTP `409`.
- The reply persists `body` as `humanGuidance` before applying `advance`.
- The workflow table advances from `implementation.awaiting_input` to `implementation.build`.
- Auto-dispatch schedules the resumed `implementation.build` step.
- The implementation convergence input reads the persisted guidance from the current build checkpoint, or follows `resumedFromAwaitingInputStepId` to the pause checkpoint, before invoking the implementer/reviewer loop.
- Guidance replies at review gates and approve/feedback replies at `implementation.awaiting_input` are refused with clear errors.
**Dependencies:** T-011 and T-015.
#### T-017: Test convergence guidance resume

**Description:** Add focused tests for checkpoint validation, durable guidance recording, transition, and resumed implementation context.
**Acceptance criteria:**
- `convergence-checkpoint` tests cover valid pause parsing, invalid pause rejection, and persistence failure wrapping.
- `convergence-checkpoint` tests cover loading the current run step, updating `RunStep.checkpointResult`, and changed-step rejection.
- Orchestrator tests prove `guidance` records checkpoint guidance, applies `advance`, reaches `implementation.build`, and schedules auto-dispatch.
- Orchestrator or convergence tests prove `implementation.build` receives the stored human guidance.
- Service tests prove unsupported `awaiting_input` pause flavors return `unsupported_pause` mapped to HTTP `409`.
- Tests prove unsupported reply kinds at `implementation.awaiting_input` are rejected.
**Dependencies:** T-015 and T-016.
### Story 6: Prove the full interactive path and update agent docs

**Description:** Add integration and opt-in end-to-end coverage for the production reply ingress, then update the agent code map so future agents can find the new wiring.
**Leaf tasks:** T-018 Add route, service, and SDK test coverage; T-019 Add SQLite-backed integration coverage; T-020 Add the opt-in interactive e2e proof; T-021 Update code map and run validation.
#### T-018: Add route, service, and SDK test coverage

**Description:** Complete focused tests around the public ingress layers after the orchestrator behavior is in place.
**Acceptance criteria:**
- `control-plane-service.spec.ts` covers successful reply responses and all documented service-level refusals.
- `routes.spec.ts` covers successful HTTP reply calls and `400`, `403`, `404`, `409`, and safe `500` mappings.
- `client.spec.ts` covers request validation, response parsing, bearer-token behavior, and non-2xx propagation.
- Tests assert invalid-transition maps to `400` while terminal, non-human, changed-step, and gate-blocked cases map to `409`.
- Tests assert unsupported human pause flavors map to stable `unsupported_pause` and HTTP `409`.
**Dependencies:** T-004, T-005, T-006, T-007, T-014, and T-017.
#### T-019: Add SQLite-backed integration coverage

**Description:** Extend `apps/control-plane/src/integration.spec.ts` or adjacent integration tests to exercise the reply endpoint with real persistence.
**Acceptance criteria:**
- Integration coverage proves spec approval through the reply endpoint transitions out of `spec.human_review`.
- Integration coverage proves implementation feedback creates `implementation` feedback, revises to `implementation.build`, and is dispositioned by the producing path before implementation approval succeeds.
- Integration coverage proves implementation approval transitions out of `implementation.human_review`.
- Integration coverage proves convergence escalation guidance persists and advances to `implementation.build`.
- Integration tests use production route, service, orchestrator, feedback lifecycle, and workflow transition code.
**Dependencies:** T-018.
#### T-020: Add the opt-in interactive e2e proof

**Description:** Add `apps/control-plane/src/interactive-run-replies.e2e.spec.ts` for the required production-path proof without a test-only pump or mocked human replies.
**Acceptance criteria:**
- The e2e creates a run and reaches `spec.human_review`.
- The e2e approves the spec through the HTTP reply endpoint.
- The e2e observes the production `implementation.plan` handler complete and advance to `implementation.build`.
- Real implementation convergence and descending-altitude gates run.
- The e2e reaches `implementation.human_review`, sends implementation feedback through the HTTP reply endpoint, and observes implementation rerun with the created feedback moved to `addressed` or `wont_fix` by the producing path.
- The e2e approves implementation through the HTTP reply endpoint after producer disposition and observes a transition out of `implementation.human_review`.
- The e2e is opt-in or clearly skipped when live provider requirements are unavailable in CI.
- The test documents unsupported provider behavior directly when providers cannot run the proof.
**Dependencies:** T-019.
#### T-021: Update code map and run validation

**Description:** Update agent-facing navigation and run the targeted validation suite for the new reply ingress.
**Acceptance criteria:**
- `context-agent/wiki/code-map.md` documents the reply contracts, service method, route, orchestrator reply handling, origin-aware guard, human-review gate, feedback lifecycle wrappers, convergence checkpoint helpers, SDK method, and tests.
- Targeted tests are run for `api-contract`, `core`, `sdk`, and `control-plane` areas listed in the tech spec validation plan.
- `pnpm test:boundaries` runs successfully.
- `pnpm validate` runs when practical after targeted tests pass.
- Any skipped validation is recorded with the exact reason, especially live-provider e2e limitations.
**Dependencies:** T-018, T-019, and T-020.
### Dependency graph

- Critical path: T-001 → T-002 → T-003 → T-005 → T-006 → T-007 → T-018 → T-019 → T-020 → T-021.
- Gate behavior path: T-001 → T-008 → T-009 → T-011 → T-012 → T-013 → T-013A → T-014 → T-018.
- Implementation plan path: T-014A → T-019 → T-020.
- Convergence path: T-015 → T-016 → T-017 → T-018.
- SDK path: T-001 → T-002 → T-004 → T-018.
- Parallel work: T-008 can begin after T-001 while route work proceeds; T-015 can begin immediately; T-004 can proceed once the contract exists.
### Reviewer pass

- The task list covers the API contract, compatibility wrappers, tests, SDK, OpenAPI, and `context-agent/wiki/code-map.md`.
- The tasks keep the public API constrained to structured replies and do not expose a generic directive endpoint.
- The dependencies preserve the runner/human boundary by introducing origin-aware directive handling before reply transitions.
- Feedback blocker checks are target-specific and explicitly test both artifact and implementation gates.
- Convergence guidance records durable context before advancing, stamps or references it on the resumed build step, and resumed `implementation.build` must read that context.
- The validation tasks include the required production-path proof while making live provider limitations explicit and opt-in.