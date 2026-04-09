---
created: 2026-04-08
last_updated: 2026-04-08
status: approved
---

# Foundation

## What

The foundation is the CLI entry point that starts the Autocatalyst service, loads configuration from the target repo's WORKFLOW.md, resolves environment variables, and emits structured JSON logs on every event. It provides the process lifecycle (startup, shutdown), configuration mechanism (load, validate, hot-reload), and logging infrastructure that all subsequent features build on.

## Why

Nothing else can be built until there is a running service to attach to. Features 2-4 (Slack connection, spec generation, implementation) all need a configured, observable process to plug into. The foundation establishes that process and ensures it is observable from the first line of code.

## Personas

- **Enzo: Engineer** — starts and configures the service, verifies it runs correctly

## Narratives

### First run

Enzo clones the Autocatalyst repo and builds it. He runs `autocatalyst --repo ~/git/amp-cli`.

No `WORKFLOW.md` exists in the target repo yet. The CLI detects this, infers defaults — polling interval, workspace root, a placeholder prompt template — and writes a `WORKFLOW.md` to the repo root. It also logs which environment variables are expected and which are currently missing. Enzo sets the missing variables and restarts.

The service starts, logs that it loaded `WORKFLOW.md`, confirms it found the required environment variables, and reports that it's ready. The logs are structured JSON — he pipes them through `jq` to spot-check that the fields are stable and the config loaded correctly.

While the service is running, Enzo edits `WORKFLOW.md` to adjust the polling interval. The service detects the change, reloads the config, and logs the updated values. No restart needed. Later, Enzo accidentally introduces a YAML syntax error while editing the file. The service logs the parse failure and keeps running with the last known good config.

Enzo fixes the YAML error and saves. The service picks up the valid config and resumes normal operation. (If he hadn't fixed it and restarted the service instead, it would fail on startup with a clear log of the parse error — there's no last known good config across restarts.)

He hits Ctrl-C. The service logs a shutdown event and exits cleanly.

## User stories

- Enzo can start the service by pointing it at a target repo
- Enzo can see a `WORKFLOW.md` bootstrapped automatically when one doesn't exist
- Enzo can review and edit the generated `WORKFLOW.md` before restarting
- Enzo can see which environment variables are expected and which are missing
- Enzo can confirm the service loaded the correct config by reading the startup logs
- Enzo can pipe logs through `jq` and get valid structured JSON on every line
- Enzo can edit `WORKFLOW.md` while the service is running and see the new config applied without restarting
- Enzo can introduce a syntax error in `WORKFLOW.md` while the service is running and the service keeps running with the last known good config
- Enzo can see a clear parse error on startup if `WORKFLOW.md` has a syntax error and no last known good config exists
- Enzo can stop the service with Ctrl-C and see a clean shutdown log

## Goals

1. An agent can start the service from the command line pointed at a target repo
2. The service loads WORKFLOW.md from the target repo for project-level config; bootstraps one if missing
3. WORKFLOW.md changes are hot-reloaded without restart; invalid reloads preserve last known good config
4. Secrets are loaded from environment variables; missing variables are logged clearly
5. Every significant event is logged as structured JSON to stdout
6. The service starts cleanly and shuts down gracefully on SIGINT/SIGTERM
7. Configuration hierarchy: WORKFLOW.md for project config, env vars for secrets, CLI flags for operator overrides

## Non-goals

- WORKFLOW.md in subfolders
- Multi-repo support

## Tech spec

### Introduction and overview

**Prerequisites and assumptions:**
- TypeScript on Node.js (service-language decision)
- pino for structured logging (logging standard)
- WORKFLOW.md follows Symphony-style YAML frontmatter + Markdown body
- Target repo exists locally and is accessible via filesystem path

**Goals:**
- Service starts in under 2 seconds from CLI invocation
- WORKFLOW.md hot-reload detects changes within 1 second
- All log entries are valid JSON parseable by `jq`
- Zero external dependencies at startup (no database, no network connections)

