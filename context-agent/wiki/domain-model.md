# Domain model

Core concepts in the Autocatalyst system.

## Channel

Configured communication binding between a provider surface and a repository.

**Refs:** `ChannelRef { provider, id, name? }`, `ConversationRef { provider, channel_id, conversation_id }`, `MessageRef { provider, channel_id, conversation_id, message_id }`

## Request

The seed input from a human. A short description of what to build, fix, file, or answer. Arrives through a `ChannelAdapter`.

**Fields:** `id`, `content`, `author`, `received_at`, `channel`, `conversation`, `origin`

## Intent

The classified meaning of a request or follow-up message.

**Values:** `idea`, `bug`, `chore`, `file_issues`, `feedback`, `approval`, `question`, `ignore`

## Command

An explicit instruction keyed by adapter syntax instead of natural-language classification. Commands are registered through `CommandRegistry`.

## Artifact

A generated artifact that goes through human review. Feature specs, bug triage, and chore plans are one model with different lifecycle policies.

**Kinds:** `feature_spec`, `bug_triage`, `chore_plan`

**Fields:** `kind`, `local_path`, `published_ref`, `status`, `linked_issue`

## Artifact Lifecycle Policy

Declarative behavior applied when an artifact is approved.

**Fields:** `commit_on_approval`, `sync_issue_on_approval`, `implementation_required`

**Defaults:**
- `feature_spec` commits on approval, does not sync an issue, then implements.
- `bug_triage` syncs or creates an issue, does not commit the artifact, then implements.
- `chore_plan` syncs or creates an issue, does not commit the artifact, then implements.

## Run

One request-to-outcome execution. The orchestrator is the single authority for run scheduling, persistence, deduplication, and stage transitions.

**Fields:** `id`, `request_id`, `intent`, `stage`, `workspace_path`, `branch`, `artifact`, `issue`, `attempt`, `channel`, `conversation`, `origin`, `pr_url`, `last_impl_result`

## Stage

Where a run is in the loop. Stages are sequential except terminal failure.

**Values:**
- `intake` — request received
- `speccing` — artifact being generated or revised
- `reviewing_spec` — artifact awaiting feedback or approval
- `implementing` — agent runtime is changing the workspace
- `awaiting_impl_input` — implementation needs human input
- `reviewing_implementation` — implementation is ready for human review
- `pr_open` — pull request is open and awaiting merge approval
- `done` — terminal success
- `failed` — terminal failure

## Handler

Route-specific pipeline behavior registered by event type, stage, and intent. Handlers receive narrow ports and do not own scheduling.

## AI Runner

Provider-neutral AI execution ports.

**DirectModelRunner:** Direct model calls for bounded text-in/text-out tasks such as intent classification.

**AgentRunner:** Tool-using agent sessions for artifact authoring, implementation, issue triage, and repo-aware question answering. The working directory may be a per-run cloned workspace or the base repo, depending on the task.

**Plugin policy:** Runtime routes do not load Claude user settings. Claude Agent SDK routes that require slash-command plugins receive explicit local plugin configs from the Anthropic adapter: `mm` for artifact authoring and issue triage, `superpowers` for implementation. Question answering runs without plugins or filesystem settings.

## Workspace

Filesystem directory used by handlers that need repo state. Artifact creation, implementation, and issue filing use per-run workspaces. Question answering uses the configured repo path and does not create a cloned run workspace.

**Fields:** `path`, `run_id`, `repo_url`, `created_at`, `status`
