# Fake mode

Fake mode runs the control plane locally and deterministically, through the same production
entrypoint an operator uses in real dispatch — but with scripted model sessions, a scripted
GitHub issue tracker, and a scripted GitHub code host. No model spend, no network access, and no
real `gh` executable are required. It exists so manual client checks and browser/API tests can
exercise the real integration path (adapter composition, result contracts, convergence, workspace
provisioning, persistence, SDK calls, HTTP routes) against believable data.

## Quick start

Start fake mode and seed scenarios:

```bash
# Terminal 1 — start fake mode (builds, clears prior fake state safely, then serves).
pnpm nx run control-plane:serve-fake

# Terminal 2 — seed all five scenarios into the running server.
pnpm nx run control-plane:seed-fake -- --scenario all
```

`serve-fake` prints exactly one readiness line once the server is listening:

```text
fake-mode ready port=4010 stateDir=<absolute path> baseUrl=http://127.0.0.1:4010
```

Health check:

```bash
curl -H "Authorization: Bearer fake-mode-token" http://127.0.0.1:4010/health
```

Run the built entrypoint directly (does **not** wipe state):

```bash
node apps/control-plane/dist/src/main.js --fake-mode --fake-state-dir .autocatalyst-fake
```

Run the built seed script directly:

```bash
node apps/control-plane/dist/src/fake/seed-fake.js --scenario pr-open --fake-state-dir .autocatalyst-fake --json
```

## Settings and defaults

Fake mode is enabled by `--fake-mode` or `AUTOCATALYST_FAKE_MODE`. The state directory comes from
`--fake-state-dir`, `AUTOCATALYST_FAKE_STATE_DIR`, or `.autocatalyst-fake/` (resolved to an
absolute path). The following defaults apply **only** when fake mode is enabled and the usual
setting is absent; an explicit setting always wins.

| Setting | Fake default |
|---|---|
| Port | `4010` |
| Bearer token | `fake-mode-token` |
| Master secret | `fake-mode-master-secret` |
| Database path | `<stateDir>/control-plane.sqlite` |
| Repos root | `<stateDir>/repos` |
| Workspaces root | `<stateDir>/workspaces` |

Fake mode **owns dispatch and provider adapter selection**. Combining it with
`--default-provider-profile-id`, `AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID`, `--real-dispatch`, or
`AUTOCATALYST_REAL_DISPATCH` fails at startup with a message saying fake mode owns dispatch and
adapter selection.

On fresh startup fake mode creates a fake secret (value `fake-token`) and a Claude Agent SDK
provider profile that resolves AI steps to the scripted adapter, so runs can start without seeding.
Only the scripted Claude adapter is registered — no real Claude/OpenAI/Codex/Anthropic adapters are
composed, even if API-created profiles exist from a prior run.

## Fixture project

Created on fresh startup when absent:

| Field | Value |
|---|---|
| Display name | `Fixture app` |
| Repository URL | `https://github.com/autocatalyst-fixtures/demo-app` |
| Host repository | provider `github`, owner `autocatalyst-fixtures`, name `demo-app` |
| Issue tracker | provider `github` |
| Code host | provider `github` |
| Credential value | `fake-token` |

## Fixture issues

| Issue | Label | Used by |
|---|---|---|
| 1 | feature | `spec-review` |
| 2 | enhancement | `implementation-review` |
| 3 | bug | `pr-open` |
| 4 | chore | `merged` |
| 5 | (unlabeled) | no default run |
| 6 | feature | `failed` |
| 7 | feature | spare |
| 8 | enhancement | spare |
| 9 | bug | spare |
| 10 | chore | spare |
| 11 | (unlabeled) | spare, no default run |

Unlabeled issues (5, 11) have no recognized work-kind label and do not start a default run.

## Scenarios and work-kind sequences

Workflows differ by work kind, so each scenario follows its own sequence:

| Scenario | Issue | Work kind | Stops at |
|---|---|---|---|
| `spec-review` | 1 | feature | `spec.human_review` after the first spec author pass |
| `implementation-review` | 2 | enhancement | approves the spec gate, then `implementation.human_review` |
| `pr-open` | 3 | bug | runs `spec.author` (bug triage, no spec gate), approves `implementation.human_review`, stops at `pr.human_review`; does not call `GET /v1/runs/:id/spec` (404 for bugs) |
| `merged` | 4 | chore | no `spec.author`; approves `implementation.human_review`, opens the PR, writes `merged` to the PR state file, reconciles, stops at `done` |
| `failed` | 6 | feature | writes the `spec.author` failure file, stops at `failed` |
| `all` | — | — | seeds the five scenarios above, in that order |

## Seed command

```text
node apps/control-plane/dist/src/fake/seed-fake.js --scenario <name> [options]
```

