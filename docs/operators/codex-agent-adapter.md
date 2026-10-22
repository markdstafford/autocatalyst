# Codex agent adapter (enterprise sign-in)

The Codex agent adapter (`@autocatalyst/codex-agent-adapter`) runs existing model
roles — spec authoring, implementation, review, PR finalization — through an
operator-approved **Codex / ChatGPT enterprise sign-in**, using the **Codex
app-server over stdio** (a subprocess). It does not use a Platform API key and
never falls back to one. See
[`context-human/adrs/adr-022-addendum-codex-app-server-transport.md`](../../context-human/adrs/adr-022-addendum-codex-app-server-transport.md)
for the transport decision.

- **providerKind:** `codex`
- **adapterId:** `codex-app-server`
- **connection mechanism:** `process_environment`
- **authentication:** enterprise sign-in (Codex CLI's own on-host login)

## Supported runtime

| Component | Supported version |
|---|---|
| Codex CLI / app-server | **0.160.1** (probed 2026-10-22) |
| Accepted sandbox values | `read-only`, `workspace-write` |

Validate against the installed runtime rather than documentation examples. If the
installed Codex runtime does not accept the sandbox value a role requires, the
adapter fails fast with `UnsupportedProviderCapabilityError('tool_policy_unsupported')`
before any paid work begins.

## Installation (clean checkout)

1. Install the supported Codex CLI on the host (follow your organization's
   approved distribution channel). Confirm the version:

   ```bash
   codex --version   # expect 0.160.1 (or your supported pin)
   ```

2. Complete the operator-approved **enterprise sign-in** on the host. Autocatalyst
   never performs the login and never stores the cached credential:

   ```bash
   codex login                 # enterprise / ChatGPT sign-in, operator-approved
   codex login status --json   # expect an authenticated enterprise/chatgpt method
   ```

3. Build and test the adapter without relying on a developer PATH:

   ```bash
   pnpm nx build codex-agent-adapter
   pnpm nx test codex-agent-adapter
   ```

## Enable the adapter at startup

The Codex adapter factory is registered in the control-plane real-dispatch adapter
map alongside the Claude and OpenAI adapters. Enable real dispatch as described in
[real-dispatch.md](./real-dispatch.md); no Codex-specific flag is required.

## Provider-profile example

```json
{
  "tenant": "tenant_1",
  "kind": "provider_profile",
  "providerKind": "codex",
  "adapterId": "codex-app-server",
  "settings": {
    "profileName": "Codex Enterprise",
    "model": {
      "provider": "openai",
      "model": "gpt-5-codex"
    },
    "inferenceSettings": {
      "reasoningEffort": "high"
    },
    "endpoint": {
      "requestTimeoutMs": 600000
    }
  }
}
```

Notes:

- No `credentialSecretHandle` is required for enterprise sign-in — the identity is
  the host's Codex login, not an Autocatalyst secret. Do **not** paste cached Codex
  credentials into Autocatalyst secrets.
- `reasoningEffort` (`low` | `medium` | `high`) is the one supported inference
  setting and maps to the Codex config `model_reasoning_effort`. `temperature`,
  `topP`, `maxOutputTokens`, and `seed` are reported as degraded capabilities; if a
  profile marks any of them as a required alteration, the session fails fast with a
  typed `UnsupportedProviderCapabilityError`.

## Filesystem permission behavior

| Role | Codex sandbox | Repository writes |
|---|---|---|
| implementer | `workspace-write` | persisted in the run workspace |
| reviewer | `read-only` | rejected; repository contents unchanged |

A read-only reviewer still records its structured verdict: the adapter captures the
structured result from the Codex event stream and writes it to the scratch result
file itself (the sandboxed process does not write the repository). PR finalization
writes `pr-finalize-result.json` and never a stale `step-result.json`.

## Safe diagnostics

The adapter logs only safe facts and never the cached credential, token, account
identity, cached-credential path, or raw app-server message text.

- **Startup composition** reports whether the Codex adapter is registered and that
  its connection mechanism is `process_environment`.
- **Authentication failures** report one safe code: `missing_sign_in`,
  `expired_sign_in`, `disallowed_plan`, or `account_mismatch`, with the public
  failure reason `provider_auth_failed`. There is no automatic paid retry and no
  fallback to `OPENAI_API_KEY` or another account.
- **Session metadata** reports adapter id, model identity, role, outcome, token
  usage when available, and marks usage **unavailable** (not zero) when the
  app-server does not report it.
- **Skill diagnostics** (`codex.adapter.session_start`) report requested, resolved,
  and delivered skill identifiers.

## Opt-in live smoke procedure

Live smoke consumes enterprise inference and is **opt-in and operator-authorized
only**. It must not start a new end-to-end run or approve any human gate
automatically. Run it against a disposable workspace:

1. Confirm enterprise sign-in: `codex login status --json`.
2. Configure a `codex` / `codex-app-server` provider profile (above) and route a
   single spec-authoring or implementation step to it.
3. Observe and record, **without any secret value**:
   - adapter id (`codex-app-server`) and model identity;
   - auth mode (`enterprise_sign_in`) and, on failure, the safe failure code;
   - terminal outcome (advance / needs_input / fail);
   - skill delivery (requested / resolved / delivered counts);
   - permission behavior (implementer write persisted; reviewer write rejected,
     repository unchanged);
   - structured result capture (correct per-round / PR-finalize result file written).

Do not approve human gates or launch a new E2E run as part of live smoke.