**Glossary:**
- **WORKFLOW.md** — repository-owned config file defining project-level settings as YAML frontmatter with a Markdown prompt body. Specific settings (Slack, agent, etc.) are defined by the features that need them.
- **Hot-reload** — detecting WORKFLOW.md file changes and applying new config without restarting the service
- **Prompt template** — the Markdown body of WORKFLOW.md, rendered with variables and passed to agents during spec generation and implementation

### System design and architecture

**Component breakdown:**

```
src/
  index.ts              ← CLI entry point: parse args, bootstrap, run
  core/
    service.ts          ← Service lifecycle: start, run loop, shutdown
    config.ts           ← WORKFLOW.md loading, parsing, validation, bootstrapping
    config-watcher.ts   ← File watcher for hot-reload
  types/
    config.ts           ← WorkflowConfig type, validation schema
  config/
    defaults.ts         ← Default WORKFLOW.md template for bootstrapping
```

Four components:

1. **CLI (`index.ts`)** — parses `--repo` flag, validates the repo path exists, bootstraps config, creates the service, registers signal handlers, starts the run loop
2. **Service (`core/service.ts`)** — owns the lifecycle. `start()` loads config and begins the tick loop. `stop()` logs shutdown and cleans up. Future features register handlers on the service.
3. **Config loader (`core/config.ts`)** — reads WORKFLOW.md, parses YAML frontmatter, parses Markdown body as the prompt template, validates structure, resolves env vars (`$VAR` substitution). If no WORKFLOW.md exists, writes a bootstrapped default and continues. The config schema is extensible — future features add their own sections.
4. **Config watcher (`core/config-watcher.ts`)** — watches WORKFLOW.md for changes using `fs.watch`. On change, calls the config loader. On success, swaps the config and prompt template, logs the change. On failure, logs the parse error and keeps the current config.

**Startup sequence:**

```
CLI parses --repo flag
  → validate repo path exists
  → config loader reads WORKFLOW.md (or bootstraps default if missing)
  → parse YAML frontmatter → WorkflowConfig
  → parse Markdown body → prompt template
  → if parse error: log error, exit with code 1
  → resolve $VAR references against env vars
  → if required env vars missing: log which ones, exit with code 1
  → log loaded config
  → create service with loaded config + prompt template
  → register SIGINT/SIGTERM → service.stop()
  → start config watcher
  → service.start()
```

### Detailed design

**WorkflowConfig type:**

```typescript
interface WorkflowConfig {
  polling?: {
    interval_ms?: number;    // default: 30000
  };
  workspace?: {
    root?: string;           // default: ~/.autocatalyst/workspaces/<repo-name>
  };
  // Future features extend this: slack, agent, hooks, etc.
  [key: string]: unknown;
}

interface LoadedConfig {
  config: WorkflowConfig;
  promptTemplate: string;
  filePath: string;
}
```

Unknown keys are preserved, not rejected — this allows future features to add config sections without modifying the foundation.

All paths use `path.join`/`path.resolve` for cross-platform compatibility. `~` is expanded via `os.homedir()`. `$VAR` resolution uses `process.env` (works on all platforms; `%VAR%` Windows-style is not supported — `$VAR` is the WORKFLOW.md convention).

**WORKFLOW.md bootstrap template:**

```yaml
---
polling:
  interval_ms: 30000
workspace:
  root: ~/.autocatalyst/workspaces/<repo-name>
---

You are working on an idea for the {{ repo_name }} project.

{{ idea.content }}
```

`<repo-name>` is replaced with the actual repo directory name during bootstrapping.

**Config parsing logic:**

1. Read file contents as UTF-8
2. Split on `---` delimiters to separate YAML frontmatter from Markdown body
3. Parse YAML with `yaml` package (strict mode — duplicate keys are errors)
4. Walk all string values recursively — resolve `$VAR` patterns against `process.env`
5. If a `$VAR` resolves to empty/undefined, collect it as a missing variable
6. After resolution, validate known fields (polling.interval_ms is a positive number, workspace.root is a non-empty string)
7. Return `LoadedConfig` with parsed config, raw prompt template string, and file path