| Flag | Description |
|---|---|
| `--scenario <name>` | One of `spec-review`, `implementation-review`, `pr-open`, `merged`, `failed`, `all`. Required. |
| `--issue <n>` | Override the default issue for the scenario. |
| `--base-url <url>` | Control-plane base URL (also `AUTOCATALYST_SEED_URL`; default `http://127.0.0.1:4010`). |
| `--bearer-token <token>` | Bearer token (also `AUTOCATALYST_SEED_TOKEN`; default `fake-mode-token`). |
| `--fake-state-dir <dir>` | State directory for PR/failure files (default `.autocatalyst-fake`). |
| `--json` | Emit exactly one JSON line per scenario on stdout. |

The seed talks to the server only through `@autocatalyst/sdk`. It creates or reuses the fake secret
and fixture project, then drives the scenario. It exits clearly (exit code 1) when no server
answers.

Human-readable output:

```text
seeded scenario=pr-open runId=run_… issueNumber=3 step=pr.human_review pullRequestNumber=101 pullRequestStateFile=.autocatalyst-fake/pull-requests/101.state
```

`--json` output (exactly one stdout line):

```json
{"runId":"run_…","issueNumber":3,"step":"pr.human_review","pullRequestNumber":101,"pullRequestStateFile":".autocatalyst-fake/pull-requests/101.state"}
```

`pullRequestNumber` and `pullRequestStateFile` are `null` where they do not apply.

If the selected issue already has a run, the seed stops with exit code `2`, changes nothing, and
prints a clear message to stderr. With `--json` it prints exactly one JSON line to stdout:

```json
{"error":"issue_already_has_run","issueNumber":3,"scenario":"pr-open"}
```

## State directory layout

The state directory is the control surface — there are no runtime scripting routes or headers.

| Path | Purpose |
|---|---|
| `.autocatalyst-fake-marker` | Marker written by fake-mode startup; enables safe `serve-fake` deletion |
| `control-plane.sqlite` | Durable database |
| `repos/` | Host repository clones (repos root) |
| `workspaces/` | Per-run workspaces (workspaces root) |
| `fixture-remote.git/` | Bare fixture remote with one commit on `main` |
| `repos/autocatalyst-fixtures/demo-app/` | Fixture host clone, `origin/HEAD` → `main` |
| `issues.json` | Fixture issues 1–11 |
| `pull-requests/counter` | Next pull request number (starts at `101`) |
| `pull-requests/<n>.state` | PR state word: `open`, `merged`, or `closed` |
| `pull-requests/<n>.json` | PR record (number, branch, url) |
| `failures/issue-<n>.json` | Failure control `{"step":"<step id>"}` |
| `failures/issue-<n>.json.fired` | Renamed after the failure fired once |
| `launch-context/<runId>-<seq>.json` | Recorded scripted-launch context |
| `counters/launch.count` | Scripted model launch counter |

### Pull request state files

PR state files contain exactly one of `open`, `merged`, or `closed`. Flip a PR to merged with a
plain file write and no HTTP route, then reconcile:

```bash
echo merged > .autocatalyst-fake/pull-requests/101.state
node apps/control-plane/dist/src/fake/seed-fake.js --scenario merged   # the merged scenario does this for you
```

### Failure files

To force a scripted model session to fail at a given step for an issue, write
`failures/issue-<number>.json` with `{"step":"<step id>"}` before the run reaches that step. The
first matching launch fails and the file is renamed with a `.fired` suffix. Valid failure step ids
are the AI steps that launch a scripted session: `spec.author`, `implementation.build`,
`pr.finalize`. The `failed` scenario writes `{"step":"spec.author"}` for issue 6.

## Scripted spec content and revision

For feature and enhancement runs, the first scripted `spec.author` spec contains a heading,
paragraphs, a table, a bullet list, a fenced code block, an emoji (`✨`) before passage A, and
passages A through D. Passages C and D appear before passage A; passage B and an `## Open questions`
heading appear after it.

A revision — triggered by request-changes at the spec gate or a feedback reply that requests
changes — deterministically:

- inserts `- A name is trimmed of leading and trailing spaces.` immediately before passage A
  (shifting passage A by the inserted source length in Unicode code points),
- removes passage B and its `Open questions` heading,
- leaves passages C and D in place (they precede the insertion point and do not move),
- marks every open spec comment `addressed` with a thread response.

Each later pass changes only a final line naming the pass number.

Bug runs run `spec.author` as a bug triage that advances the run; they do not create a
file-canonical spec, so `GET /v1/runs/:id/spec` returns 404 for bug runs.

## Safe deletion

`serve-fake` refuses to delete a non-empty state directory unless it contains the fake-mode marker
file written by fake-mode startup. Empty directories are safe to remove. This prevents accidental
deletion when a caller passes the wrong `--fake-state-dir`.

## Non-goals

Fake mode does not provide browser tooling or Playwright fixtures, runtime scripting through new
routes or headers, fakes for providers other than the Claude adapter and GitHub issue tracker /
code host, scripted paths for the docs gate or the two input pauses, or hosted deployment.
