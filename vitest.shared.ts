/**
 * Shared vitest worker-pool limits, imported by every package's `vite.config.ts`.
 *
 * Why this exists: `nx test <project>` runs can be launched several at a time (by an
 * agent's background tasks, or `nx run-many`), and an uncapped vitest pool defaults to
 * roughly one worker per CPU core. On a high-core machine that multiplied into many
 * multi-GB workers running at once and OOM-killed the machine — which also masked real
 * build/lint failures by killing validation before it finished.
 *
 * Capping the fork pool and giving each worker a hard `--max-old-space-size` keeps total
 * memory bounded no matter how many runs run concurrently, and turns a runaway or leak
 * into a fast, localized per-worker failure that names the offending test instead of
 * taking the whole machine down.
 */
export const sharedTestPool = {
  pool: 'forks' as const,
  poolOptions: {
    forks: {
      maxForks: 2,
      minForks: 1,
      execArgv: ['--max-old-space-size=2048']
    }
  }
};