**$VAR resolution rules:**
- `$VAR` or `${VAR}` — resolved from `process.env`
- Empty-resolving variables are treated as missing, not as empty string
- Literal `$` is escaped as `$$`

**File watching:**

`fs.watch` on the WORKFLOW.md path. Debounce with a 200ms window (editors often trigger multiple write events per save). On change:
1. Re-run the full parse pipeline
2. On success: swap `LoadedConfig`, log `{ event: "config.reloaded", changed_keys: [...] }`
3. On failure: log `{ event: "config.reload_failed", error: "..." }`, keep current config

**Graceful shutdown:**

`SIGINT` and `SIGTERM` handlers call `service.stop()`, which:
1. Logs `{ event: "service.stopping" }`
2. Stops the config watcher
3. Stops the tick loop (waits for current tick to complete, does not abort mid-tick)
4. Logs `{ event: "service.stopped" }`
5. Exits with code 0

### Security, privacy, and compliance

**Secrets handling:**
- Secrets (`$SLACK_BOT_TOKEN`, `$ANTHROPIC_API_KEY`) are resolved from env vars at runtime, never written to WORKFLOW.md or logged
- Config logging redacts any value that was resolved from a `$VAR` reference — log the key name and `"[from env]"`, not the value
- The bootstrapped WORKFLOW.md template uses `$VAR` references, never literal secrets

**Filesystem:**
- Config loader reads only WORKFLOW.md from the target repo — no directory traversal, no glob patterns
- Workspace root path is validated as absolute after `~` expansion

### Observability

**Log events:**

| Event | Level | When |
|---|---|---|
| `service.starting` | info | CLI parsed, about to load config |
| `config.bootstrapped` | info | WORKFLOW.md created from template |
| `config.loaded` | info | WORKFLOW.md parsed successfully |
| `config.env_missing` | warn | One or more `$VAR` references unresolved |
| `config.reloaded` | info | Hot-reload succeeded |
| `config.reload_failed` | warn | Hot-reload parse error, keeping last known good |
| `config.parse_error` | error | Startup parse error, exiting |
| `service.ready` | info | Service is running and tick loop started |
| `service.stopping` | info | Shutdown signal received |
| `service.stopped` | info | Clean shutdown complete |

All events include `timestamp`, `level`, `component`, `event` per the logging standard.

**Metrics (OpenTelemetry):**
- `config.reload.count` (counter) — total reloads attempted
- `config.reload.failures` (counter) — failed reloads
- `service.uptime_ms` (gauge) — time since service.ready

### Testing plan

**Config parser:**
- Valid YAML + Markdown body → correct `LoadedConfig`
- Empty frontmatter (`---\n---\n`) → valid config with defaults
- No frontmatter (plain Markdown file) → parse error
- Duplicate YAML keys → parse error
- Unknown keys preserved in output
- Null values in YAML → handled without crash
- `$VAR` at start, middle, end of string → resolved correctly
- `${VAR}` with braces → resolved correctly
- `$$` → literal `$`
- Multiple `$VAR` in one string (`$HOST:$PORT`) → both resolved
- `$VAR` in non-string values (numbers, booleans) → not resolved, left as-is
- `$VAR` resolving to a string containing `$OTHER` → not recursively resolved
- `$VAR` set but empty → treated as missing
- Validation: negative `interval_ms` → error
- Validation: empty `workspace.root` after resolution → error

**Bootstrap:**
- No WORKFLOW.md → file created with repo name substituted
- WORKFLOW.md already exists → not overwritten
- Read-only target repo → clear error logged
- Repo name derived correctly from paths with trailing slash, nested paths

**Config watcher:**
- File change triggers reload callback
- Rapid consecutive changes within debounce window → exactly one reload
- Successful reload swaps config and prompt template
- Failed reload keeps previous config, logs error
- File deleted while watching → error logged, watcher remains active
- File replaced (delete + recreate) → watcher recovers or re-attaches
- `stop()` cleans up watcher — no leaked file handles

**Service lifecycle:**
- `start()` logs `service.ready`
- `stop()` logs `service.stopping` then `service.stopped`, exits 0
- `stop()` waits for current tick to complete
- Double SIGINT → clean shutdown, no crash
- `stop()` before `start()` → no crash

