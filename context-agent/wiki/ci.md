# Continuous integration

`.github/workflows/ci.yml` runs the `CI` workflow for pull requests targeting `main` and pushes to
`main`. Its single `Validate` job uses a fresh Ubuntu runner, Node.js 22, and the pnpm version from
`package.json` (`packageManager`). Node setup caches the pnpm store. Installation uses
`pnpm install --frozen-lockfile`, including the native `better-sqlite3` build allowed by
`pnpm.onlyBuiltDependencies`.

The job configures a git identity for temporary repository tests, then runs separate `Build`, `Lint`,
`Test`, and `Boundary checks` steps: `pnpm build`, `pnpm lint`, `pnpm test`, and
`pnpm test:boundaries`. Reproduce the complete gate locally with `pnpm validate` after installation.
The root validation script groups the Nx targets before running the same three boundary assertions.

Keep `vitest.shared.ts` limits intact: forks pool, at most two workers per project, and a 2048 MiB
heap per worker (PR #50). CI supplies no live-suite opt-ins or provider/GitHub credentials; live specs
skip by default. Checkout does not persist its read-only token in git configuration.

The workflow grants only `contents: read`, pins actions to full commit SHAs with tag comments, cancels
superseded runs on the same ref, and limits the job to 20 minutes. The maintainer configures the
`Validate` check as required on `main` after its first PR run; workflow changes do not edit branch
protection. Do not switch to `pull_request_target` or add live credentials.
