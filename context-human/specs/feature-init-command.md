---
created: 2026-04-19
last_updated: 2026-04-19
status: approved
issue: 40
specced_by: markdstafford
implemented_by: null
superseded_by: null
---
# Init command

## What

The `init` command adds initialization and configuration-validation logic to Autocatalyst. It runs automatically each time the service starts: if no config exists, the user is prompted to create one (default Y); if config is complete, a summary is printed to stdout; if required properties are missing, the user is prompted to provide them. Secrets and identifiers are stored in `.env`; other values are written inline to the config file.
## Why

Setting up Autocatalyst today requires manually creating and populating a config file, with no guidance on required fields or where values should be stored. The `init` command eliminates this by running automatically at every service start and checking that all required configuration is present. If anything is missing, it prompts the user interactively and writes values to the right place — secrets to `.env`, other values inline. When config is complete, it prints a summary so every startup has a clear signal that setup is correct.
## Personas

- **Enzo: Engineer** — sets up a new or existing repository to work with Autocatalyst, or helps onboard a teammate's repo
## Narratives

### First setup, no friction

Enzo wants to start using Autocatalyst on a new project. He runs `autocatalyst --repo .` from inside the repository. Init runs first and detects no `WORKFLOW.md`. It prompts: "No config found. Initialize this repository for Autocatalyst? \[Y/n\]". He confirms. Init then prompts for each required config value in turn — Slack channel, Notion database ID, AWS profile, and tokens. Values that look like identifiers or secrets are written to `.env` with a `${VAR_NAME}` reference in `WORKFLOW.md`; other values are written inline. When all values are collected, init prints a summary and the service starts.
### Config evolves — new required property

Autocatalyst ships an update that adds a new required config property, `notion.workspace_id`. Enzo updates the package and starts the service. Init runs as usual and detects that `notion.workspace_id` is defined in the schema but absent from his `WORKFLOW.md`. It prompts: "`notion.workspace_id` is required. Enter a value (or leave blank to set `AC_NOTION_WORKSPACE_ID` in `.env`):". Because the value looks like an identifier, init writes `AC_NOTION_WORKSPACE_ID=` to `.env` and `notion.workspace_id: ${AC_NOTION_WORKSPACE_ID}` to `WORKFLOW.md`. Config is now complete. Init prints a summary and the service starts.
### Routine startup

Enzo starts the service on a day when nothing has changed. Init runs, reads the config, finds all required properties populated, and prints a brief summary to stdout. The service proceeds. Enzo has a quick confirmation that everything is correct without opening any files.
## User stories

**First setup**
- Enzo can run `autocatalyst --repo ` on a directory with no config and be prompted to initialize (default Y) before the service starts
- Enzo can confirm the prompt and be guided through providing values for each required config property
- Enzo can run `autocatalyst init [--repo ]` to trigger the same init flow directly
- Enzo can run `autocatalyst --help` and see `init` documented as an available command
**Routine startup**
- Enzo can start the service and see a summary of the current configuration printed to stdout when all required properties are populated
- Enzo can trust that the service will not start with an incomplete or missing configuration
**Incomplete or evolving config**
- Enzo can start the service with a `WORKFLOW.md` missing one or more required properties and be prompted to provide them before the service starts
- Enzo can provide a value and have it written to `.env` if it looks like an identifier or secret, or inline to `WORKFLOW.md` otherwise
- Enzo can provide a value at the prompt for a newly required config property added in a package update
## Goals

- Init runs automatically on every service startup, before any other service initialization
- If no config exists, the user is prompted to create one (default Y) and guided through required values
- If config is complete, a summary is printed to stdout and the service proceeds
- If required properties are missing, the user is prompted to provide each value before the service starts
- Secrets and identifiers are written to `.env`; other values are written inline to the config file
- `autocatalyst init [--repo ]` triggers the same init flow outside of a service start
## Non-goals

- Connecting to or validating external services (Slack, Notion, AWS) during init
- Migrating or transforming an existing `WORKFLOW.md` to a new schema format
- Scaffolding agent-authority artifacts (`context-agent/`)
- Templating variants or team-specific defaults
## Design spec

*Not applicable — init is a CLI command with no UI.*
## Tech spec

### Overview

The `init` command runs on every service startup as a pre-flight configuration check. It reads the current configuration state, compares it against the required schema, and takes one of three actions: prompts to create config if none exists, prompts for missing values if config is incomplete, or prints a summary and proceeds if config is complete.
The command can also be invoked directly as `autocatalyst init [--repo ]`, which triggers the same flow outside of a service start.
### Init flow

