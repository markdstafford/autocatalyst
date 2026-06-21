---
date: 2026-06-21
status: accepted
superseded_by: null
---
# implementation.build per-round result files
**Decision:** `implementation.build` writes one immutable result file per (round, role) — `implementation-build-round-<n>-<role>-result.json` (`implementationBuildResultFile` in core) — instead of a shared, overwritten `step-result.json`. The implementer's dispositions validate against `implementerDispositionsResultSchema` (`autocatalyst.implementer_dispositions.v1`); the reviewer's verdict against `reviewerResultSchema` (`autocatalyst.reviewer_result.v1`). The read-only reviewer's verdict is captured from its final session message by the Claude adapter (`maybeWriteResultFile` honors `outputContract.resultFile`), not a Write tool. `reviewerResultNormalizer` no longer maps an empty `{}` to satisfied.
**Rationale:**
- The reviewer runs read-only and could not write `step-result.json`; the file always held the implementer's last write, so its validation read the wrong author's output.
- An empty result normalized to `{ status: 'satisfied', findings: [] }`, so reviews "passed" without a reviewer verdict ever being recorded — and a revise round's `{ dispositions: [...] }` crashed when validated against the reviewer contract.
- Per-(round, role) files give each author its own contract and a complete, non-clobbered audit trail; cross-contract validation becomes impossible by construction.
**Constraints:**
- The reviewer stays read-only (no Write/Edit/Bash); its verdict must be its final message so the adapter can capture it into the reviewer's own result file.
- The result-file name is set once by the context builder's `outputContract.resultFile` and read by both boundary validation (`resolveScratchResultValidationConfig`) and the adapter — single source of truth.
- An absent or empty reviewer result is a real fault (`reviewer_result_invalid` / `schema_validation_failed`), never a silent satisfied.
**Rejected:** Grant the reviewer a path-scoped Write tool — rejected because the adapter does not sandbox writes to a path (cwd is the repo clone for two_roots), so a Write tool would let the reviewer modify the repo, breaking the read-only boundary. Capturing the final message into the reviewer's own file keeps the boundary intact.