**CLI:**
- `--repo` with valid directory → starts normally
- `--repo` with nonexistent path → error, exit 1
- `--repo` with a file instead of directory → error, exit 1
- `--repo` with relative path → resolved to absolute
- No `--repo` flag → usage message, exit 1
- `--help` → usage info, exit 0

**Integration tests:**
- Full startup: CLI → config load → service ready → shutdown → exit 0
- Bootstrap flow: no WORKFLOW.md → created → service starts with defaults
- Missing env vars: logs which ones, exits 1
- Invalid WORKFLOW.md on startup: logs parse error, exits 1
- Hot-reload end-to-end: edit file on disk → config reloaded → new values in effect
- Hot-reload with parse error → current config retained

**Cross-cutting invariants (run against every error path):**
- All output to stdout is valid JSON parseable by `jq`
- No log entry contains a resolved `$VAR` value — redacted values show `"[from env]"`

### Alternatives considered

**Config format:** Considered JSON, TOML, and plain env files instead of YAML frontmatter + Markdown. YAML frontmatter follows the Symphony convention and naturally pairs config with the prompt template in a single file. JSON lacks comments. TOML is less familiar to agents. Plain env files can't express nested structure.

**File watching:** Considered polling on the tick interval instead of `fs.watch`. Polling is simpler but adds latency (up to 30 seconds with default interval). `fs.watch` has cross-platform quirks but responds within milliseconds. The debounce layer handles the quirks.

### Risks

- **`fs.watch` reliability**: `fs.watch` behavior varies across platforms and editors. Some editors (Vim, VS Code) delete and recreate files on save, which can break the watch. Mitigation: detect loss of watch and re-attach. Test with common editors.
- **WORKFLOW.md schema evolution**: as features add config sections, the schema grows. Mitigation: unknown keys are preserved, so old configs work with new code. Schema validation only applies to known keys.

## Task list

- [ ] **Story: Project scaffolding**
  - [ ] **Task: Initialize TypeScript project**
    - **Description**: Create `package.json`, `tsconfig.json`, and Vitest config. Set up `src/` and `tests/` directory structure per coding standard. Add pino and yaml as dependencies. Pin exact versions.
    - **Acceptance criteria**:
      - [ ] `npm install` completes without errors
      - [ ] `npm test` runs Vitest (no tests yet, exits clean)
      - [ ] `npx tsc --noEmit` compiles with zero errors
      - [ ] Directory structure matches coding standard (`src/core/`, `src/types/`, `src/config/`, `tests/core/`)
    - **Dependencies**: None
  - [ ] **Task: Set up pino structured logging**
    - **Description**: Create a logger factory that produces pino instances with the standard fields (`timestamp`, `level`, `component`, `event`). Export a `createLogger(component: string)` function.
    - **Acceptance criteria**:
      - [ ] `createLogger("test")` produces a pino instance
      - [ ] Log output is valid JSON with all required fields per logging standard
      - [ ] Tests: logger output is valid JSON, required fields present
    - **Dependencies**: "Initialize TypeScript project"

