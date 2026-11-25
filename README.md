# Autocatalyst

Autocatalyst runs an AI-led loop from a filed issue to a merged pull request, reserving human
attention for the decisions that compound: what to build, whether the spec is right, and whether the
result works.

## Status

Pre-implementation. The architecture decisions and concept docs are settled, and the build proceeds as
a sequence of issues, each a vertically complete capability that lands as one pull request.

## Documentation

`AGENTS.md` is the entry point and map. From it:

- [`context-human/spec.md`](context-human/spec.md) — the central technical overview.
- [`context-human/app.md`](context-human/app.md) — the product overview: what the system is and why.
- [`context-human/concepts/`](context-human/concepts/index.md) — the architectural contracts.
- [`context-human/adrs/`](context-human/adrs/index.md) — the architecture decision records.

## Run locally

From the repository root, run `pnpm install` and `pnpm nx build web`.

### Fake mode

Use fake mode to try the UI with scripted runs. It uses no model or GitHub calls.
The serve command resets the previous fake state. Start it in one terminal and
seed example runs from another:

```sh
AUTOCATALYST_CLIENT_DIR=apps/web/dist pnpm nx run control-plane:serve-fake
pnpm nx run control-plane:seed-fake -- --scenario all
```

Open http://localhost:4010 and connect with `fake-mode-token`.

### Real mode

Start the server with your own bearer token and database encryption secret:

```sh
mkdir -p .data .data/repos .data/workspaces
AUTOCATALYST_REAL_DISPATCH=1 \
AUTOCATALYST_CLIENT_DIR=apps/web/dist \
AUTOCATALYST_REPOS_ROOT=.data/repos \
AUTOCATALYST_WORKSPACES_ROOT=.data/workspaces \
CONTROL_PLANE_PORT=4010 \
CONTROL_PLANE_DATABASE_PATH=.data/control-plane.sqlite \
CONTROL_PLANE_BEARER_TOKEN="${CONTROL_PLANE_BEARER_TOKEN:?set a local bearer token}" \
CONTROL_PLANE_MASTER_SECRET="${CONTROL_PLANE_MASTER_SECRET:?set a database encryption secret}" \
pnpm nx serve control-plane
```

Connect with that bearer token and configure a project and provider profiles.
For subscription profiles, sign in on the server host and put the CLIs on its PATH:

| Provider | Adapter ID | Host login |
|---|---|---|
| `codex` | `codex-app-server-business` | `codex login` with a ChatGPT Business account. Use CLI 0.171.0. |
| `anthropic` | `claude-agent-sdk-subscription` | `claude auth login` with a Claude subscription. |

Give each profile an explicit model. Restart after saving the profiles, then
activate a routing table that references them. Subscription profiles reject API
credentials and gateway overrides.

## Contributing

Autocatalyst is in early development and is not accepting external contributions yet. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

No license is granted yet; all rights reserved. A license will be added before the project opens to
outside use or contribution.
