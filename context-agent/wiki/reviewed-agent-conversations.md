# Reviewed agent conversations

## Boundaries
- Only reviewed convergence supplies an occurrence and workflow to the continuity port. Router-selected profile and effective workspace policy are host inputs. A fresh dispatch without retention invalidates a prior exact-key slot; a different role or producing step cannot. The PR binding is separate from the scope digest.
- Slot admission requires both SQLite workspace generation and a host proof of the run directory, repo and scratch instances, linked worktree, and (in server composition) owning Git repository. A same-path replacement or explicit start-over fences prior completions. Do not infer handles from checkpoints, tool output, Sessions, or scratch.
- The runner hands native IDs back privately. Publish a handle only after current completion, result acceptance, attempt recording, and ownership recheck. Slot publication failure does not replace an otherwise accepted result.
- Scope custody is separate from workspace enrollment. The marker is host data outside the declared roots. Reclamation must not use PID absence as exit evidence. The existing guarded pruner leaves unknown writers untouched, including orphaned pre-handle scopes. Do not point `CODEX_HOME` or Claude config at a scope and call that confinement.
- Production reviewed dispatch and `pr.finalize` share the fresh-session resolver. For either built-in Claude auth path, match the SDK version, CLI version, OS, architecture and auth path against the independent release list before setting `persistSession: false`.
- `pr.finalize` never takes a slot or a handoff. Read the integrated commit copy and pinned diff under an attempt-specific scratch directory. Symlinks and gitlinks are described rather than followed. A result from a previous occurrence does not establish an attestation or a valid freeze.

## Qualification status — not ready to merge

| Runtime/configuration | Evidence | Release status |
| --- | --- | --- |
| Codex App Server 0.171.0, enterprise and business account modes | Executable protocol fixtures verify persisted start, resume, and historical-event exclusion. A no-inference probe of the actual 0.171.0 binary in an empty isolated home verified `thread/resume` returns JSON-RPC `-32600` and the exact requested missing-rollout message. No live turn or recall was verified. | Fresh-only; no entry |
| Claude Agent SDK 0.3.177 bundled launch; subscription host CLI 2.1.328 | SDK-option fixtures verify explicit persistence, resume, root matching, replay exclusion, and the verified-fresh flag. An opt-in native no-write fixture is available but has not run against either launch path. Live resume and exact custody are also unverified. | Shipped fresh options for unverified launches; no entry |
| Host transcript custody | Local marker/pruner fixtures verify guarded removal after positive writer/group evidence. This control-plane host composition does not have verified private process confinement and restart-stable writer/descendant evidence for either runtime. | No production retention admission |

The managed build sandbox denies loopback listeners (`EPERM`), and the round 2 network probe could not resolve `api.anthropic.com`. Do not infer the Claude non-persistence override from the SDK method signature, substitute the scripted launch for native inference, or enable a retained build without the exact host qualification. The unverified ordinary Claude path executes with shipped options and never imports or saves a reusable handle. Arm B blocks for unverified non-persistence.

The local macOS arm64 build resolved SDK 0.3.177 with subscription CLI 2.1.328 and bundled CLI 2.1.177. The disposable fixture home had no first-party subscription login in either namespace, and the local server had no Anthropic API key. The disposable fixture did not run a model turn. A separate tool-free smoke test through the real SDK and the existing subscription completed with the fresh no-history flag and left no transcript in its temporary workspace’s project history. The same login was unavailable with a new Claude config directory. This smoke test covers one default-config launch. The isolated positive controls, scoped launch, and retained resume qualification remain pending. Production still has no verified custody launcher, so the retained comparison arm remains blocked and both release lists remain empty.

## Run the isolated Claude native fixture

