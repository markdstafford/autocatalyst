# Session pricing wiring

- Adapters interpret attempt-local evidence before result validation. Codex's tracker takes
  only owned thread/turn observations from the pinned app-server; a fresh counter starts at zero and a resumed one
  anchors on the first owned update. If a pricing counter loses its baseline, later valid
  snapshots do not recover that interval. Claude deduplicates final-message requests and reconciles
  scoped terminal totals instead of adding them. Explicit SDK subagent lifecycle can establish
  a child link even when the assistant tool-use block was not observed. OpenAI Agents reads native terminal Responses
  events, not the SDK's zero-filled aggregate; direct adapters read native response usage.
- AgentProviderSession.getTokenUsage retains the evidence even if the metadata promise rejects.
  The execution terminal or PreTerminalRunnerFailure carries it into the unit of work. The
  recorder writes explicit unavailable usage when no evidence is usable and always stores null USD.
  Failed direct calls still have no durable session.
- Migration 0011 adds nullable usage_json and the partial expression index for model rate
  revisions. Never fill in legacy splits. The SQLite bootstrap repairs historical 0006 ordering
  only when the tenant column is genuinely missing and Drizzle would skip that entry.
- Configuration publication locks the SQLite writer before reading a slot head. Keep rate
  settings canonical through Zod before comparing schedules. Valid API mutations of a stored
  rate kind conflict regardless of the submitted PATCH kind.
- The run read authorizes first. The session repository reads ordered evidence and relevant
  tenant history in one transaction; the core pricing module uses bigint and adds separate
  amount-only overflow gaps. Browser Summary formats its API subtotal and counts normalized
  groups independently of price completeness.
- Codex's unmatched `last` does not qualify as a request-size hint. In worked fixture 4,
  using size 120 would select band 101, contrary to the example's band 0. Without separate
  evidence, capture leaves the hint absent and pricing returns 468000 with `lowest_feasible`.
  Fixture 5's separate matched request still yields a clamped `nearest_sample` estimate.
  Both cases run from the pinned wire fixture through SQLite and the HTTP read.
- Focused tests: session-pricing.spec.ts (contract and core), codex-app-server.spec.ts and
  codex-usage.spec.ts, claude-usage.spec.ts, configuration-record-repository.spec.ts,
  pr-lifecycle.run-observability.integration.spec.ts (Fastify inject + SDK), run-detail-summary.spec.tsx.
  This managed environment cannot bind loopback ports; use Fastify inject for fixture-only HTTP.
  If the long workspace path exceeds Nx's socket limit, run with `NX_DAEMON=false NX_ISOLATE_PLUGINS=false`
  and set `TMPDIR` to writable scratch. Per-package Vitest configs can run focused fixtures directly.
