# Coding standards

## Language

TypeScript with strict mode enabled. Target Node.js LTS (22+).

## Module structure

```
src/
  core/              ← orchestrator, state, reconciliation, loop logic
  adapters/
    slack/           ← Slack human interface adapter
    omc/             ← OMC agent runtime adapter
  types/             ← shared type definitions
  config/            ← configuration loading, WORKFLOW.md parsing
  index.ts           ← CLI entry point
```

- One concern per module. No file should mix orchestration logic with adapter logic.
- All adapter implementations go in `src/adapters/<name>/`.
- Shared types go in `src/types/`. Do not define types inline in adapter code if they cross module boundaries.

## Naming

- Files: `kebab-case.ts`
- Types/interfaces: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Adapter directories: lowercase, match the platform name (`slack`, `omc`)

## Interfaces

- Every adapter defines its interface in a `.ts` file at the adapter root (`src/adapters/human-interface.ts`, `src/adapters/agent-runtime.ts`)
- Implementations import and satisfy the interface
- The orchestrator depends only on the interface, never on a specific adapter

## Error handling

- Define explicit error types. No `throw new Error("something broke")`.
- All errors include: `code` (stable string identifier), `message` (human-readable), `context` (relevant IDs and state).
- Catch at boundaries (adapter entry, orchestrator tick). Let errors propagate through the core.

## Dependencies

- Prefer standard library and well-maintained packages with TypeScript types.
- No dependency without a clear reason. Every `npm install` should be justified by the decision it supports.
- Pin exact versions in `package.json` (no `^` or `~`).

## Comments

- No comments explaining *what* code does — the code does that.
- Comments explain *why* a non-obvious choice was made.
- JSDoc on all exported functions: one-line description, `@param`, `@returns`.