1. Resolve `repoPath`; emit `init.started`
2. Check whether `WORKFLOW.md` exists at `repoPath`
	- If not: emit `init.config_not_found`; prompt "No config found. Initialize this repository for Autocatalyst? \[Y/n\]" (default Y)
		- If confirmed: create a minimal `WORKFLOW.md` skeleton; emit `init.config_created` and continue to step 3
		- If declined: emit `init.creation_declined`; print a manual setup instruction and exit
3. Load and parse `WORKFLOW.md`
4. Identify all required properties that are unpopulated (empty, missing, or containing a placeholder); emit `init.missing_detected`
5. If any required properties are missing:
	- For each missing property in order, prompt the user for a value
	- Apply the secret heuristic: if the property looks like an identifier or secret, write the value to `.env` and insert a `${ENV_VAR_NAME}` reference into `WORKFLOW.md`; otherwise write the value inline; emit `init.value_written`
6. Reload and verify all required properties are now set; emit `init.validation_passed`
7. Print a config summary to stdout
8. Emit `init.completed` and return (service startup continues, or `init` subcommand exits)
### Secret vs. inline heuristic

A value is treated as a secret or identifier (written to `.env`) if the config property name contains `token`, `key`, `secret`, `id`, or `password` (case-insensitive). All other values are written inline to `WORKFLOW.md`. The user can also opt in to `.env` storage at the prompt.
### CLI changes (`src/core/cli.ts`)

`parseArgs` is updated to detect a leading `init` positional argument as a subcommand. If present, remaining args are parsed for an optional `--repo ` (defaults to CWD if omitted). If no subcommand is present, the existing `--repo ` required behavior is preserved.
New field added to `ParsedArgs`:
```typescript
command: 'run' | 'init'
```
Defaults to `'run'`, preserving full backward compatibility.
`printUsage()` is updated to document both command forms.
### Init module (`src/core/init.ts`)

A new module exports the main init function:
```typescript
export async function runInit(repoPath: string): Promise
```
Key helpers within the module:
- `configExists(repoPath): boolean`
- `loadConfig(repoPath): Config | null`
- `findMissingRequired(config: Config): string[]` — uses schema from `src/core/config.ts`
- `promptForValue(propertyPath: string): Promise`
- `isSecret(propertyPath: string): boolean`
- `writeToEnv(key: string, value: string, repoPath: string): void`
- `writeInlineConfig(propertyPath: string, value: string, repoPath: string): void`
- `printConfigSummary(config: Config): void` — masks secret values
### Entry point wiring (`src/index.ts`)

```typescript
if (parsed.command === 'init') {
  await runInit(parsed.repoPath || process.cwd());
  process.exit(0);
} else {
  const repoPath = parsed.repoPath;
  await runInit(repoPath); // always runs before service startup
  // existing service startup path
}
```
### Log events

The init command emits structured pino log events consistent with the rest of the codebase:

Event
Fields

`init.started`
`repo_path`

`init.config_not_found`
`repo_path`

`init.creation_declined`
—

`init.config_created`
`path`

`init.missing_detected`
`properties: string[]`, `count: number`