- [ ] **Story: Config types and parsing**
  - [ ] **Task: Define WorkflowConfig type and LoadedConfig interface**
    - **Description**: Create `src/types/config.ts` with `WorkflowConfig` (extensible, unknown keys preserved) and `LoadedConfig` (config + promptTemplate + filePath).
    - **Acceptance criteria**:
      - [ ] Types compile without errors
      - [ ] `WorkflowConfig` accepts unknown keys via index signature
      - [ ] Tests: type assertions verify structure
    - **Dependencies**: "Initialize TypeScript project"
  - [ ] **Task: Implement WORKFLOW.md parser**
    - **Description**: Create `src/core/config.ts` with a `parseWorkflow(content: string)` function. Splits on `---` delimiters, parses YAML frontmatter, extracts Markdown body as prompt template.
    - **Acceptance criteria**:
      - [ ] Valid YAML + Markdown → correct `LoadedConfig`
      - [ ] Empty frontmatter → config with defaults
      - [ ] No frontmatter → parse error
      - [ ] Duplicate YAML keys → parse error
      - [ ] Unknown keys preserved
      - [ ] Null values handled without crash
      - [ ] Tests: all cases from testing plan "Config parser" section
    - **Dependencies**: "Define WorkflowConfig type"
  - [ ] **Task: Implement $VAR resolution**
    - **Description**: Add `resolveEnvVars(config: object)` to `src/core/config.ts`. Recursively walks all string values, resolves `$VAR` and `${VAR}` patterns, handles `$$` escape, collects missing variables.
    - **Acceptance criteria**:
      - [ ] `$VAR` at start/middle/end resolved correctly
      - [ ] `${VAR}` with braces resolved
      - [ ] `$$` produces literal `$`
      - [ ] Multiple `$VAR` in one string both resolved
      - [ ] Non-string values (numbers, booleans) not resolved
      - [ ] `$VAR` resolving to string containing `$OTHER` not recursively resolved
      - [ ] Empty env var treated as missing
      - [ ] Returns list of missing variables
      - [ ] Tests: all cases from testing plan "$VAR" section
    - **Dependencies**: "Implement WORKFLOW.md parser"
  - [ ] **Task: Implement config validation**
    - **Description**: Add `validateConfig(config: WorkflowConfig)` to `src/core/config.ts`. Validates known fields after $VAR resolution. Returns typed errors for invalid values.
    - **Acceptance criteria**:
      - [ ] Valid config passes
      - [ ] Negative `interval_ms` → validation error
      - [ ] Empty `workspace.root` after resolution → validation error
      - [ ] Unknown keys do not trigger errors
      - [ ] Tests: valid and invalid cases
    - **Dependencies**: "Implement $VAR resolution"
  - [ ] **Task: Implement config redaction for logging**
    - **Description**: Add `redactConfig(config: object, resolvedVars: string[])` that replaces any value that was resolved from a `$VAR` with `"[from env]"`. Used when logging loaded config.
    - **Acceptance criteria**:
      - [ ] Values from env vars show `"[from env]"`
      - [ ] Non-env values logged as-is
      - [ ] Nested values handled correctly
      - [ ] Tests: redaction covers all resolved vars, leaves others untouched
    - **Dependencies**: "Implement $VAR resolution"

- [ ] **Story: WORKFLOW.md bootstrap**
  - [ ] **Task: Create default WORKFLOW.md template**
    - **Description**: Create `src/config/defaults.ts` exporting a function that generates the default WORKFLOW.md content with repo name substituted.
    - **Acceptance criteria**:
      - [ ] Template is valid YAML frontmatter + Markdown
      - [ ] Repo name substituted correctly
      - [ ] Parseable by the config parser
      - [ ] Tests: generated template parses successfully, repo name appears in correct locations
    - **Dependencies**: "Implement WORKFLOW.md parser"
  - [ ] **Task: Implement bootstrap logic**
    - **Description**: Add `bootstrapWorkflow(repoPath: string)` to `src/core/config.ts`. Checks if WORKFLOW.md exists, generates default if missing, writes to repo root.
    - **Acceptance criteria**:
      - [ ] Missing WORKFLOW.md → file created
      - [ ] Existing WORKFLOW.md → not overwritten
      - [ ] Read-only repo → clear error
      - [ ] Repo name derived correctly from paths with trailing slashes, nested paths
      - [ ] Tests: all bootstrap cases from testing plan
    - **Dependencies**: "Create default WORKFLOW.md template"

