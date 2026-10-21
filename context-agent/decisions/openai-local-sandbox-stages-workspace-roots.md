---
date: 2026-10-21
status: accepted
superseded_by: null
doc_id: 765a4d40-f74b-49fd-be8a-9b944d3ac049
---
# openai local sandbox stages workspace roots

**Decision:** The OpenAI agent adapter stages declared workspace roots into a temporary symlink-free copy before passing them to `UnixLocalSandboxClient.create()`.

**Rationale:**
- The OpenAI SDK's `localDir({ src })` materializer rejects symbolic links. pnpm workspaces routinely contain ignored `node_modules` symlinks after agents run dependency commands.
- Autocatalyst v0 avoided this path by using `UnixLocalSandboxClient.resume()` with `workspaceRootPath` pointed directly at the single working directory.
- The cp3 execution contract exposes separate logical roots (`/workspace/repo` and `/workspace/scratch`), so a direct v0-style single-root attach would flatten or alter expected paths.
- A filtered staging copy preserves the cp3 logical layout while avoiding dependency/cache trees that should not be sandbox materialization input.

**Constraints:**
- The adapter must not mutate or delete files from the real run workspace.
- Reviewer sessions still rely on read-only path grants plus `NoopSnapshotSpec`; sandbox writes must not sync back to the host workspace.
- Staging skips `node_modules` directories and symlinks. Source files and scratch files remain available in the sandbox copy.
- A linked worktree's `.git` file must never be copied unchanged: it points to mutable host metadata. Stage an independent local clone with `--no-hardlinks --no-checkout`, populate its index with `reset --mixed HEAD`, then overlay source files while excluding the `.git` pointer. This preserves source modifications without host ref/object writes.
- Remove staging directories on session close, materialization failure, and session-setup failure. No snapshot or write-back occurs. Structured result capture is a separate explicit handoff.

**Rejected:**
- Directly deleting `node_modules` from the run workspace — destructive and would break inspection/debugging.
- Reusing v0's `resume()` shape unchanged — it does not preserve cp3's two-root `/workspace/repo` and `/workspace/scratch` contract.
- Dereferencing pnpm symlinks — copies dependency trees into the sandbox, making startup slow and fragile.
