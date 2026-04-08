# Testing standards

## Framework

Vitest. Fast, TypeScript-native, good watch mode, compatible with the Node.js ecosystem.

## Structure

```
tests/
  core/              ← mirrors src/core/
  adapters/
    slack/           ← mirrors src/adapters/slack/
    omc/             ← mirrors src/adapters/omc/
  fixtures/          ← shared test data
```

Test files: `<module>.test.ts`, placed in the `tests/` directory mirroring `src/`.

## Types of tests

- **Unit tests**: test core logic (orchestrator state transitions, reconciliation, retry strategy) in isolation. No I/O.
- **Integration tests**: test adapter implementations against real APIs (Slack, OMC). Use test credentials/sandboxes. Mark as `describe.skip` when credentials are unavailable.
- **Contract tests**: verify adapter implementations satisfy the adapter interface. Run against all adapters.

## Principles

- Every public function in `src/core/` has a test.
- Tests are deterministic. No sleep, no timing-dependent assertions.
- Tests must be runnable by agents: `npm test` runs the full suite, exit code 0 = pass.
- Test output must be interpretable by agents: Vitest's default reporter is sufficient.
- Mock external I/O at the adapter boundary, not deep inside the core.

## Running

```bash
npm test              # full suite
npm run test:watch    # watch mode
npm run test:core     # core only
npm run test:adapters # adapters only
```
