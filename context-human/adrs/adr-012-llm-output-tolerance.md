---
created: 2026-06-03
last_updated: 2026-06-06
status: accepted
decided_by: markdstafford
superseded_by: null
---

# ADR-012: LLM output tolerance

## Status

Accepted

## Context

The system depends on outputs an agent produces: **structured results** it consumes to advance a
run (a result with a defined shape) and **progress/intent signals** that drive the UX. Language
models are unpredictable. An agent may write a slightly-wrong filename, return a URL where an
identifier is expected, emit malformed JSON, or omit an optional signal entirely. We must decide
how the system handles output that does not conform to what it expects, so that trivial,
mechanically-fixable deviations neither waste whole runs nor silently corrupt downstream logic.

## Decision

**Treat LLM output as a soft contract, handled by a tolerance pipeline that repairs what it can
deterministically, corrects what it must via the model, degrades gracefully for what is
optional, and never silently guesses.**

The pipeline, in order:

1. **Deterministic normalization/coercion.** An extensible set of safe, *unambiguous* repairs
   runs before validation, for example mapping a known filename alias to the canonical name, or
   extracting an identifier from a URL. New repairs are added as confident, unambiguous patterns
   are observed, saving model round-trips over time.
2. **Schema validation** against the declared contract (the shared schemas of ADR-007).
3. **A bounded correction loop.** Only if the output still does not conform, the agent is asked
   to fix it *before* the run proceeds on it.
4. **Graceful degradation** for missing *optional* signals. An absent progress/intent signal
   reduces UX richness but never breaks the run.

**The hard rule:** a coercion may only be applied when it is deterministic and unambiguous. Any
ambiguity falls through to the correction loop, and the system never silently guesses at intent.
This applies both to result contracts and to the structured progress/intent vocabulary.

## Consequences

**Positive:**
- Trivial, mechanically-fixable deviations are handled cheaply, without a model round-trip or a
  failed run.
- Genuinely nonconforming output is caught and corrected before it reaches downstream logic.
- The repair set is extensible, so the system gets more tolerant (and cheaper) as patterns are
  learned.
- Optional UX signals can be imperfect without endangering the run.

**Negative:**
- The normalization layer is logic to maintain, and a careless coercion could mask a real
  problem (mitigated by the unambiguity rule).
- The correction loop adds latency and cost when it is needed.
- "Soft contract" must not be read as "no contract". The schema validation and the unambiguity
  rule are what keep tolerance from becoming sloppiness.

## Alternatives considered

### Strict validation with hard failure

Validate output against the contract and fail the run on any nonconformance.

**Pros:**
- Simple and unambiguous.
- Forces conforming output.
- No repair logic to maintain.

**Cons:**
- Brittle: wastes an entire run on a trivial, mechanically-fixable deviation (a misspelled
  filename, a URL instead of an id).
- A poor experience for an inherently probabilistic producer.
- Pushes avoidable failures onto the human.

**Why not chosen:** Too costly for the class of deviations that deterministic normalization
resolves for free; strictness belongs after the cheap repairs, not instead of them.

### Always ask the model to fix nonconforming output

Skip deterministic repair; whenever output does not conform, send it back to the model to correct.

**Pros:**
- Handles arbitrary deviations with no repair code to maintain.
- Conceptually uniform: one mechanism for all nonconformance.

**Cons:**
- Spends a model round-trip (latency and cost) on deviations a line of deterministic code would
  fix.
- Ignores cheap, certain wins.
- Slower feedback for the human on common, predictable mistakes.

**Why not chosen:** Deterministic normalization should handle the known, unambiguous cases first;
the correction loop is the fallback for genuine nonconformance, not the first resort.

### Trust output without validation

Consume agent output directly. Not a genuine alternative: unvalidated output flows malformed into
downstream logic, the failure this decision exists to prevent.

### Parse intent out of free-text assistant messages

Recover structured signals by scraping the agent's prose. Not a genuine alternative: it is
brittle and unstructured. Signals belong in a typed channel the agent emits, with this tolerance
pipeline applied, rather than scraped from natural-language text.
