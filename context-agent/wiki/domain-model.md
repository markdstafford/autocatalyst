# Domain model

Core concepts in the Autocatalyst system.

## Idea

The seed input from a human. A short description of what to build or change. Arrives through the human interface adapter.

**Fields:** `id`, `source` (which adapter), `content` (raw text), `author`, `received_at`, `thread_ts` (Slack thread identifier for posting replies), `channel_id`

## Spec

Structured description of what to build, generated from an idea. Follows the micromanager convention: Markdown with YAML frontmatter. Iterated through human feedback until approved.

**Fields:** `id`, `idea_id`, `content` (Markdown), `status` (draft, in_review, approved, superseded), `version`, `open_questions`, `created_at`, `updated_at`

## Run

An idea-to-implementation execution. Tracks one pass through the loop. A single idea may produce multiple runs (if implementation is scrapped and restarted).

**Fields:** `id`, `idea_id`, `spec_id`, `stage`, `workspace_path`, `attempt` (1-indexed), `started_at`, `terminal_reason`, `completed_at`

## Stage

Where a run is in the loop. Stages are sequential; a run moves forward or terminates.

**Values:**
- `intake` — idea received, queued for spec generation
- `speccing` — spec being generated from the idea
- `review` — spec posted to human interface, awaiting feedback
- `approved` — human approved the spec, ready for implementation
- `implementing` — agent runtime is building the feature
- `testing` — implementation complete, surfaced for human testing
- `done` — human confirmed the feature works; terminal state
- `failed` — run failed and will not retry; terminal state
- `scrapped` — implementation rejected, spec needs revision; triggers a new run

## Workspace

Isolated filesystem directory for a single run. Contains a shallow clone of the target repo. The agent runtime operates exclusively within this directory.

**Fields:** `path`, `run_id`, `repo_url`, `created_at`, `status` (active, cleaned)

## Approval

Human signal that a spec is ready for implementation. Captured through the human interface adapter.

**Fields:** `run_id`, `spec_version`, `approver`, `signal_type` (reaction, reply, command), `received_at`
