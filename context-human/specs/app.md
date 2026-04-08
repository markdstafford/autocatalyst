---
created: 2026-04-08
last_updated: 2026-04-08
---

# Autocatalyst

## What

Autocatalyst is a development automation platform that runs an AI-led loop from idea to working code. A person seeds an idea; the system turns it into a structured spec, presents the spec for human review and approval, and then hands it off to a coding agent that implements and verifies the feature. The human's role is reduced to three touchpoints: proposing ideas, approving specs, and testing completed features.

Autocatalyst is built for a small engineering team actively developing a software platform — in this case, the Application Modernization Platform (AMP) at MongoDB. It is not a general-purpose coding assistant; it is a purpose-built harness for a specific development loop with opinionated structure at every stage.

## Why

Human attention is the scarcest resource in software development. The most valuable use of that attention is the work AI cannot do well today: exercising judgment about what matters, developing taste for what a good product feels like, and assessing whether a feature actually works for a real user.

To focus human attention on those things, AI needs to lead everything else. Autocatalyst hands the execution loop — spec generation, implementation, verification — to AI, and reserves human judgment for the decisions that compound: what to build, whether the design is right, and whether the result is good.

## Personas

- **Phoebe: Product manager** — seeds ideas, writes briefs, and approves specs before implementation begins
- **Enzo: Engineer** — reviews technical specs, tests completed features, and provides feedback on implementation quality
- **Dani: Designer** — reviews design decisions in specs, assesses usability of completed features, and seeds ideas grounded in user experience

## Narratives

### A small idea, end to end

Enzo notices that first-time users of AMP's CLI struggle with the initial configuration step — there are too many settings and no guidance on what values to use. He seeds the idea in a sentence: "add a setup wizard to the CLI that walks new users through initial configuration." Within a minute, Autocatalyst has drafted a spec: a step-by-step prompt sequence with sensible defaults and a description for each setting. Enzo reads it and pushes back on one point — the spec requires all settings to be completed before the wizard exits, but new users often won't have all the values ready. He says so, and Autocatalyst revises the spec so that optional settings can be skipped and completed later from the CLI.

Enzo approves the revised spec and the implementation begins. Twenty minutes later, Autocatalyst reports that the wizard is built and tests are passing. Enzo runs it against a fresh environment — the flow mostly works, but one required setting asks for a connection string whose format depends on the authentication method the user chose earlier in the wizard. It's confusing. He flags it. The agent proposes splitting the setting into two — one for the endpoint, one for credentials — and fetching the list of valid authentication methods directly from the service rather than asking users to know them. Enzo confirms the approach, the agent implements it, and Enzo tests again. The flow is clean.

The entire cycle — idea to merged feature — took under an hour. Enzo wrote two sentences and tested twice.

### A big idea, shaped by the team

Phoebe has been thinking about a capability that would change how AMP users build pipelines: composable workflows, where steps can be defined independently and assembled at runtime. It's a significant surface area — new data model, new UI, new API contracts. She seeds the idea with a paragraph describing the core use case, and Autocatalyst produces a first-draft spec covering scope, open questions, and a proposed design.

The first-draft spec includes a list of open questions. Phoebe answers several herself — she knows the scope and the business constraints. But two questions need outside input: how dependency ordering between steps should work, and whether the composition UI is the right model at all. She tags Enzo on the dependency question — both because he needs to answer it and because she wants his broader read on the technical approach. She tags Dani for a general design review. Autocatalyst redrafts the spec with Enzo's answers incorporated, but Dani isn't convinced by the composition UI — a user looking at it wouldn't understand what the workflow is doing — and she wants to rethink the interaction model from scratch. That conversation takes a working session to resolve. Phoebe feeds the transcript into Autocatalyst, which extracts the decisions and incorporates them into a final draft. The team approves it at the end of the second day.

Implementation takes a few hours across multiple agents working in parallel. When it's done, Phoebe runs the end-to-end workflow creation flow and hits something nobody caught in the spec: the model only supports built-in step types, but her test case involves adding a custom transformation step. It's not a bug; the spec just never considered custom steps as part of scope. The implementation gets scrapped, the spec gets a revision, and the agents rebuild. The second implementation ships cleanly. Enzo and Dani complete their testing without issues.

### The loop gets better every week

After the composable workflows implementation had to restart, Autocatalyst flags the pattern: a spec was approved and an implementation was scrapped because a usage assumption was never surfaced at spec time. Without any human prompt, it extends the spec template to include a usage assumptions section. For subsequent specs, Autocatalyst populates the section itself — drawing on the idea description, codebase context, and prior feedback — and surfaces the assumptions for human review rather than asking the human to generate them. The next spec Phoebe reviews has the section already filled in. She corrects one assumption and approves the rest. The implementation ships on the first try.

At the end of the week, Phoebe pulls up the activity log: six features shipped, two specs in review, one restart before the template improvement took effect. The velocity is good, and the trend is better — the system is getting smarter about what it needs to know before it builds.

## High-level requirements

### Platform decisions

