---
created: 2026-10-22
last_updated: 2026-10-22
status: proposed
addendum_to: adr-022-runner-structure.md
issue: 114
---

# ADR-022 addendum: Codex adapter transport (app-server over stdio)

## Status

Proposed for human review — addendum to [ADR-022](./adr-022-runner-structure.md).

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
- **Structured output:** parsed from the final assistant message after successful `turn/completed` and written by
  the **adapter** (not by the sandboxed Codex process) to the configured scratch
  result file via the shared `writeScratchStepResultFile` path with the active canonical schema. This keeps reviewer
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

## Why this transport

The app-server provides direct control of the initialization handshake, account
status, thread permissions, native skill inputs, streamed items, and turn completion.
The supported CLI version exposes these protocol shapes through generated bindings.
The SDK is another supported Codex integration and can also use Codex authentication;
API-key authentication is not an inherent SDK requirement. This issue selects one
transport to keep lifecycle and protocol tests focused.

## Consequences

- One transport, one adapter package. The orchestrator, result schemas, and model
  routing stay provider-neutral.
- The adapter must manage a subprocess and parse its stdio protocol; this complexity
  is contained behind the `launchCodexSession` seam and is fully unit-testable with a
  fake transport (no enterprise inference in default tests).
- Supporting the in-process Codex SDK library later is a bounded, additive change: a
  second default launch seam, decided in a follow-up ADR.
