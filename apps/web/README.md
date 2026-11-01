# @autocatalyst/web

The web client project. For now it holds only the browser end-to-end target; the
client application and its build arrive with #131.

## `nx e2e web`

```bash
pnpm nx e2e web
```

`nx e2e web` builds the control plane (`control-plane:build`), then runs a
preflight and the Playwright tests from `apps/web`:

- Each spec file provisions its own control plane in **fake mode** — the real
  production entrypoint (`apps/control-plane/dist`) on a free port, with a fresh
  temporary state directory, serving the fixture client at
  `apps/web/e2e/fixture-client` from its own origin. No model call is made and no
  network beyond `127.0.0.1` is used. Each server is stopped when its spec ends,
  including after a failing test.
- One test opens the served page in Chromium, sees it load from the control
  plane's own origin, and reads `/health` from that same origin (no proxy, no
  CORS).

The preflight unit test runs as a Playwright spec under this target (not
`vitest run`), because `apps/web` has no `test` target yet.

## One-time browser install

Playwright keeps its browsers outside `node_modules`, and `pnpm install` does not
download them. Install Chromium once per machine (and again after the Playwright
version changes):

```bash
pnpm exec playwright install chromium
```

If Chromium is missing, the target's preflight stops before any test runs:

```text
Chromium is not installed for Playwright. Run: pnpm exec playwright install chromium
```

The target exits non-zero, no browser window opens, and no test runs — a skipped
test would read as a pass, so the preflight fails loudly instead.

## CI does not run this

`.github/workflows/ci.yml` runs `build`, `lint`, `test` and `test:boundaries`.
It does **not** run `e2e`, and `e2e` is not part of `pnpm validate`. A browser
download and a spawned server are a maintainer's decision; if wanted, the
`Validate` job can run this target after
`pnpm exec playwright install --with-deps chromium`.
