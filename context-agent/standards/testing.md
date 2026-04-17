# Testing standards

## Framework

Vitest. Fast, TypeScript-native, good watch mode, compatible with the Node.js ecosystem.

## TDD process

Tests are written before implementation. Every feature follows this cycle:

1. **Derive test cases from spec.** Map acceptance criteria to test cases. Each criterion becomes at least one test. Tests describe behavior, not implementation.
2. **Write the test.** The test calls the function/module that doesn't exist yet. Use the public interface — no reaching into internals.
3. **Run it. Confirm it fails.** This is the quality gate. If the test passes before implementation, the test is wrong — delete it and rewrite. A test that cannot fail cannot catch a bug.
4. **Implement until it passes.** Write the minimal code to make the test pass. No speculative code.
5. **Refactor.** Clean up with the passing test as the safety net. Run the test again after refactoring.

Do not skip step 3. The red step is what distinguishes a test that verifies behavior from a test that mirrors implementation.

## Test quality verification

After a module is complete:
- Review each test: does it test a behavior (what the code does) or a mechanism (how the code does it)? Tests coupled to implementation details break on refactor and provide false confidence.
- Check coverage of edge cases: what happens on empty input, on error, on retry, on timeout?
- If a test mocks more than one layer deep, it is testing the mock, not the code. Refactor the test or the code.

## Structure

```
tests/
  core/              ← mirrors src/core/
  adapters/
    slack/           ← mirrors src/adapters/slack/
    agent/           ← mirrors src/adapters/agent/
  fixtures/          ← shared test data
```

Test files: `<module>.test.ts`, placed in the `tests/` directory mirroring `src/`.

## Types of tests

- **Unit tests**: test core logic (orchestrator state transitions, reconciliation, retry strategy) in isolation. No I/O.
- **Integration tests**: test adapter implementations against real APIs (Slack, Agent SDK). Use test credentials/sandboxes. Mark as `describe.skip` when credentials are unavailable.
- **Contract tests**: verify adapter implementations satisfy the adapter interface. Run against all adapters.

## Principles

- Every public function in `src/core/` has a test written before the function is implemented.
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
