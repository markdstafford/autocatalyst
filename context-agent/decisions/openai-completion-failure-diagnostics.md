---
date: 2026-10-23
status: accepted
superseded_by: null
---
# OpenAI completion failure diagnostics
**Decision:** Record fixed completion stages and allowlisted SDK/runtime error classes and cause codes while preserving existing terminal-failure behavior.
**Rationale:**
- Valid assistant JSON can be visible before SDK completion, continuity persistence, or result writing fails.
- The old generic wrapper discarded distinctions between these boundaries and mislabeled final-output capture as SDK structured output.
- Mocked-HTTP and injected-fault tests distinguish these failures without consuming inference or leaking private content.
**Constraints:** Never log raw messages, stacks, model state, content, arbitrary class/code strings, or credentials. Keep model-session retries disabled and do not convert a persistence failure into success.
**Rejected:** Guessing the historical exception from its generic public reason; accepting any emitted JSON as success; bypassing continuity persistence; another paid run solely to test logging.
