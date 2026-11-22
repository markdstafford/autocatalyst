# Real dispatch startup

The control-plane entrypoint runs real runner dispatch when the operator opts in with the
`AUTOCATALYST_REAL_DISPATCH` environment variable or the `--real-dispatch` flag.

## Quick start

```bash
CONTROL_PLANE_BEARER_TOKEN=dev-token \
CONTROL_PLANE_MASTER_SECRET=dev-master-secret \
CONTROL_PLANE_PORT=3000 \
CONTROL_PLANE_DATABASE_PATH=.data/control-plane.sqlite \
AUTOCATALYST_REAL_DISPATCH=1 \
AUTOCATALYST_REPOS_ROOT=/var/autocatalyst/repos \
AUTOCATALYST_WORKSPACES_ROOT=/var/autocatalyst/workspaces \
pnpm nx serve control-plane
```

Equivalent CLI flags:

```bash
pnpm nx serve control-plane -- \
  --real-dispatch \
  --default-provider-profile-id cfg_default \
  --repos-root /var/autocatalyst/repos \
  --workspaces-root /var/autocatalyst/workspaces
```

## Environment variables and flags

| Variable | Flag | Description |
|---|---|---|
| `AUTOCATALYST_REAL_DISPATCH=1\|true\|yes` | `--real-dispatch` | Enable real runner dispatch. |
| `AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID` | `--default-provider-profile-id <id>` | Fallback provider profile ID used when no routing table matches. Requires real dispatch to be enabled. |

Accepted truthy values for `AUTOCATALYST_REAL_DISPATCH`: `1`, `true`, `yes`.
Accepted falsy values: `0`, `false`, `no`. Any other value is rejected at startup.

`AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID` and `--default-provider-profile-id` require real dispatch to be enabled and must not be blank.

## Grove-backed Claude Agent SDK profile

Use this provider-profile shape for a Grove gateway that expects the `api-key` auth header and
long-running spec-authoring calls:

```json
{
  "tenant": "tenant_1",
  "kind": "provider_profile",
  "providerKind": "anthropic",
  "adapterId": "claude-agent-sdk",
  "settings": {
    "profileName": "Grove Claude Agent",
    "credentialSecretHandle": "sec_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "model": {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet"
    },
    "endpoint": {
      "baseUrl": "https://grove.example.internal/anthropic",
      "authHeaderName": "api-key",
      "requestTimeoutMs": 600000,
      "proxyMode": "auto",
      "headersToStrip": ["x-api-key"],
      "proxyRequestLogging": {
        "enabled": false
      }
    }
  }
}
```

`authHeaderName: "api-key"` tells the request-alteration layer to inject Grove's expected
authorization header. `requestTimeoutMs: 600000` gives spec-authoring runs up to ten minutes.
Proxy request logging is disabled by default so prompts, responses, and provider response bodies
are not written to logs.

The default request timeout is 60 000 ms. Profiles without an explicit `endpoint.requestTimeoutMs`
use that default, which is too low for long-running spec-authoring steps — always set it to
`600000` for agent-backed dispatch.

## Spec review before the human gate

Feature and enhancement runs use two sessions per review round under `spec.author`: an author and
a read-only reviewer. The reviewer reads the draft in scratch, not a commit. Only the selected,
validly reviewed draft can become the committed spec. If either role asks a question, answer at
`spec.awaiting_input` to resume that role.

### Passage highlights and target-level feedback

For a passage finding, the reviewer supplies a short, exact quote from the draft's Markdown. The
server binds the finding to a text range only if the quote occurs exactly once in the reviewed
draft and exactly once in the selected, committed Markdown. The Spec tab highlights the range.
A unique quote can move between drafts and still bind. If the server cannot bind it safely, the
finding stays visible on the spec as target-level feedback, without a highlight.

The spec step's checkpoint audit records the location decision for each finding:

| Code | Meaning |
|---|---|
| `bound` | The exact quote was unique in both drafts and the finding has a highlight. |
| `document_scope` | The finding concerns the whole spec and needs no highlight. |
| `quote_missing` | The reviewer omitted the passage quote or supplied only whitespace. |
| `quote_not_found_in_candidate` | The quote did not occur in the reviewed draft. |
| `quote_non_unique_in_candidate` | The quote occurred more than once in the reviewed draft. |
| `quote_removed_from_selected` | The quote did not occur in the selected draft. |
| `quote_non_unique_in_selected` | The quote occurred more than once in the selected draft. |

The structured logs use `spec_convergence_round` for round outcomes,
`spec_convergence_binding` for binding decisions (including `fallbackCode` for target-level
feedback), and `spec_convergence_failed` for safe failure codes. These events omit draft text,
feedback bodies, quotes, and workspace paths.

### Review limits and approval

A model finding marked `resolved` means automated review accepted the fix, not that a human
confirmed it or approved the spec. An author who declines a finding leaves it visible as
`wont_fix`, with a reason. Whether review converges or reaches a limit, approval at
`spec.human_review` remains a separate human action.

At `max_rounds` (the review limit) or `oscillation` (a repeated unresolved concern), the run
hands off the last validly reviewed draft with outstanding findings still open. Open findings
block approval under the normal gate rules. You can request changes or select **Decline finding**
on an eligible open model finding in this handoff. The API equivalent is
`PATCH /v1/runs/:id/feedback/:feedbackId` with
`{ "status": "wont_fix", "body": "<nonblank reason>" }`. This updates one finding without
advancing the run. It does not apply to human comments or to findings the author already declined.

See [fake-mode launch accounting](fake-mode.md#scripted-spec-content-and-revision) to verify the
two-role dispatch without a live provider.
