---
date: 2026-06-07
status: accepted
superseded_by: null
---
# nx-tsc-esm-nodenext-warning

**Decision:** Accept the cosmetic Nx ESM warning; remove the no-op `"format": ["esm"]` from all `project.json` build targets.

**Rationale:**
- `@nx/js:tsc` executor ignores `format` in `project.json`; it always calls `determineModuleFormatFromTsConfig(options.tsConfig)` internally
- That function only recognizes `ES2015/ES2020/ES2022/ESNext` as ESM — `NodeNext` (ModuleKind 199) is not in that list, so it returns `'cjs'`
- With `type: "module"` in each `package.json` + `format: ['cjs']` from the executor, `updatePackageJson` emits: "Package type is set to 'module' but 'cjs' format is included. Going to use 'esm' format instead."
- Despite the warning, Nx immediately overrides to `['esm']` (line 44 of `update-package-json.js`) so output is correct ESM
- The `"module"` field added to dist `package.json` is also correct (points to the ESM entry)
- Builds succeed; TypeScript itself uses NodeNext which outputs proper `.js` ESM files

**Constraints:**
- Must keep `@nx/js:tsc` executor (not switch executors)
- Must keep `"module": "NodeNext"` in `tsconfig.base.json`
- Warning cannot be suppressed without patching Nx internals or removing `"type": "module"` from packages

**Rejected:**
- `"generatePackageJson": false` — would stop dist `package.json` generation entirely, breaking consumers
- Switching executor (e.g. `@nx/js:swc`) — explicitly excluded by constraints
- Changing `"module"` to `ESNext` in tsconfig — excluded by constraints; NodeNext is required for proper `.js` extension resolution
