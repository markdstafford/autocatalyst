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
