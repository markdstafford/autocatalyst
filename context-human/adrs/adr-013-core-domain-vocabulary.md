---
created: 2026-06-04
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-013: Core domain vocabulary

## Status

Accepted

## Context

The domain core needs a small, stable set of names for the things a person's interaction with
Autocatalyst produces. These names appear in the persisted schema, on the
network API surface (where they become externally visible and bound by additive-only evolution,
ADR-006), and throughout the concept docs. A name chosen carelessly is expensive to change once
clients depend on it, so the vocabulary is worth deciding deliberately and once.

Four distinct things need names: the **communicative unit** a person or the system exchanges; the
**focused objective** an interaction is pursuing; the **execution** that carries an objective through
its lifecycle; and the **container** that aggregates an ongoing interaction. A fifth name covers the
software artifact being built, which recurs as the natural top of the cost and ownership rollups.

## Decision

**Adopt this canonical vocabulary for the domain core:**

- **`Conversation`** — the durable aggregation of an ongoing interaction. Like a chat thread, it is a
  passive container: it does not control what happens inside it. It owns the channel binding (where it
  is surfaced) and a channel-independent identity, and it holds one or more topics.
- **`Topic`** — a focused objective within a conversation ("ship feature X", "fix bug Y"). It is the
  unit a person switches between, and the durable home of an objective's message history and its run
  sequence.
- **`Message`** — a single communication within a topic, in either direction (person to service or
  service to person). Inbound messages carry a message intent.
- **`Run`** — one execution of a workflow serving a topic. It carries the step, the work product, and
  the cost of one attempt at the objective.
- **`Project`** — the software thing Autocatalyst builds, spanning many conversations. It is the top of
  the ownership and cost rollups; at the current scale it corresponds one-to-one with a repository.

The structural relationships among these (cardinalities, the main/side distinction, the active-run
invariant) are decided in ADR-014; this decision fixes only the names and what each denotes.

## Consequences

**Positive:**
- One vocabulary spans the store, the API surface, and the docs, so the wire vocabulary, the domain
  vocabulary, and the documentation vocabulary are the same, with no translation dialect between them.
- `Conversation`/`Topic`/`Run` separate "the interaction", "the objective", and "the
  execution", which lets each carry the state that actually belongs to it.
- `Conversation` is channel-agnostic, so the model is not tied to any one channel (a chat thread and an
  API session are both conversations).

**Negative:**
- These names are externally visible on the API and therefore bound by additive-only evolution
  (ADR-006); renaming one after clients depend on it is a breaking change.
- A four-level vocabulary (`Conversation`/`Topic`/`Run` plus `Message`) is more concepts to learn than
  a single flat "request" notion.

## Alternatives considered

### A two-level `Request`-to-`Run` vocabulary

Name the unit a person submits a `Request`, and the execution it spawns a `Run`, with no container or
objective layer between them.

**Pros:**
- Fewer concepts; immediately familiar.
- Maps directly onto a one-shot "submit work, get a run" interaction.

**Cons:**
- Conflates the container with the submission: a single ongoing interaction routinely pursues several
  objectives over time, which a single "request" cannot represent.
- Leaves no home for an objective that is served by more than one execution (a clarifying step followed
  by the real work), forcing that relationship into ad-hoc fields.

**Why not chosen:** the interaction is genuinely a multi-objective container, and a two-level vocabulary
has nowhere to put the objective; `Conversation`/`Topic`/`Run` gives each its own name.

### Chat-centric names (`Thread`, `Session`)

Name the container a `Thread` and/or the objective a `Session`.

**Pros:**
- `Thread` matches the chat surface where many interactions begin.

**Cons:**
- `Thread` is coupled to chat and reads poorly for an API-first client that has no chat thread.
- `Session` collides with the agent/LLM "session" used in the run lifecycle (ADR-015), inviting
  confusion in exactly the area where precision matters.

**Why not chosen:** `Conversation` is channel-neutral, and `Session` is already spoken for by the
execution model.

### `App` instead of `Project`

Name the top rollup `App`.

**Pros:**
- Matches the colloquial "build me an app" framing.

**Cons:**
- "App" is overloaded — it tends to mean Autocatalyst itself — and it is narrow, since the thing built
  may be a library, a service, or a tool rather than an app.

**Why not chosen:** `Project` is unambiguous against "the app" and broad enough to cover everything
Autocatalyst builds.
