# Stage: Bug triage

You are triaging a bug — producing an issue with a root cause analysis and a task list. This is an **abbreviated** workflow: no requirements, no design spec, no full tech spec.

## When to use this stage

- A bug has been reported by a user or observed in feedback.
- A regression has been detected.
- Unexpected behavior was discovered during other work.

**Do not use this stage for:**

- Feature work — use `product-requirements.md`.
- Behavior changes that are not bugs — use `enhancements.md`.
- Pure chores (dependency bumps, cleanups) — handle as a chore with description + tasks.

## Role

You are the **software engineer** plus **reviewer** (see `references/roles.md`). The human is your collaborator in reproducing and understanding the bug.

## Prerequisites

1. The bug has been observed concretely (a report, a log, a screenshot, a failing test). If only suspected, the first step is to reproduce.
2. The issue tracker integration (`issue_tracker` from config) is known. If not configured, produce the artifact as a markdown file and let the human file it manually.

## Artifact

The bug triage produces an **issue** in the configured issue tracker (or a local file at `{docs_root}/specs/backlog/bug-<slug>.md` if no tracker is configured). The structure of the issue is described below.

## Sections, in order

Per-section checkpoints by default. Batch mode if `waitForApprovalBefore` includes `bug_triage`, `root_cause`, or `bug_tasks`.

### 1. Summary

One sentence: what is broken, and what the user-visible symptom is.

### 2. Reproduction

- **Environment.** Where it was observed (browser, OS, version, environment).
- **Preconditions.** State needed before reproduction.
- **Steps.** Numbered steps to reproduce.
- **Expected behavior.**
- **Actual behavior.**

If you cannot reproduce, say so. Propose how to reproduce (logs to inspect, conditions to recreate). Do not invent steps.

### 3. Evidence

- Logs, error messages, stack traces.
- Screenshots or recordings (link or attach).
- Affected users, frequency, recency.

### 4. Root cause analysis

Investigate before declaring root cause. Trace the symptom back through the code, data, and configuration to the actual defect.

- **Hypotheses considered.** List the candidate causes you investigated and ruled out, with one-line reasons.
- **Root cause.** The actual defect, stated precisely. Cite file paths, function names, or data conditions where applicable.
- **Why it was not caught.** What gap in testing, validation, or review let this through.

**Do not stop at the first plausible cause.** A symptom can have several layers. Ask: "If I fix this, would the original symptom go away? Could it still happen another way?"

### 5. Scope and impact

- **Who is affected.**
- **How severely.**
- **Are there workarounds.**
- **Related areas at risk** of similar defects.

### 6. Fix approach

A short description of how to fix it. Not a full tech spec, but enough that the fix is clear and bounded. Identify:

- The minimal change that fixes the root cause.
- Any required test coverage to prevent regression.
- Whether the fix has migration, rollout, or backward-compatibility implications.

### 7. Task list

Use the **full hierarchical task decomposition format** (see `task-decomposition.md`). Even for a one-line fix, every leaf task must have a description, acceptance criteria, and dependencies. Acceptance criteria almost always include "a regression test exists and fails without the fix."

For a tiny bug, this may be one story with one or two leaf tasks. That is fine — the format is still required.

### 8. Reviewer pass

Switch to **reviewer**. Read the issue. Check:

- Are reproduction steps actually reproducible by someone else?
- Is the root cause supported by the evidence, or assumed?
- Does the fix address the root cause, not just the symptom?
- Does the task list include regression test coverage?

Revise and finalize.

### 9. Filing the issue

Once approved:

- File the issue in the configured issue tracker, or write the markdown file to `{docs_root}/specs/backlog/bug-<slug>.md` if no tracker is configured.
- Confirm to the human where the issue was filed.

## Completion

After the issue is filed and the task list is approved, **stop and return control to Autocatalyst.** Autocatalyst owns everything after triage.
