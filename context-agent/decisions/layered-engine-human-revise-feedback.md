---
date: 2026-06-20
status: accepted
superseded_by: null
---
# layered-engine-human-revise-feedback
**Decision:** `createLayeredConvergenceEngine` (the engine the control plane actually composes for `implementation.build`) loads open, human-authored implementation `Feedback` for the run and threads it into the build altitude: it is delivered to the implementer as a required disposition, blocks convergence until disposed, and is marked `addressed` (keyed to the disposed feedback id) once the altitude converges.
**Rationale:**
- A human revise reply at `implementation.human_review` persists a `Feedback` (`target: implementation`, `status: open`) and transitions back to `implementation.build`, but the layered engine previously seeded findings only from its own reviewer rounds — so the revise build round converged in a zero-change round and left the feedback open. The non-layered `createConvergenceEngine` already loads/addresses such feedback; the layered engine (used in production) did not.
- Feedback is loaded once in `runEngine` and only handed to the `build` altitude (`altitude === 'build'`); human implementation feedback is build-level and the default depth is `build_only`.
- Only feedback whose originating thread author is `kind: 'human'` is seeded, so reviewer/system feedback created during convergence is not swept in. This keeps resolution keyed to genuine human requests rather than blanket-closing all open implementation feedback (the non-layered engine's coarser approach).
- End state is `addressed`, not `resolved`: the approval gate's `resolveApproverAddressedFeedback` (`orchestrator.#replyToHumanReviewGate`) resolves the human-originated `addressed` feedback when the human approves. Marking it `resolved` in the build round would bypass that co-resolution and skip the human's confirmation.
**Constraints:**
- The composition root (`apps/control-plane/src/server.ts`) does not pass `clock`/`idGenerator` to the layered engine, so the feedback handling must not gate on their presence — it uses `options.clock ?? Date.now`-style defaults.
- An undisposed human finding stays a blocker; a no-op round (no disposition) cannot converge, and from round 2 the existing disposition-required check fails with `disposition_missing`. This encodes the invariant: a run cannot advance out of `implementation.build` while a human implementation feedback is open and unaddressed.
**Rejected:** Blanket-addressing every open implementation feedback after convergence (the non-layered engine's approach) — closes reviewer/system feedback and is not keyed to what the implementer actually disposed. Marking feedback `resolved` directly in the build round — conflicts with the approval-gate co-resolution and skips human confirmation.

## Sibling: spec.human_review --revise--> spec.author
The spec authoring path had the same root shape (human revise feedback persisted but not delivered to the producer), in a different layer: `spec.author` is one-shot (not the convergence engine), so there are no dispositions. Fix is delivery-only — the control-plane `loadSpecAuthorPromptInput` now loads open human-authored `artifact` feedback (`status: open`, first thread author `kind: 'human'`) and passes it as `SpecAuthorPromptInput.revisionFeedback`, which `buildSpecAuthorPrompt` renders as a "Revision requests" section and `buildSpecAuthorTaskInputs` echoes. Resolution already worked: `completeSpecAuthoring` addresses open `artifact` feedback after the author produces a result, and the spec review gate plus approver co-resolution close the loop. No engine/blocking change was needed because the spec gate already refuses to advance while artifact feedback is open/addressed — the only gap was that the author never saw the request.
