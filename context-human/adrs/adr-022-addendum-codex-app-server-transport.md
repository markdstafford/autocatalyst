---
created: 2026-10-22
last_updated: 2026-10-22
status: accepted
decided_by: markdstafford
addendum_to: adr-022-runner-structure.md
issue: 114
---

# ADR-022 addendum: Codex adapter transport (app-server over stdio)

## Status

Accepted — addendum to [ADR-022](./adr-022-runner-structure.md).

## Context

Issue #114 adds a Codex agent adapter that runs existing model roles through an
operator-approved **Codex / ChatGPT enterprise sign-in**. ADR-022 prefers that
"each adapter imports its provider SDK as a library and consumes its interface
in-process". Codex is different from the Claude and OpenAI Agents adapters in one
decisive way: its approved enterprise authentication is held by the **Codex CLI's
own on-host sign-in** (`codex login`), not by an API key that Autocatalyst can
resolve from its secret store and hand to an in-process client. The feature's
billing-safety requirement forbids falling back to `OPENAI_API_KEY` or any other
account, so the adapter must use exactly the identity the operator approved on the
host.

The open question in the approved spec (`feature-codex-sdk-app-server-adapter.md`)
is: **Codex SDK as an in-process library, or Codex app-server over stdio?**

## Decision

**Use the Codex app-server over stdio (`codex app-server`, a subprocess) as the one
supported transport for this adapter. Implementing the in-process Codex SDK library
transport is explicitly out of scope for issue #114.**

- **Connection mechanism:** `process_environment`. The adapter reuses the existing
  `AgentConnection.createProcessLaunchConfig(...)` seam — the same seam the Claude
  agent adapter uses — so the orchestrator/connection boundary is unchanged. The
  connection layer owns the launch environment; the adapter never reads or writes
  raw credentials.
- **Authentication:** the enterprise sign-in lives in the Codex CLI's own credential
  cache on the host. The adapter runs an **auth probe** (a seam, injected in tests)
  before any session streaming and classifies `missing_sign_in`, `expired_sign_in`,
  `disallowed_plan`, or `account_mismatch` into safe, redacted diagnostics. It never
  reads, copies, logs, or persists the cached credential, and never falls back to an
  API key or a different account.
- **Event streaming:** the app-server emits a newline-delimited JSON event stream on
  stdout. The adapter maps those native events onto the canonical `RunnerEvent` union
  (assistant turns, tool activity, progress/notification, terminal result) exactly as
  the other agent adapters do, keeping the agent orchestrator provider-neutral.
- **Structured output:** captured from the app-server's terminal event and written by
  the **adapter** (not by the sandboxed Codex process) to the configured scratch
  result file via the shared `writeScratchStepResultFile` path. This keeps reviewer
  sessions read-only against the repository while still capturing the structured
  reviewer result.
- **Filesystem permissions:** the materialized tool policy maps to Codex sandbox
  values — implementer → `workspace-write`, reviewer → `read-only`. The accepted
  sandbox values are validated against the supported runtime rather than assumed; a
  role whose required sandbox value is not accepted fails with a safe
  `UnsupportedProviderCapabilityError` before any paid work.
- **Process lifecycle:** the adapter owns subprocess spawn and teardown behind the
  `launchCodexSession` seam. Cancellation, timeout, abnormal app-server exit, and
  protocol violations terminate the session cleanly with redacted diagnostics and no
  automatic paid retry.

## Why not the in-process SDK library (this issue)

- The approved enterprise identity is bound to the Codex CLI's on-host login. The
  app-server inherits that identity directly; an in-process library would push us
  toward an API-key or token-handoff path that the billing-safety requirement
  forbids.
- The probed runtime (Codex CLI **0.160.1**, 2026-10-22) exposes `app-server` and the
  `read-only` sandbox value, so the subprocess boundary is verifiable against a real
  runtime today.
- ADR-022 already lists "an external CLI subprocess per backend" as a considered
  alternative whose cost is process management and weaker streaming control. That
  cost is accepted *only here and only because* enterprise sign-in requires it; the
  Claude and OpenAI adapters remain in-process. Provider-specific subprocess handling
  is confined to `packages/codex-agent-adapter` and the existing `process_environment`
  connection seam, so no orchestrator gains a Codex-specific branch.

## Consequences

- One transport, one adapter package. The orchestrator, result schemas, and model
  routing stay provider-neutral.
- The adapter must manage a subprocess and parse its stdio protocol; this complexity
  is contained behind the `launchCodexSession` seam and is fully unit-testable with a
  fake transport (no enterprise inference in default tests).
- Supporting the in-process Codex SDK library later is a bounded, additive change: a
  second default launch seam, decided in a follow-up ADR.
