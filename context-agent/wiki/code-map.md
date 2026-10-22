# Code map

- Runtime Micromanager source, pin, synchronization, fidelity checks and E2E handoff: [micromanager-runtime.md](micromanager-runtime.md).
OpenAI spec result handoff (2026-10-22): `packages/openai-agent-adapter/src/openai-agent-adapter.ts` instructs spec authors to write to the absolute sandbox scratch result path and also captures the declared result file under the sandbox repository root. SDK file reads resolve relative to the manifest root, independently of shell workdir. `openai-agent-adapter.spec.ts` covers scratch and repo-relative writes through the real SDK with mocked model HTTP; both must copy valid JSON into host scratch before a prose final answer. Reviewer grants and NoopSnapshotSpec remain unchanged.
