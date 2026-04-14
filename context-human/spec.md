---
created: 2026-04-14
last_updated: 2026-04-14
status: active
---

# Autocatalyst

Autocatalyst is a development automation platform that runs an AI-led loop from idea to working code. A person seeds an idea in Slack; the system turns it into a structured spec, presents it for human review, and — once approved — hands it to a coding agent that implements and verifies the feature. When implementation is complete, the human tests it and either iterates via a Notion feedback page or approves and triggers a PR. The human's role is three touchpoints: proposing ideas, approving specs, and testing completed features.

Autocatalyst is built for a small engineering team actively developing a software platform. It is not a general-purpose coding assistant; it is a purpose-built harness for a specific development loop with opinionated structure at every stage.

---

## Foundation

The foundation is the CLI entry point that starts the Autocatalyst service, loads configuration from the target repo's WORKFLOW.md, resolves environment variables, and emits structured JSON logs on every event. It provides the process lifecycle, configuration mechanism (load, validate, hot-reload), and logging infrastructure that all subsequent features build on.

**Spec:** `specs/feature-foundation.md`

---

## Slack message routing

Slack message routing connects Autocatalyst to a Slack workspace so that team members can interact with the system through a channel they already use. The feature listens to a designated channel, reads each incoming message, and routes it to the right part of the system: new ideas go to the spec pipeline, replies in idea threads are classified by AI intent (spec feedback, approval, implementation feedback, or ship signal), and anything else gets a conversational response. One channel maps to one repository; all discussion about an idea stays in one thread.

**Spec:** `specs/feature-slack-message-routing.md`

---

## Idea to spec to review

When a team member seeds an idea in Slack, Autocatalyst generates a structured spec — covering what the feature is, why it matters, who uses it, and what a working implementation looks like — then posts it to a Notion page and drops a link in the Slack thread. If someone pushes back or flags something missing, they reply in the thread and Autocatalyst revises the spec in place. The loop continues until the team is satisfied.

**Spec:** `specs/feature-idea-to-spec.md`

---

## Notion publisher

When a spec is generated, it is published to a Notion page rather than posted inline in Slack. Team members leave feedback as Notion page comments, Autocatalyst replies in the comment thread, and revised specs are updated on the page in place. The Slack thread carries only the link and status updates — the Notion page is the working document.

**Spec:** `specs/enhancement-notion-publisher.md`

---

## Run persistence

Run state is written to disk on every change and reloaded on startup, so in-progress runs survive server restarts without human intervention. Specs waiting for approval keep waiting, feedback cycles resume, and interrupted runs receive a notification when the server comes back up. Normal operation is unchanged — a running server behaves identically whether or not a restart has occurred.

**Spec:** `specs/feature-run-persistence.md`

---

## Approval to implementation

When a team member approves a spec in Slack, Autocatalyst commits the spec to the repo and hands it to the Agent SDK, which implements the feature in the existing workspace. When the agent finishes, Autocatalyst creates an implementation feedback page in Notion — with a summary, testing instructions, and a feedback to-do list — and posts a link in the Slack thread. The human tests the implementation, adds feedback to the Notion page if needed, and triggers a PR when it's ready. Everything between approval and testing is the system's job.

**Spec:** `specs/feature-approval-to-implementation.md`

---