- **Runtime**: backend service, started via CLI initially, hosted eventually
- **Human interface**: pluggable adapter model — designed to work with any input/output channel (Slack, Discord, Linear, GitHub Issues, etc.); initial implementation targets one
- **Agent runtime**: pluggable adapter model; initial implementation targets oh-my-claudecode (OMC), which orchestrates Claude Code
- **Observability**: required from day one; logs, metrics, and traces must be queryable by agents without human intermediaries; stack TBD (Victoria stack is a strong candidate)
- **Clients**: no dedicated UI; the human interface is the client
- **Deployment target**: local machine initially; cloud-hosted long-term (provider TBD)

### Architecture decisions

- **Orchestrator pattern**: single-authority scheduler — only the orchestrator mutates loop state; prevents duplicate spec generation or parallel implementations for the same idea
- **State model**: layered — orchestrator state (in-memory), workspace state (filesystem, isolated per run), loop state (spec content, approval status, implementation output, stage); external state store for hosted/scaled deployments
- **Workspace isolation**: each idea-to-implementation run gets a sandboxed filesystem directory; enforced path containment; cleanup on terminal states
- **Loop configuration**: repository-owned workflow contract (WORKFLOW.md-style) defining prompt templates, stage policies, and runtime settings; hot-reloadable without restart
- **Reconciliation**: pull-based tick model; external state (approval signals, tracker status) polled each tick; no webhook infrastructure required for core correctness
- **Retry strategy**: differentiated by exit reason — normal completion triggers short continuation check; failures use exponential backoff with configured cap
- **Concurrency**: bounded global concurrency with per-stage overrides; prevents runaway agent spawning
- **Adapter pattern**: human interface and agent runtime behind defined interfaces; core loop logic unchanged when adapters are swapped
- **Language/runtime**: TBD (ADR); must support async I/O, good containerization story, strong webhook ecosystem
- **Repo structure**: optimized for agent authorship — explicit module boundaries, stable `key=value` structured logging throughout, no code requiring human context to modify

### Data decisions

- **Orchestrator state**: in-memory during a run; no database required initially
- **Workspace state**: filesystem — one directory per run, persisted across retries, cleaned up on terminal states
- **Loop state**: persistent record per idea-to-implementation run (stage, spec content, approval history, implementation output, terminal reason); required for resumability, observability, and loop improvement
- **State store**: TBD (ADR); in-memory with filesystem recovery initially; external store (e.g. Postgres, Redis) for hosted deployments
- **Spec artifacts**: written to disk as versioned files in the target repo (`context-human/specs/` per ADR-002)
- **No user-facing database**: all durable state lives in the filesystem, the state store, or the human interface platform (e.g. issue tracker, message thread)

### Security decisions

- **Workspace containment**: agent runs are strictly sandboxed to their assigned workspace directory; path traversal outside workspace root is rejected before agent launch
- **Secrets management**: API keys and tokens injected via environment variables; never logged or written to workspace; `$VAR`-style indirection in WORKFLOW.md config
- **Agent permissions**: agent runtime operates with minimum required permissions per run (read/write to workspace only by default); elevated permissions require explicit configuration
- **Authentication**: human interface adapter responsible for authenticating inbound signals (approval, idea input); core orchestrator trusts only authenticated events
- **Trust boundary**: TBD per deployment — local runs are trusted environments; hosted deployments require explicit trust model (ADR)

### Operations decisions

- **Observability**: structured `key=value` logging on all state transitions and agent events; metrics and traces emitted from day one; queryable by agents without human intermediaries
- **Health check**: service exposes a lightweight status endpoint (loop state, running agents, retry queue, token totals); for operational visibility only, not required for orchestrator correctness
- **Deployment**: containerized; CLI start for local use; container orchestration for hosted deployments (TBD)
- **Repo targeting**: service is not inlined into repos; each target repo owns a WORKFLOW.md that Autocatalyst discovers and loads; target repo(s) specified via config or CLI parameter at startup; single-repo is the initial implementation, multi-repo is the target model
- **Configuration management**: WORKFLOW.md hot-reloads without restart; invalid reloads preserve last known good config and emit an error
- **Workspace cleanup**: terminal runs trigger automatic workspace cleanup; startup reconciliation removes orphaned workspaces from prior crashes
- **Testing**: agent-executable test suite; agents must be able to run, interpret, and act on test output without human intermediaries

## Related features

### Core loop

- **Idea intake** — receive and queue an idea from any configured human interface adapter
- **Spec generation** — produce a structured spec from an idea using mm:planning conventions; surface open questions
- **Spec review** — post spec to human interface; collect feedback; iterate until approved
- **Implementation** — hand approved spec to agent runtime; run in isolated workspace
- **Implementation review** — surface implementation output to human interface; collect feedback; iterate until accepted
- **Loop telemetry** — emit structured events at every stage transition; queryable by agents

### Adapters

- **Human interface adapter: Slack** — inbound ideas and approvals via Slack events; outbound spec/status posts
- **Agent runtime adapter: oh-my-claudecode** — implementation via OMC orchestrating Claude Code

### Loop improvement

- **Spec template evolution** — automatically extend spec templates based on patterns in failed implementations
- **Activity log** — per-repo view of ideas, specs, implementations, and outcomes
