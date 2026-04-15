---
created: 2026-04-14
last_updated: 2026-04-14
status: draft
issue: null
specced_by: markdstafford
implemented_by: null
superseded_by: null
---

# Enhancement: Intent classifier routing

## Parent feature

`feature-slack-message-routing.md`

## What

The slack message routing feature currently classifies messages with a fixed ruleset: new top-level @mentions are always treated as feature ideas, and thread replies are always treated as spec feedback. This enhancement replaces that hardcoded routing with AI-powered intent classification on every inbound message — both top-level and in-thread — so the system can understand what a user is actually asking for and route it accordingly.

## Why

Every inbound message is a request for something — a new feature, a bug fix, a question, a piece of feedback — and the system needs to know which in order to respond correctly. The current fixed ruleset can only distinguish message position (new thread vs. reply), not intent, so it cannot route messages to the right handler or compose the right response. Classifying every message by intent gives the system what it needs to address each request appropriately.

## User stories

- Phoebe can @mention the bot with a bug report and have it routed as a bug, not a feature idea
- Phoebe can ask the bot a direct question and get a response appropriate to a question
- Phoebe can @mention the bot with a feature idea and have it routed as before
- Enzo can reply to an in-progress thread with approval and have the system recognize it as such
- Enzo can ask a question in an active thread and have it handled as a question rather than spec feedback
- Enzo can provide feedback on a spec or implementation in a thread and have it routed correctly
- Enzo can post in a channel without @mentioning the bot and have the bot ignore it entirely
- Enzo can @mention another person in a thread without triggering a bot response
- Phoebe can @mention both the bot and another person in a thread and have the bot respond normally

## Design changes

*(Added by design specs stage — frame as delta on the parent feature's design spec)*

## Technical changes

### Affected files

*(Populated during tech specs stage — list files that will change and why)*

### Changes

### 1. Introduction and overview

**Prerequisites and assumptions**
- Depends on `feature-slack-message-routing.md` (complete) — the existing Slack `classifier.ts`, `ThreadRegistry`, `SlackAdapter`, and `InboundEvent` types
- Depends on `adr-001-agent-first-development.md` — AI-first processing approach
- Depends on PR #31 (merged) — `IntentClassifier` at `src/adapters/agent/intent-classifier.ts`, `thread_message` event type, and current orchestrator routing using stage-specific intents (`spec_feedback`, `spec_approval`, `implementation_feedback`, `implementation_approval`)
- No new ADRs required; no database or API changes
- The orchestrator handles routing by `InboundEvent.type` and run stage — replacing intent types here requires corresponding updates there

**Technical goals**
- Every inbound @mention — top-level or in-thread — is classified by a single `IntentClassifier` using a unified taxonomy before reaching the orchestrator
- In-thread messages where someone other than the bot is @mentioned (and the bot is not) are ignored without classification
- Classification completes within 2 seconds of message receipt
- The classifier never produces an unhandled intent type at the orchestrator boundary
- Terminology is consistent: `Idea` / `idea_id` / `new_idea` replaced with `Request` / `request_id` / `idea` throughout

**Non-goals**
- Implementing the downstream handler for `bug` intent (tracked in #42)
- Emoji reaction approval
- Persisting classification history
- Multi-turn conversation or context tracking within a thread

**In scope**
- Top-level intents: `idea`, `bug` (classifier only, no handler), `question`, `ignore`
- In-thread intents: `feedback`, `approval`, `question`, `ignore`
- Refactor `IntentClassifier` to use the unified taxonomy, replacing stage-specific intents (`spec_feedback`, `spec_approval`, `implementation_feedback`, `implementation_approval`); orchestrator derives context from intent + run stage
- Update Slack `classifier.ts` to route all @mentions through `IntentClassifier` and apply correct ignore rules
- Update orchestrator to handle unified intents
- Rename `Idea` → `Request` throughout types, events, orchestrator, and registry

**Glossary**
- **Top-level intent** — the intent of a new @mention that starts a thread: `idea`, `bug`, `question`, `ignore`
- **In-thread intent** — the intent of a reply in a tracked thread: `feedback`, `approval`, `question`, `ignore`
- **Request** — the generic term for any incoming work item, replacing `Idea` in the codebase

## Task list

*(Added by task decomposition stage)*