`init.value_written`
`property`, \`destination: "env" \\

`init.validation_passed`
`property_count`

`init.completed`
`missing_count`, `written_count`

### Affected files

- `src/core/cli.ts` — subcommand routing, updated `ParsedArgs` interface, updated `printUsage`
- `src/core/init.ts` (new) — init flow, config validation, interactive prompting, `.env` and inline writes, summary output
- `src/index.ts` — route `init` subcommand; call `runInit` on every service startup before service initialization
## Testing plan

### Unit tests

**`isSecret`**** heuristic** (`tests/core/init.test.ts`)
Test each keyword variant in both directions:
- Property names containing `token`, `key`, `secret`, `id`, `password` (any casing) → return `true`
- Property names without those substrings (`channel_name`, `interval_ms`, `profile`, `workspace`) → return `false`
**`findMissingRequired`** (`tests/core/init.test.ts`)
- Returns the correct list of missing property paths for a variety of partial configs (one missing, several missing, all missing)
- Returns an empty list when all required properties are populated
- Treats empty strings, `null`, and recognizable placeholder values (e.g., ``, `TODO`) as unpopulated
**`parseArgs`**** subcommand detection** (`tests/core/cli.test.ts`)
- All cases from the subcommand detection acceptance criteria: `init` with and without `--repo`, `run` path with `--repo`, `--help` alone, `init --help`
- `parseArgs([])` throws with the expected error message
### Integration tests

Run against a temporary directory created per test. Stub interactive prompts using stdin injection or a mock `promptForValue`.
**No-config branch**
- Confirming the creation prompt: a parseable `WORKFLOW.md` skeleton is created, each required property is prompted, values are written to the correct destinations, and the reload passes schema validation
- Declining the creation prompt: no files are created, `runInit` resolves without error
**Complete-config branch**
- No writes are made to disk
- The config summary is printed to stdout
- `init.completed` is emitted with `missing_count: 0`
**Incomplete-config branch** (including the "new required property" scenario)
- Each missing property triggers a prompt
- Secret-heuristic properties are written to `.env` with a `${VAR_NAME}` reference in `WORKFLOW.md`
- Non-secret properties are written inline to `WORKFLOW.md`
- `init.missing_detected` is emitted with the correct `properties` list and `count`
- Config passes schema validation after all values are written
### Log event coverage

Verify that each event in the log events table is emitted under its expected conditions. Use a pino transport mock to capture events during integration tests.
## Task list

- [x] **Story: Subcommand routing in CLI**
	- [x] **Task: Add subcommand detection to ****`parseArgs`**
		- **Description**: Update `parseArgs` in `src/core/cli.ts` to detect a leading `init` positional argument. Add `command: 'run' | 'init'` to the `ParsedArgs` interface, defaulting to `'run'`. When `init` is present, parse remaining args for an optional `--repo ` (defaults to `''` if omitted); existing `--repo ` required behavior is preserved when no subcommand is present.
		- **Acceptance criteria**:
			- [x] `parseArgs(['init'])` → `{ command: 'init', repoPath: '', help: false }`
			- [x] `parseArgs(['init', '--repo', '/p'])` → `{ command: 'init', repoPath: '/p', help: false }`
			- [x] `parseArgs(['--repo', '/p'])` → `{ command: 'run', repoPath: '/p', help: false }` (backward compat)
			- [x] `parseArgs(['--help'])` → `{ command: 'run', repoPath: '', help: true }`
			- [x] `parseArgs(['init', '--help'])` → `{ command: 'init', repoPath: '', help: true }`
			- [x] `parseArgs([])` throws with missing `--repo` message
		- **Dependencies**: None
	- [x] **Task: Update ****`printUsage`**** to document both commands**
		- **Description**: Update `printUsage()` in `src/core/cli.ts` to show both invocation forms with one-line descriptions: `autocatalyst --repo ` (start the service) and `autocatalyst init [--repo ]` (initialize and validate configuration).
		- **Acceptance criteria**:
			- [x] Output contains both command forms with descriptions
			- [x] Any existing help output tests are updated to match
		- **Dependencies**: Task: Add subcommand detection to `parseArgs`
- [x] **Story: Init flow logic**
	- [x] **Task: Config existence check and skeleton creation**
		- **Description**: Implement the first branch of the init flow in `src/core/init.ts`. If no `WORKFLOW.md` exists, emit `init.config_not_found` and prompt the user (default Y). If confirmed, create a minimal skeleton `WORKFLOW.md` with the correct YAML structure and emit `init.config_created`. If declined, emit `init.creation_declined`, print a manual setup instruction, and return without creating any files.
		- **Acceptance criteria**:
			- [x] Running `runInit` on an empty directory emits `init.config_not_found` and prompts the user (default Y)
			- [x] Confirming creates a parseable `WORKFLOW.md` skeleton and emits `init.config_created`
			- [x] Declining creates no files and resolves cleanly
		- **Dependencies**: None
	- [x] **Task: Missing required property detection**
		- **Description**: Implement `findMissingRequired` in `src/core/init.ts`. Load and parse `WORKFLOW.md`, then use the schema from `src/core/config.ts` to identify required properties that are unpopulated (empty, null, missing, or a recognizable placeholder value). Emit `init.missing_detected` with the property list and count.
		- **Acceptance criteria**:
			- [x] Returns the correct list of missing property paths for a variety of partial configs
			- [x] Returns an empty list for a fully populated config
			- [x] Treats empty strings, `null`, and placeholder values (e.g., ``) as unpopulated
			- [x] Emits `init.missing_detected` with `properties` and `count` fields
		- **Dependencies**: Task: Config existence check and skeleton creation
	- [x] **Task: Interactive prompting and value storage**
		- **Description**: For each missing required property, prompt the user for a value using `promptForValue`. Apply `isSecret` to decide storage destination: write to `.env` and insert a `${VAR_NAME}` reference in `WORKFLOW.md`, or write inline. After all values are written, reload the config and verify it passes schema validation; emit `init.validation_passed`. Emit `init.value_written` after each write.
		- **Acceptance criteria**:
			- [x] Secret-heuristic properties: value written to `.env`, `${VAR_NAME}` reference inserted in `WORKFLOW.md`, `init.value_written` emitted with `destination: "env"`
			- [x] Non-secret properties: value written inline to `WORKFLOW.md`, `init.value_written` emitted with `destination: "inline"`
			- [x] Config passes schema validation after all values are written
			- [x] `init.validation_passed` emitted with `property_count` equal to total required properties
		- **Dependencies**: Task: Missing required property detection
	- [x] **Task: Config summary output**
		- **Description**: Implement `printConfigSummary` in `src/core/init.ts`. After all required properties are confirmed present, print a summary of all required config values to stdout. Mask values for properties where `isSecret` returns true.
		- **Acceptance criteria**:
			- [x] Summary is printed on every `runInit` call when config is complete
			- [x] Secret property values are masked (e.g., `***`)
			- [x] Summary includes all required config properties
		- **Dependencies**: Task: Missing required property detection
- [x] **Story: Entry point wiring**
	- [x] **Task: Wire init into run path and init subcommand**
		- **Description**: Update `src/index.ts` to call `runInit` on every service startup before any other initialization. Route `parsed.command === 'init'` to `runInit` and `process.exit(0)`. If init does not complete successfully (e.g., user declined), the service must not start.
		- **Acceptance criteria**:
			- [x] Init runs on every `autocatalyst --repo ` invocation before service initialization
			- [x] `autocatalyst init [--repo ]` triggers init and exits 0
			- [x] Service does not start if init exits without a complete config
			- [x] `autocatalyst init --help` prints usage and exits 0
		- **Dependencies**: Task: Add subcommand detection to `parseArgs`, Task: Config existence check and skeleton creation, Task: Interactive prompting and value storage, Task: Config summary output
- [x] **Story: Tests**
	- [x] **Task: Unit tests for ****`parseArgs`**** with subcommands**
		- **Description**: Add unit tests to `tests/core/cli.test.ts` (or equivalent) covering all new subcommand cases enumerated in the subcommand detection acceptance criteria.
		- **Acceptance criteria**:
			- [x] All cases from the subcommand detection acceptance criteria have corresponding passing tests
			- [x] Existing passing tests remain passing
		- **Dependencies**: Task: Add subcommand detection to `parseArgs`
	- [x] **Task: Unit tests for secret heuristic**
		- **Description**: Add unit tests for `isSecret` in `tests/core/init.test.ts` covering property names that should and should not trigger `.env` storage.
		- **Acceptance criteria**:
			- [x] `bot_token`, `api_key`, `database_id`, `password` → `true`
			- [x] `channel_name`, `interval_ms`, `profile` → `false`
			- [x] Keyword matching is case-insensitive (e.g., `BotToken` → `true`)
		- **Dependencies**: Task: Interactive prompting and value storage
	- [x] **Task: Integration tests for ****`runInit`**
		- **Description**: Add integration tests in `tests/core/init.test.ts` using a temporary directory per test. Stub interactive prompts via stdin injection or a mock `promptForValue`. Cover the three main branches: no config (creation + prompting flow), complete config (summary only, no writes), and incomplete config (prompting and value storage).
		- **Acceptance criteria**:
			- [x] No-config branch: creates skeleton, prompts for values, writes to correct locations (`.env` vs. inline)
			- [x] Complete-config branch: prints summary, makes no file writes, emits `init.completed` with `missing_count: 0`
			- [x] Incomplete-config branch: prompts for missing values, writes to `.env` or inline as appropriate
			- [x] Decline-to-create branch: no files created, resolves without error
			- [x] Each log event in the log events table is emitted under its expected conditions (verified via pino transport mock)
		- **Dependencies**: Task: Config existence check and skeleton creation, Task: Missing required property detection, Task: Interactive prompting and value storage, Task: Config summary output