- [ ] **Story: Config watcher**
  - [ ] **Task: Implement file watcher with debounce**
    - **Description**: Create `src/core/config-watcher.ts`. Uses `fs.watch` with a 200ms debounce window. On detected change, calls a reload callback. Handles watch recovery for editors that delete+recreate files.
    - **Acceptance criteria**:
      - [ ] File change triggers reload callback
      - [ ] Rapid changes within debounce → exactly one callback
      - [ ] File deleted → error logged, watcher remains active
      - [ ] File replaced (delete + recreate) → watcher recovers
      - [ ] `stop()` cleans up — no leaked file handles
      - [ ] Tests: all config watcher cases from testing plan
    - **Dependencies**: "Implement WORKFLOW.md parser"
  - [ ] **Task: Implement hot-reload logic**
    - **Description**: Wire config watcher to config loader. On successful reload: swap config and prompt template, log with changed keys. On failure: log error, keep current config.
    - **Acceptance criteria**:
      - [ ] Successful reload swaps config and prompt template
      - [ ] Failed reload keeps previous config
      - [ ] `config.reloaded` event logged with changed keys on success
      - [ ] `config.reload_failed` event logged with error on failure
      - [ ] Tests: reload success and failure paths
    - **Dependencies**: "Implement file watcher with debounce", "Implement config validation"

- [ ] **Story: Service lifecycle**
  - [ ] **Task: Implement service class**
    - **Description**: Create `src/core/service.ts` with `start()`, `stop()`, and a tick loop. `start()` logs `service.ready` and begins ticking. `stop()` waits for current tick, logs shutdown events, and exits. The tick loop is a no-op for now — future features register tick handlers.
    - **Acceptance criteria**:
      - [ ] `start()` logs `service.ready`
      - [ ] `stop()` logs `service.stopping` then `service.stopped`
      - [ ] `stop()` waits for current tick to complete
      - [ ] Double `stop()` does not crash
      - [ ] `stop()` before `start()` does not crash
      - [ ] Tests: all service lifecycle cases from testing plan
    - **Dependencies**: "Set up pino structured logging"
  - [ ] **Task: Implement signal handlers**
    - **Description**: In `src/index.ts`, register `SIGINT` and `SIGTERM` handlers that call `service.stop()`. Handle double-signal gracefully.
    - **Acceptance criteria**:
      - [ ] SIGINT triggers clean shutdown
      - [ ] SIGTERM triggers clean shutdown
      - [ ] Double SIGINT does not crash
      - [ ] Tests: signal handling produces correct log sequence
    - **Dependencies**: "Implement service class"

- [ ] **Story: CLI entry point**
  - [ ] **Task: Implement CLI argument parsing**
    - **Description**: Create `src/index.ts` as the entry point. Parse `--repo` and `--help` flags. Validate repo path exists and is a directory. Resolve relative paths to absolute.
    - **Acceptance criteria**:
      - [ ] `--repo` with valid directory → proceeds to config loading
      - [ ] `--repo` with nonexistent path → error, exit 1
      - [ ] `--repo` with file instead of directory → error, exit 1
      - [ ] `--repo` with relative path → resolved to absolute
      - [ ] No `--repo` → usage message, exit 1
      - [ ] `--help` → usage info, exit 0
      - [ ] Tests: all CLI cases from testing plan
    - **Dependencies**: "Implement service class", "Implement hot-reload logic", "Implement bootstrap logic"
  - [ ] **Task: Wire startup sequence**
    - **Description**: Connect all components in `src/index.ts`: parse args → bootstrap/load config → resolve env vars → validate → create service → register signals → start watcher → start service.
    - **Acceptance criteria**:
      - [ ] Full startup sequence completes and logs `service.ready`
      - [ ] Missing env vars → logs which, exits 1
      - [ ] Invalid WORKFLOW.md → logs parse error, exits 1
      - [ ] All startup log events emitted in correct order
      - [ ] Tests: integration tests from testing plan
    - **Dependencies**: "Implement CLI argument parsing"

- [ ] **Story: Cross-cutting verification**
  - [ ] **Task: Implement cross-cutting invariant tests**
    - **Description**: Write tests that verify the two cross-cutting invariants across all error paths: all stdout is valid JSON, and no log entry contains a resolved secret.
    - **Acceptance criteria**:
      - [ ] Every error path tested produces valid JSON output
      - [ ] Config with `$VAR` values never appears unredacted in any log
      - [ ] Tests: exercise startup errors, reload errors, shutdown, and normal operation
    - **Dependencies**: "Wire startup sequence"