Run once with `AUTOCATALYST_LIVE_CLAUDE_NON_PERSISTENCE=api_key` and once with `subscription` on an authorized host. Use a disposable test account or VM and a clean home for each mode. Set `AUTOCATALYST_CLAUDE_FIXTURE_HOME` to that process's `HOME` and `AUTOCATALYST_CLAUDE_FIXTURE_MODEL` to a model the test account can use. Start with `CLAUDE_CONFIG_DIR` unset, no alternate provider settings or user tools/hooks, and empty project histories in both config directories.

- API key: supply `ANTHROPIC_API_KEY` through the test host's secret mechanism. Uses the lockfile-resolved SDK and its bundled CLI.
- Subscription: put the host `claude` CLI on `PATH`. Sign in normally with the authorized test account for both the default config and `$HOME/.autocatalyst-claude-fixture-scope`. Do not copy credentials or transcripts from a working account.
- Run `pnpm nx test claude-agent-adapter --skip-nx-cache -- claude-non-persistence.live.spec.ts`. Cache must be bypassed so a skipped default run cannot stand in for evidence. Dispose of the fixture home only after its native processes exit; the positive controls intentionally leave disposable histories.

The fixture calls the real adapter with a unique harmless prompt, requires a tool-free reply after native execution, and checks both project history directories without reading transcript contents. For each namespace, shipped fresh options must write a transcript as a positive control. Record the reported SDK, native CLI, auth path and outcome with the host configuration, not a credential or transcript. This fixture qualifies only the non-persistence behavior of the tested launch, not retention, production confinement, or a benchmark arm.

## Local verification
- Build: `pnpm nx build control-plane`.
- Core: `pnpm nx test core -- reviewed-handoff.spec.ts execution-run-unit-of-work.spec.ts layered-convergence-engine.spec.ts orchestrator.spec.ts pr-repair-worker.spec.ts pr-finalize.spec.ts`.
- SQLite: `pnpm nx test persistence -- agent-conversation-repository.spec.ts domain-migrations.spec.ts pr-ci-repair-repository.spec.ts`.
- Runtime: `pnpm nx test execution -- workspace-conversation-custody.spec.ts workspace-pruner.spec.ts execution-entry-point.spec.ts agent-orchestrator-runner.spec.ts`.
- Provider boundaries: `pnpm nx test codex-agent-adapter -- codex-app-server.spec.ts codex-usage.spec.ts`; `pnpm nx test claude-agent-adapter -- claude-agent-adapter.spec.ts claude-usage.spec.ts`.
- Control plane: `pnpm nx test control-plane -- reviewed-conversation.spec.ts reviewed-execution-dispatcher.spec.ts publication-git.spec.ts spec-convergence.integration.spec.ts`.
- Round 2 reran the control-plane build, the two reviewed-dispatch suites (38 tests), the Codex wire/usage suites (28 tests), and the Claude adapter suite (71 tests) and lint. The native fixture skipped by default and rejected an opt-in with no fixture home before dispatch. These results do not qualify either runtime.
- No public API contract changes. The broader server test that calls `listen(127.0.0.1)` cannot run in this sandbox; use an authorized host for it.

## Matched comparison — not run

A (continuity): blocked for both providers, no eligible live native starts/resumes. B (fresh with handoff): Claude blocked on unverified native non-persistence; Codex is ephemeral but the matched cases were not run. C (shipped): pin the pre-implementation revision `c85eca1` separately, do not emulate it by disabling the slots. No measured time, cost, quality, or resume counts are reported. Scripted tests do not count as benchmark samples.

Before release, qualify exact enabled configurations for both providers and complete matched spec and implementation cases. Use the same starting revision of each work fixture, tasks, feedback, validation, routing, auth, inference settings, and pricing revision within each comparison. Rotate arm order and log cache state, optional-block byte counts, gate arrivals and non-arrivals, actual fresh/resume/fallback counts, elapsed times, tool calls/repeated work, disjoint usage and price coverage, and observed/missed findings against the case oracle. Preserve failed samples. A vs B isolates continuity; B vs C isolates prompt/handoff changes; A vs C is the total change.
