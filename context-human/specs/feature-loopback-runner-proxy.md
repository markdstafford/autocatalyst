---
created: 2026-06-13
last_updated: 2026-06-14
status: implementing
issue: 52
specced_by: autocatalyst
---
# Feature: Loopback runner proxy for request observability and outbound header control

## Product requirements

### What

Add a local loopback HTTP proxy to the execution layer as the durable, v0-parity mechanism for runner request/response observability and outbound header control when a provider SDK does not expose an in-process transport hook. The proxy listens on `127.0.0.1:`, receives traffic from a runner cell through that loopback base URL, applies endpoint-owned request alteration, forwards one request to the real upstream, streams the response back, and optionally writes redacted request/response records to disk.
This feature fixes the current Grove/Azure API Management authentication gap for the Claude Agent SDK subprocess path. Grove requires the credential on a plain `api-key` header, but the subprocess path currently injects credentials only through Claude SDK environment variables such as `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`. The existing `authHeaderName` setting is honored by fetch/direct cells and ignored by the subprocess path, so Grove rejects the request with a missing subscription key. The proxy gives the subprocess path the same outbound header control that the fetch path already has.
The feature must make the four runner cells reach the same capability set: redacted outbound request/response observability, header stripping or filtering, configured auth-header placement, and no proxy-owned retry behavior. The capability can be delivered by the existing in-process fetch alteration path where that path already exists, and by the loopback proxy where SDKs need it.
### Why

Three problems share one root cause: runner provider traffic is not always passing through a boundary that Autocatalyst controls.
First, Grove authentication is broken for the Claude Agent SDK cell because the SDK subprocess can put the credential on default Anthropic headers, but Grove requires `api-key`. Second, header stripping is impossible on that subprocess path, so gateway-rejected headers such as `x-api-key` or unwanted `anthropic-beta` values may still leave the process. Third, failures on the subprocess path are hard to diagnose because Autocatalyst cannot see the actual HTTP request and response. A failed run currently collapses into a sanitized result such as `Runner failed before terminal result`, which protects secrets but gives too little evidence to fix endpoint configuration.
The runner connection-layer spec intentionally deferred per-HTTP request/response logging for the Claude subprocess path to a future SDK hook or local proxy. Issue #52 is the point where that accepted trade-off blocks real operation. The v0 loopback proxy already solved this shape of problem, so the rebuild should port the pattern into the current runner architecture instead of adding another provider-specific workaround.
### Goals

- Add a reusable loopback proxy in the execution layer that can forward provider HTTP traffic from SDKs pointed at a local `baseURL`.
- Preserve the current per-endpoint request-alteration ownership from ADR-023: endpoint settings, not provider adapters, decide `baseUrl`, `authHeaderName`, header stripping, header rewriting, timeout, and retry posture.
- Honor `authHeaderName` with a secret-resolved credential on paths that cannot currently place the credential on arbitrary headers.
- Support whole-header stripping through `headersToStrip` on proxied traffic.
- Support value-level header filtering for gateway-sensitive headers, especially `anthropic-beta`, when whole-header stripping is too coarse.
- Write optional redacted request/response records to disk when explicitly enabled.
- Keep request logging off by default.
- Redact credentials and auth-shaped response headers in every disk record.
- Cap captured bodies at 64 KiB and mark truncated captures.
- Preserve streaming responses without buffering the full response in memory.
- Respect backpressure between downstream SDK clients and upstream provider responses.
- Return clean proxy failure envelopes for upstream transport failures without exposing secrets or raw stack traces.
- Degrade gracefully if the request-log directory cannot be prepared: the proxy keeps serving traffic and disables disk logging for that proxy instance.
- Route the Claude Agent SDK subprocess cell through the proxy for durable auth-header injection, header stripping/filtering, and per-request observability.
- Route the OpenAI agent cell through the proxy when a loopback path is enabled for uniform agent-cell logging and header control, while preserving its existing in-process fetch bridge as the implementation seam.
- Keep the Anthropic direct and OpenAI direct cells on the existing fetch transport path unless a later decision requires every direct request to loop through the proxy; their log-record shape should match the proxy records where practical.
- Add a short-lived Phase 1 stopgap for Grove auth by honoring `authHeaderName` in `ANTHROPIC_CUSTOM_HEADERS` on the Claude subprocess launch path before the full proxy is in place.
- Update the relevant docs during implementation if ADR-023's prior subprocess capability exception is superseded by the proxy.
### Non-goals

- Adding proxy-owned retry behavior. The proxy forwards once and returns the result or a clean failure envelope; existing SDK/transport retry settings remain the retry owner.
- Building a new desktop, mobile, or web UI for viewing request logs.
- Persisting request/response bodies in the application database.
- Making high-volume per-turn or per-request data part of the durable run timeline.
- Adding provider-specific logic to core orchestration, run lifecycle, or API route handlers.
- Changing the `Runner` event protocol or the step-result validation pipeline.
- Replacing the existing fetch-transport request alteration path for direct cells.
- Storing plaintext provider credentials in configuration records, logs, disk dumps, or run artifacts.
- Opening pull requests, pushing branches, merging, or changing branch/worktree state as part of this spec.
### Personas

- **Opal (Operator)** needs provider gateway traffic to use the exact headers a configured endpoint requires while keeping credentials out of logs and run records.
- **Enzo (Engineer)** needs request/response evidence for failing runner traffic without patching built modules or weakening failure sanitization.
- **Phoebe (PM)** needs AI runs to reach configured providers reliably so the issue-to-spec-to-implementation loop does not stall at provider authentication.
- **Dani (Designer)** is not a direct user of this backend feature, but future progress and failure views depend on clear, safe diagnostic signals.
### User stories

- As Opal, I can configure an Anthropic provider profile with `authHeaderName: "api-key"` and a secret credential so that the Claude Agent SDK cell authenticates through Grove without a 401.
- As Opal, I can strip or filter headers for one endpoint without affecting other endpoints.
- As Opal, I can enable request logging for a troubleshooting run and get redacted request/response JSON files without changing code.
- As Enzo, I can inspect a request dump and see method, URL, redacted headers, parsed body when safe, status, timing, body size, truncation state, and selected usage details.
- As Enzo, I can verify that streaming provider responses still stream through the runner and are not buffered into memory just for logging.
- As Enzo, I can add another provider cell later by reusing the connection-layer proxy rather than adding provider-specific HTTP interception code.
- As Phoebe, I can re-run a feature spec authoring job against Grove and see the run author a spec instead of failing before a terminal result.
### Acceptance criteria

#### Phase 1 Grove auth stopgap

- The Claude Agent SDK subprocess launch path honors `endpoint.authHeaderName` by adding the secret-resolved credential to `ANTHROPIC_CUSTOM_HEADERS` under that header name.
- The stopgap merges the auth header with configured `headersToRewrite` without dropping existing rewrite entries.
- The stopgap keeps the credential secret-sourced through the existing secret resolver; no inline credential setting is added.
- The stopgap marks `ANTHROPIC_CUSTOM_HEADERS` as secret-bearing for process-launch redaction when it contains the credential.
- A test proves the raw Claude subprocess launch environment contains `ANTHROPIC_CUSTOM_HEADERS` with the secret-sourced credential under `api-key` when `authHeaderName: "api-key"` is configured.
- A test proves redacted process-launch diagnostics replace that credential and mark `ANTHROPIC_CUSTOM_HEADERS` as secret-bearing.
- The stopgap is documented as additive only: it cannot strip SDK default headers, so the full proxy remains required when Grove or another gateway rejects those defaults.
#### Loopback proxy behavior

- The execution layer exposes a loopback proxy factory that binds to `127.0.0.1` on an OS-assigned random port.
- The proxy returns a local base URL suitable for SDK/client configuration, such as `http://127.0.0.1:`.
- The proxy forwards requests to the configured upstream `baseUrl` while preserving path and query semantics.
- The proxy strips hop-by-hop request and response headers before forwarding or returning traffic.
- The proxy forces `accept-encoding: identity` for upstream requests when body capture is enabled or when response inspection requires uncompressed bodies.
- The proxy applies whole-header stripping from `endpoint.headersToStrip` before forwarding.
- The proxy injects the secret-resolved credential on `endpoint.authHeaderName` when configured.
- The proxy applies configured header rewrites where those rewrites are meant to add or replace outbound headers.
- The proxy supports value-level filtering for configured header values, initially including an `anthropic-beta` token filter when enabled.
- The proxy does not retry upstream requests.
- An upstream transport failure returns a `502` JSON error envelope with a safe error code.
- A malformed or unsupported proxied request returns a safe error response and logs safe context only.
- `close()` shuts down the loopback server and records safe summary metadata such as total proxied requests.
#### Request/response logging

- Request logging is off by default.
- When enabled, the proxy prepares the log directory with `0o700` permissions under the app-owned diagnostic root selected by the connection layer.
- Each proxied request gets a stable dump id, such as an ISO timestamp plus random hex suffix.
- The proxy writes one `.request.json` file and one `.response.json` file for successful upstream responses.
- Upstream transport failures write `.response-error.json` when logging is enabled.
- Dump files are written with `0o600` permissions.
- Request records include timestamp, method, URL, redacted headers, and parsed JSON body when the body is JSON, with raw text fallback when it is not.
- Response records include status, redacted headers, timing for headers/first body byte/total where measurable, body byte count, truncation flag, extracted output-token count when present, and basic stream state.
- Captured request and response bodies are capped at 64 KiB by default.
- Captured bodies record whether truncation occurred.
- Request credential headers `x-api-key`, `api-key`, and `authorization` are redacted.
- Response credential-bearing headers `set-cookie`, `authorization`, `www-authenticate`, and `proxy-authenticate` are redacted.
- Known secret values are also redacted from captured text where possible.
- If the log directory cannot be prepared, logging is disabled for that proxy instance and the proxy continues to forward traffic.
- User-editable log directory settings are rejected or disabled if normalization, symlink checks, containment checks, directory ownership, or permission tightening cannot prove the final dump directory remains inside the app-owned diagnostic root.
#### Runner-cell parity

- The Claude Agent SDK cell can run through the loopback proxy so subprocess traffic gets auth-header injection, header stripping/filtering, and request/response logs.
- A provider profile with `authHeaderName: "api-key"` and a secret credential authenticates the Claude Agent SDK cell to Grove rather than failing with missing subscription key.
- The OpenAI agent cell can route traffic through the loopback proxy when the profile or connection layer selects proxy mode; its SDK still remains bound per session and does not use process globals.
- The Anthropic direct cell keeps its existing `createFetchTransport()` path and reaches equivalent auth-header injection, header stripping, retry/timeout handling, and redacted logging through in-process request alteration.
- The OpenAI direct cell keeps its existing `createFetchTransport()` path and reaches equivalent auth-header injection, header stripping, retry/timeout handling, and redacted logging through in-process request alteration.
- Log record shapes between proxy mode and fetch mode are close enough that troubleshooting tools can read common fields without provider-cell branching.
- Provider cells that cannot support a requested alteration fail early when the alteration is marked required, or record a degradation when it is optional.
#### Streaming and resource behavior

- Streaming upstream responses pass through to the SDK/client as chunks arrive.
- The proxy honors downstream backpressure by pausing upstream reads when downstream writes are saturated and resuming on drain.
- The proxy does not buffer the full response body in memory for logging.
- Body capture stops at the configured cap while forwarding continues.
- Proxy startup is lazy per session or connection and caches the startup promise so parallel first requests do not start multiple servers for the same runner session.
- Proxy shutdown happens in runner/session cleanup paths.
#### Tests

- Unit tests cover Phase 1 subprocess auth-header injection through `ANTHROPIC_CUSTOM_HEADERS`.
- Unit tests cover proxy startup on loopback and clean shutdown.
- Unit tests cover upstream path/query preservation.
- Unit tests cover hop-by-hop header stripping.
- Unit tests cover endpoint `headersToStrip` behavior on proxied traffic.
- Unit tests cover `authHeaderName` credential injection on proxied traffic.
- Unit tests cover redaction of request auth headers, response auth headers, and known secret values in disk dumps.
- Unit tests cover log-directory preparation failure degrading gracefully.
- Unit tests cover streaming pass-through and backpressure behavior.
- Unit tests cover proxy failure returning a clean `502` envelope.
- Unit tests cover user-editable log directory containment, path traversal rejection, symlink escape rejection, unsafe existing directory permission handling, and graceful disablement when the directory cannot be made safe.
- Integration tests prove the Claude Agent SDK cell receives a loopback base URL and reaches a fake Grove-like upstream expecting `api-key`.
- Integration tests prove the OpenAI agent cell can route through the proxy without using global SDK clients.
- Existing direct-cell tests continue to pass and prove equivalent request alteration through fetch transport.
- Existing fetch/direct tests document that `headersToRewrite` remains rewrite-only on in-process transports unless that mechanism is explicitly upgraded, while proxy-mode tests prove additive/replacement behavior.
### Non-functional requirements

- **Security:** No plaintext credential, secret handle paired with secret material, provider raw response body beyond the capped redacted dump, raw stack trace, or absolute host path may appear in public run failure reasons, persisted artifacts, or normal logs.
- **Locality:** The proxy binds only to loopback, never `0.0.0.0` or an externally reachable interface.
- **Compatibility:** Existing provider profile settings remain valid. New settings must be additive under the `/v1` contract.
- **Reliability:** A proxy logging failure must not make a provider request fail. A proxy forwarding failure must fail the request clearly and safely.
- **Performance:** The proxy should add minimal overhead beyond streaming through Node. It must not turn streaming responses into full-buffer responses.
- **Maintainability:** Provider-specific HTTP quirks stay in adapter packages or endpoint settings; generic proxy mechanics stay in the execution connection layer.
### Impact on existing behavior

- The Claude Agent SDK cell gains a durable path for endpoint-specific `authHeaderName`, header stripping/filtering, and request/response observability.
- The existing `ANTHROPIC_CUSTOM_HEADERS` stopgap may unblock Grove before the proxy lands, but proxy mode supersedes it for endpoints that also require stripping SDK default headers.
- Fetch/direct cells keep their current request-alteration path; their logging may be adjusted to match the proxy dump shape.
- `maxRetries` remains owned by SDK/transport behavior, not the loopback proxy. The proxy must not silently introduce another retry layer.
- ADR-023's documented subprocess limitation should be revisited during implementation because the proxy removes the reason for that exception for cells that can be pointed at a loopback `baseURL`.
### Devil's advocate pass

- **The proxy can become a secret leak if dumps are too broad.** The implementation must make redaction the default for all credential-shaped headers, use restrictive file permissions, cap body capture, and include tests with known secret sentinel values.
- **A second HTTP path can drift from fetch alteration.** Shared helper functions should own header name validation, stripping rules, auth injection, redaction, and log-record shapes where practical.
- **Proxy retry would create duplicate side effects.** The proxy must forward once. Existing retry controls can remain on SDKs or in the fetch transport wrapper, but the proxy itself should not retry.
- **Direct cells do not need a loopback server today.** Routing them through the proxy would add overhead and another failure point without solving a current limitation. Equivalent record shape is enough unless a later feature needs one single logging path.
- **Value-level filtering can grow into an ad hoc policy language.** Start with a small explicit header-token filter shape for known gateway conflicts, and avoid general scripting or regex-powered mutation unless a concrete need arrives.
### Reviewer pass

This feature fits the existing runner architecture. ADR-022 puts provider traffic behind one connection layer, and ADR-023 makes request alteration per endpoint. A loopback proxy is an implementation mechanism for that same boundary when a provider SDK hides HTTP inside a subprocess. The spec keeps control-plane state mutation, run events, and result validation unchanged, and confines provider transport behavior to execution and adapter packages.
## Design spec

### Design scope

This is a backend execution-plane design. It adds no screens, visual components, or design-system tokens. The design covers how operators configure endpoint behavior, how runner cells route traffic through the proxy or existing fetch alteration, how request dumps are shaped, and how failures stay safe.
### Operator experience

An operator configures a provider profile as they do today, using endpoint fields such as `baseUrl`, `authHeaderName`, `headersToStrip`, `headersToRewrite`, `requestTimeoutMs`, and `maxRetries`. For a Grove-backed Anthropic endpoint, the operator sets `authHeaderName: "api-key"` and stores the credential in the secret store. The operator can enable request dumps only for troubleshooting, either through an endpoint setting or a runtime-controlled diagnostic gate chosen during implementation.
When a run uses the Claude Agent SDK cell with proxy mode enabled, the launch configuration points the SDK at the loopback base URL instead of the real upstream. The proxy forwards to the real upstream and applies the endpoint rules. If logging is enabled, the operator gets a set of JSON dump files that show the request and response after redaction.
Failures should remain actionable but safe. Missing credentials report provider authentication failure. A rejected gateway response is visible in redacted dump metadata and status codes. Proxy startup or upstream forwarding failures produce stable safe codes. Raw tokens, full secrets, raw stack traces, and local absolute paths do not appear in run failure reasons.
### Developer experience

A developer should see four clear seams:
1. A proxy factory in `packages/execution` that owns loopback server lifecycle, request forwarding, streaming, backpressure, and optional disk dumps.
2. Shared request-alteration helpers that apply endpoint auth/header behavior consistently across fetch transport, process launch stopgaps, and proxy forwarding.
3. Connection-layer selection that decides whether a session uses in-process fetch alteration, process-launch environment mapping, or loopback proxy mode.
4. Provider adapters that receive a normal SDK/client configuration such as `baseURL` or fetch transport and do not reimplement proxy internals.
The Claude adapter should not know how dump ids are generated, which headers are hop-by-hop, how redaction works, or how the proxy writes files. The proxy should not know how Claude maps events to `RunnerEvent` values or how OpenAI creates sandbox sessions.
### User flows

#### Flow 1: Grove auth stopgap before proxy mode

1. The profile endpoint includes `authHeaderName: "api-key"` and a credential secret handle.
2. `createAgentConnection()` resolves the credential through the secret resolver.
3. `buildClaudeProcessLaunchEnvironment()` builds the Claude subprocess environment.
4. The builder merges configured `headersToRewrite` with `{ "api-key": "" }` in `ANTHROPIC_CUSTOM_HEADERS`.
5. The process launch redaction marks `ANTHROPIC_CUSTOM_HEADERS` as secret-bearing.
6. The Claude cell can authenticate when the gateway tolerates any other SDK default headers.
#### Flow 2: Claude Agent SDK session through the proxy

1. The connection layer starts a loopback proxy for the session and receives a local base URL.
2. The Claude process launch config points the SDK's `ANTHROPIC_BASE_URL` or equivalent base-url setting at the loopback URL.
3. The proxy stores the real upstream base URL and endpoint alteration policy in its own closure.
4. The SDK sends provider HTTP requests to `127.0.0.1:`.
5. The proxy strips hop-by-hop headers and endpoint-configured headers, filters configured header values, injects the auth header, and forwards the request to the real upstream.
6. The proxy streams the upstream response back to the SDK.
7. If request logging is enabled, the proxy writes redacted request and response dump files.
8. The Claude adapter continues mapping SDK events to canonical runner events as it does today.
9. Session cleanup closes the proxy server.
#### Flow 3: OpenAI agent session through the proxy

1. The OpenAI agent adapter creates its per-session OpenAI client as it does today.
2. When proxy mode is selected, the connection layer supplies either a loopback `baseURL` or a fetch bridge that targets the loopback URL.
3. The SDK traffic flows through the proxy and then to the configured upstream.
4. The existing per-session client and sandbox behavior remain unchanged.
5. Request dumps have the same redaction and file-per-request behavior as the Claude proxy path.
#### Flow 4: Direct cell request through existing fetch alteration

1. The direct adapter builds a provider request and sends it through `connection.createFetchTransport()`.
2. The fetch transport applies `baseUrl`, header stripping, auth-header injection, timeout, retry, and redacted logging in process.
3. The direct call receives the provider response and validates structured output through the existing direct orchestrator path.
4. Log records use the same common request/response projection fields as proxy dumps where practical.
### Configuration design

The feature should reuse existing endpoint settings first:
- `baseUrl` remains the real upstream base URL for proxied traffic.
- `authHeaderName` names the outbound auth header that receives the resolved credential.
- `headersToStrip` removes whole request headers.
- `headersToRewrite` keeps the existing fetch/direct contract on in-process transports: those transports rewrite matching outbound headers that already exist and report degradation or failure when additive rewrites are required but unsupported. Proxy mode and the Claude Phase 1 `ANTHROPIC_CUSTOM_HEADERS` mapping are explicitly additive/replacement mechanisms: they add the configured header when absent and replace it when present.
- `requestTimeoutMs` remains the request timeout for fetch transports and SDKs that support it; the proxy may use it as an upstream request timeout but must not combine it with retry.
- `maxRetries` remains delegated to existing SDK/fetch transport owners; proxy mode must not add retry.
- `requiredAlterations` continues to decide whether unsupported behavior fails or degrades.
Additive settings are needed for proxy-specific diagnostics and value filtering. The exact schema names may change during implementation, but the settings should express:
```typescript
interface ProxyRequestLoggingSettings {
  readonly enabled: boolean;
  readonly logDir?: string; // user-editable relative child under the app-owned diagnostic root
  readonly bodyCaptureBytes?: number; // default 65536
}

interface HeaderValueFilterSettings {
  readonly headerName: string;
  readonly removeValues: readonly string[];
}
```
Logging should also be gateable by environment or launch configuration for local troubleshooting. If both profile config and environment gates exist, the implementation must document precedence and keep the default off.
Header value filters are token filters, not substring or regex filters. For each configured `headerName`, matching is case-insensitive on the header name and case-sensitive on token values by default. The value is split on commas, optional whitespace around commas is ignored, and each token is trimmed before comparison. A configured `removeValues` entry removes only an exactly matching trimmed token; partial substring matches are forbidden. If the same header appears more than once, the filter is applied to every instance before the remaining tokens are rejoined with `, `. Empty tokens left by removal are dropped. If all tokens are removed, the whole header is omitted. `anthropic-beta` uses these same rules, so removing `gateway-beta` from `foo, gateway-beta, bar` forwards `foo, bar`, while `xgateway-beta` is not removed.
### Proxy request flow

For each incoming loopback request:
1. Generate a dump id if logging is enabled.
2. Read request headers and strip hop-by-hop headers.
3. Normalize request headers case-insensitively for policy application while preserving safe outbound casing where practical.
4. Apply `headersToStrip`.
5. Apply configured value filters such as removing selected `anthropic-beta` tokens using the exact token rules from Configuration design.
6. Apply `headersToRewrite` as additive/replacement headers for proxy mode. Existing fetch/direct transports keep rewrite-only semantics unless the implementation separately upgrades and tests that contract for all mechanisms.
7. Inject the resolved credential at `authHeaderName` when configured.
8. Set or force `accept-encoding: identity` when response capture needs readable bodies.
9. Build the upstream URL from the real upstream `baseUrl` plus the incoming path and query string.
10. Forward exactly one upstream request.
11. Stream the response headers and body back to the loopback client.
12. Capture up to the configured body cap for logging while streaming continues.
13. Write request and response dump files after enough data is available, or write a response-error dump on upstream failure.
### Disk dump design

Dump files are diagnostic artifacts outside the application database. They should live under a run-scoped or session-scoped directory chosen by configuration. The proxy should never create dumps in arbitrary paths without containment checks if the log directory comes from a user-editable setting.
The allowed containment root is an app-owned diagnostic root selected by the connection layer for the current run or session, such as an Autocatalyst local run-artifacts or cache diagnostics directory. User-editable `logDir` values are interpreted as relative paths below that root. Absolute `logDir` values, empty path segments that escape the root, `..` traversal, and paths whose normalized or real path would leave the root must disable logging for that proxy instance. A trusted runtime diagnostic gate may choose the root itself, but once chosen, all dump files for the proxy must remain below it.
Directory preparation must be conservative:
- Resolve and validate the diagnostic root before creating the request dump directory.
- Reject symlinks for existing path components below the diagnostic root, and reject any existing component whose real path escapes the root.
- Create missing directories with `0o700` permissions.
- If the final directory already exists, it must be a directory and must be made `0o700` when the current process owns it and the platform supports chmod.
- If an existing directory has group/other permission bits and cannot be tightened, or ownership/platform constraints prevent proving it is private, disable logging rather than writing dumps there.
- If the final path is a file, symlink, hard-to-validate platform object, or otherwise unsafe, disable logging.
When directory preparation is disabled for safety or fails for filesystem reasons, the proxy records a safe warning/degradation such as `proxy_logging_disabled` without including absolute host paths, keeps serving traffic, and uses a no-op request logger with `enabled: false`.
A request dump should look like this shape:
```json
{
  "timestamp": "2026-06-13T00:00:00.000Z",
  "method": "POST",
  "url": "https://gateway.example.test/v1/messages",
  "headers": { "api-key": "[redacted]" },
  "body": { "model": "claude-sonnet-4" },
  "body_capture_truncated": false
}
```
A response dump should look like this shape:
```json
{
  "timestamp": "2026-06-13T00:00:01.000Z",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "timing_ms": { "headers": 120, "first_body_byte": 180, "total": 240 },
  "body_bytes": 4096,
  "body_capture_truncated": false,
  "output_tokens": 512,
  "stream_state": "completed"
}
```
A response-error dump should include the timestamp, safe error code, elapsed time, and safe upstream metadata. It must not include raw exception messages if they may contain URLs with credentials, headers, or body fragments.
### Redaction design

Redaction has three layers:
1. Header-name redaction for known credential-bearing request and response headers.
2. Known-secret replacement for the resolved credential and other secret-bearing launch values known to the connection layer.
3. Body capture limits so redaction mistakes are bounded in size.
For request headers, redact at least `authorization`, `x-api-key`, and `api-key`. For response headers, redact at least `set-cookie`, `authorization`, `www-authenticate`, and `proxy-authenticate`. Keep the redacted value simple and safe, such as `[redacted]`, unless implementation reuses v0's first/last-character redaction. Tests should assert that known sentinel secret values never appear in dump files or structured logs.
### Streaming and backpressure design

The proxy should use Node HTTP streams directly rather than `fetch()` if that gives better control over first-byte timing, backpressure, header forwarding, and streaming capture. If implementation uses `fetch()`, it must still prove streaming and backpressure behavior in tests.
The proxy writes response chunks to the loopback response as they arrive. If `response.write()` returns `false`, the proxy pauses upstream reads until the downstream `drain` event. Body capture appends bytes only until the cap is reached; it does not affect forwarding.
### Failure states and interactions

- Proxy startup failure fails session start with a sanitized provider connection error.
- Log directory preparation failure disables logging and emits a warning, but does not fail session start.
- Upstream DNS, connection, TLS, or socket failures return `502` to the SDK/client with a safe JSON body.
- Upstream HTTP error statuses are forwarded unchanged; the proxy does not classify or replace them.
- Client disconnect closes or aborts the upstream request when safe.
- Proxy close waits for the server to stop accepting new requests and releases resources for the session.
### Design system updates

None.
### Accessibility and responsive behavior

No UI behavior is introduced. Future UI work should treat request dumps as sensitive diagnostic artifacts and should not expose raw bodies by default.
## Tech spec

### Current state

- `packages/api-contract/src/configuration-record.ts` defines provider profile endpoint settings, including `baseUrl`, `authHeaderName`, `authEnvironmentVariable`, `headersToStrip`, `headersToRewrite`, `requestTimeoutMs`, `maxRetries`, and `requiredAlterations`.
- `packages/execution/src/request-alteration.ts` owns in-process fetch alteration, Claude process-launch environment mapping, capability degradation, and redaction helpers.
- `packages/execution/src/connection.ts` owns `createAgentConnection()`, credential resolution, `createFetchTransport()`, and `createProcessLaunchConfig()`.
- `packages/execution/src/agent-provider-adapter.ts` defines `AgentConnection`, `ResolvedAgentRunnerProfile`, `ProviderFetchTransport`, and process-launch config contracts.
- `packages/claude-agent-adapter/src/claude-agent-adapter.ts` uses `connection.createProcessLaunchConfig()` and launches the Claude Agent SDK subprocess through a dynamic SDK import or test seam.
- `packages/openai-agent-adapter/src/openai-agent-adapter.ts` creates a per-session OpenAI client bound to `connection.createFetchTransport()` and avoids SDK globals.
- `packages/anthropic-direct-adapter` and `packages/openai-direct-adapter` use the direct provider adapter path with `connection.createFetchTransport()`.
- Current fetch transport logging is redacted but not yet the same as v0 disk request/response dumps.
- Current Claude process-launch mapping can add `headersToRewrite` to `ANTHROPIC_CUSTOM_HEADERS`, but it does not yet map `authHeaderName` to a secret-sourced custom header and cannot strip SDK default headers.
### Proposed modules and ownership

Add execution-owned proxy modules:
- `packages/execution/src/loopback-proxy.ts` — loopback server lifecycle, URL mapping, forwarding, streaming, backpressure, safe failure envelopes, and close behavior.
- `packages/execution/src/proxy-request-logging.ts` — dump id generation, log-dir preparation, file writes with permissions, body capture, response timing, output-token extraction, and graceful logging-disable behavior.
- `packages/execution/src/proxy-header-policy.ts` — hop-by-hop header stripping, endpoint whole-header stripping, header rewrite/add behavior for proxy mode, auth-header injection, `accept-encoding` handling, and value-level header filters.
- `packages/execution/src/proxy-redaction.ts` or shared additions to `request-alteration.ts` — redaction helpers shared by proxy dumps and fetch transport logs.
Update existing modules:
- `packages/api-contract/src/configuration-record.ts` — add optional request-logging and header-value-filter settings if implementation chooses configuration-record ownership over an environment-only diagnostic gate.
- `packages/execution/src/request-alteration.ts` — add Phase 1 `authHeaderName` handling for Claude process launch and extract shared header/redaction helpers used by proxy mode.
- `packages/execution/src/connection.ts` — create and expose proxy-capable connection behavior, including loopback proxy lifecycle and safe logging context.
- `packages/execution/src/agent-provider-adapter.ts` — extend connection contracts only if adapters need a new explicit proxy handle; otherwise keep proxy mode hidden behind existing `createFetchTransport()` or process-launch config.
- `packages/claude-agent-adapter/src/claude-agent-adapter.ts` — use proxy-supplied base URL in process launch when proxy mode is selected.
- `packages/openai-agent-adapter/src/openai-agent-adapter.ts` — route the per-session OpenAI client through proxy mode when selected, without changing global SDK state.
- Direct adapter packages — no proxy-specific code expected; update only if shared log-shape changes require contract updates.
- `context-agent/wiki/code-map.md` — document the proxy modules, connection-layer selection, logging settings, and any new configuration fields during implementation.
Exact filenames may change if implementation finds a cleaner package-private split, but ownership should remain stable: generic proxy mechanics in `packages/execution`, provider SDK binding in adapter packages, schemas in `packages/api-contract`, and no provider HTTP specifics in core.
### Public and internal types

Representative proxy factory:
```typescript
interface LoopbackProxyOptions {
  readonly upstreamBaseUrl: string;
  readonly endpoint: RunnerEndpointSettings;
  readonly credential?: string;
  readonly authScheme?: 'raw' | 'Bearer';
  readonly logging?: ProxyRequestLoggingOptions;
  readonly headerValueFilters?: readonly HeaderValueFilter[];
  readonly logger?: ProviderConnectionLogger;
  readonly telemetryContext: AgentConnectionTelemetryContext;
}

interface LoopbackProxyHandle {
  readonly baseUrl: string;
  readonly startedAt: string;
  readonly requestCount: () => number;
  close(): Promise;
}
```
Representative request logging types:
```typescript
interface ProxyRequestLoggingOptions {
  readonly enabled: boolean;
  readonly diagnosticRoot: string;
  readonly logDir?: string;
  readonly bodyCaptureBytes?: number;
}

interface HeaderValueFilter {
  readonly headerName: string;
  readonly removeValues: readonly string[];
}
```
Representative dump metadata:
```typescript
interface ProxyTimingMs {
  readonly headers?: number;
  readonly firstBodyByte?: number;
  readonly total?: number;
}
```
The proxy handle should remain internal to execution if possible. Adapters should receive ordinary provider SDK inputs: a base URL, a fetch transport, or a process launch config.
### Configuration and selection

Proxy mode needs an explicit selection rule. The implementation should prefer a small connection-layer policy over provider adapter branching:
- `process_environment` profiles may require proxy mode when endpoint settings include unsupported but required subprocess alterations such as `headersToStrip` or request logging.
- Claude Agent SDK profiles can use proxy mode whenever the SDK supports a base-url environment variable that points at the loopback URL.
- OpenAI agent profiles can opt into proxy mode for uniform agent-cell request dumps.
- Direct profiles default to fetch transport mode.
If a new schema field is needed, use an additive endpoint setting such as:
```typescript
proxyMode?: 'auto' | 'disabled' | 'required'
```
`auto` should choose proxy when it is needed to satisfy configured capabilities. `required` should fail session start if the cell cannot route through the proxy. `disabled` should keep the existing mechanism and fail if a required alteration cannot be satisfied. If implementation chooses not to add a schema field in this slice, the selection rule must still be deterministic and covered by tests.
### Phase 1 process-launch change

Update `buildClaudeProcessLaunchEnvironment()` so that when `endpoint.authHeaderName` is set:
1. Resolve the credential as it does today before calling the launch builder.
2. Build a custom-header object from `endpoint.headersToRewrite ?? {}`.
3. Add or replace `customHeaders[endpoint.authHeaderName] = credential`.
4. Serialize that object as `ANTHROPIC_CUSTOM_HEADERS`.
5. Add `ANTHROPIC_CUSTOM_HEADERS` to `secretVariableNames`.
6. Avoid also forcing the credential into a custom header when `authHeaderName` is absent.
Keep existing `authEnvironmentVariable` behavior for the SDK's default credential environment variable. The stopgap may still set `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`; the full proxy is what can remove or override gateway-rejected defaults.
### Proxy URL mapping

The proxy should map an incoming loopback URL to the upstream as follows:
```plain text
incoming: http://127.0.0.1:41234/v1/messages?x=1
upstreamBaseUrl: https://gateway.example.test/anthropic
forwarded: https://gateway.example.test/anthropic/v1/messages?x=1
```
Rules:
- Preserve the upstream base path prefix.
- Preserve the incoming path after the loopback origin.
- Preserve query string and hash where applicable.
- Reject invalid upstream base URLs before starting the proxy.
- Do not accept absolute-form proxy requests that attempt to override the configured upstream host.
### Header policy

Hop-by-hop request and response headers should be stripped regardless of endpoint settings:
- `connection`
- `content-length`
- `host`
- `keep-alive`
- `proxy-authenticate`
- `proxy-authorization`
- `te`
- `trailer`
- `transfer-encoding`
- `upgrade`
Endpoint header policy then runs in this order:
1. Whole-header strip from `headersToStrip`.
2. Value-level filters, if configured. Filters match header names case-insensitively, split repeated or comma-separated values into trimmed comma-delimited tokens, remove exact case-sensitive token matches from `removeValues`, never remove partial substrings, drop empty tokens, and omit the header if no tokens remain.
3. Header rewrite/add from `headersToRewrite` for proxy mode only. The existing fetch/direct alteration path remains rewrite-only unless a separate implementation change upgrades that path and its tests.
4. Auth-header injection from `authHeaderName`.
5. `accept-encoding: identity` override when required for capture.
Auth-header injection intentionally runs after rewrite so the secret-sourced value wins over static configuration.
### Logging algorithm

When logging is enabled:
1. Resolve the app-owned diagnostic root, normalize the user-editable `logDir` as a relative child when present, and prepare the final directory once when the proxy starts.
2. If preparation fails, record a warning and set `logging.enabled=false` for the proxy instance.
3. For each request, generate `dumpId` and start monotonic timing.
4. Capture and redact the request body up to `bodyCaptureBytes`.
5. Write `.request.json` with mode `0o600`.
6. Forward the upstream request.
7. Record time to headers when upstream response headers arrive.
8. Record time to first body byte when the first chunk arrives.
9. Capture and redact response body chunks up to `bodyCaptureBytes` while forwarding all chunks.
10. On upstream end, write `.response.json` with status, headers, timings, bytes, truncation, output tokens, and stream state.
11. On upstream transport error, write `.response-error.json` with safe error code and timing.
If request-body capture and forwarding cannot both read the incoming request stream safely, implement a tee or bounded buffered read that still forwards the full body. Large request bodies should not be held fully in memory just to write diagnostics.
### Fetch transport log-shape alignment

The existing `createFetchTransport()` path should not be forced through the proxy for direct cells in this slice. Instead, adjust its redacted log projection where useful so the common fields match proxy dumps:
- method
- URL
- redacted request headers
- status
- redacted response headers
- duration
- outcome
- provider/profile/run context
Fetch transport does not need disk dumps unless request logging is explicitly generalized beyond proxy mode. If disk dumps are added for fetch mode too, use the same `proxy-request-logging` helpers under a transport-neutral name.
### Runner integration

Claude Agent SDK integration:
- `createAgentConnection()` starts or prepares a proxy when profile selection chooses proxy mode.
- `createProcessLaunchConfig()` sets the process base URL to the proxy's local base URL instead of the real endpoint `baseUrl`.
- The proxy keeps the real upstream `baseUrl` in its options.
- The Claude adapter continues to call `connection.createProcessLaunchConfig()` and does not own proxy startup directly.
- Adapter/session close paths close the proxy through the connection or runner close lifecycle.
OpenAI agent integration:
- Keep the per-session `OpenAI` client and `OpenAIProvider` construction.
- When proxy mode is selected, configure the OpenAI client `baseURL` or bridge fetch to the loopback URL.
- Avoid `setDefaultOpenAIClient`, `setDefaultModelProvider`, or other globals.
- Keep sandbox workspace behavior unchanged.
Direct integration:
- Anthropic direct and OpenAI direct continue to call `connection.createFetchTransport()`.
- Ensure their tests prove endpoint auth-header injection and header strip behavior still work.
### Error handling

Add or reuse sanitized error codes:
- `proxy_start_failed`
- `proxy_upstream_failed`
- `proxy_invalid_upstream`
- `proxy_logging_disabled`
- `proxy_request_malformed`
- `unsupported_required_capability`
Provider-facing proxy failure envelopes should be JSON and simple:
```json
{
  "error": {
    "code": "proxy_upstream_failed",
    "message": "Provider proxy upstream request failed."
  }
}
```
Core run failure mapping should continue to normalize provider and execution errors. The proxy must not bypass existing failure-reason sanitization.
### Testing plan

Targeted tests:
- `packages/execution/src/request-alteration.spec.ts` for Phase 1 `authHeaderName` to raw `ANTHROPIC_CUSTOM_HEADERS`, merge behavior, and separate redacted launch diagnostics.
- `packages/execution/src/loopback-proxy.spec.ts` for startup/shutdown, URL mapping, forwarding, safe 502 failures, and close summary behavior.
- `packages/execution/src/proxy-header-policy.spec.ts` for hop-by-hop stripping, endpoint stripping, value filters, rewrite/add, and auth injection order.
- `packages/execution/src/proxy-request-logging.spec.ts` for log-dir preparation, file permissions, dump shape, body cap, truncation flags, response-error dumps, and graceful log disablement.
- `packages/execution/src/proxy-redaction.spec.ts` or additions to `request-alteration.spec.ts` for request/response credential redaction and sentinel secret absence.
- `packages/execution/src/connection.spec.ts` for proxy selection and lifecycle through `createAgentConnection()`.
- `packages/claude-agent-adapter/src/claude-agent-adapter.spec.ts` for process launch receiving loopback base URL when proxy mode is selected.
- `packages/openai-agent-adapter/src/openai-agent-adapter.spec.ts` for proxy-mode per-session client routing and no global SDK state.
- Control-plane or runner-cell integration tests with a fake Grove-like upstream expecting `api-key` and rejecting `x-api-key` when strip policy is configured.
Suggested targeted commands:
```bash
pnpm nx test execution -- request-alteration.spec.ts
pnpm nx test execution -- loopback-proxy.spec.ts
pnpm nx test execution -- proxy-header-policy.spec.ts
pnpm nx test execution -- proxy-request-logging.spec.ts
pnpm nx test execution -- connection.spec.ts
pnpm nx test claude-agent-adapter -- claude-agent-adapter.spec.ts
pnpm nx test openai-agent-adapter -- openai-agent-adapter.spec.ts
pnpm nx test control-plane -- runner-cells.integration.spec.ts
pnpm test:boundaries
```
Run `pnpm validate` when targeted tests pass and time permits.
### Risks and open edges

- Some SDKs may not let a base URL point to plain HTTP loopback or may validate hosts unexpectedly. Claude and OpenAI agent integrations need explicit tests against the real SDK seams where possible.
- Grove may reject headers beyond the known `x-api-key` and `anthropic-beta` cases. Whole-header strip plus explicit token filtering should cover known needs, but further gateway-specific rules may require additional settings.
- Disk request dumps are sensitive even after redaction. File permissions, default-off behavior, and short retention guidance are required.
- Direct cells keep the in-process fetch path, so there are two implementation mechanisms for equivalent behavior. Shared policy and redaction helpers reduce drift, but tests must keep them aligned.
- Proxy-mode timeout semantics need care. The proxy can bound its upstream request, but it must not introduce retry and must not conflict with SDK-level timeout behavior.
- Value-level filtering is deliberately narrow. If future providers need complex mutation, that should be a new design decision rather than a broad regex facility hidden in this proxy.
## Converged API

### Files

Path
Purpose
Exports

`packages/execution/src/loopback-proxy.ts`
Owns loopback HTTP proxy lifecycle, 127.0.0.1 random-port binding, upstream URL mapping, one-shot forwarding, streaming response pass-through, backpressure handling, safe 502 failure envelopes, request counting, and shutdown.
`createLoopbackProxy`, `LoopbackProxyOptions`, `LoopbackProxyHandle`, `ProxyFailureCode`, `SafeProxyErrorEnvelope`

`packages/execution/src/proxy-header-policy.ts`
Applies reusable proxy outbound header policy: hop-by-hop stripping, endpoint headersToStrip, configured value filters, headersToRewrite, authHeaderName credential injection, and accept-encoding overrides.
`applyProxyHeaderPolicy`, `mapLoopbackUrlToUpstream`, `HeaderValueFilter`, `ProxyHeaderPolicyInput`, `ProxyHeaderPolicyResult`

`packages/execution/src/proxy-request-logging.ts`
Owns optional diagnostic dump logging for proxied requests, including log directory preparation, dump id generation, capped body capture, timing metadata, JSON file writes with restrictive permissions, output-token extraction, and graceful disablement on logging setup failure.
`createProxyRequestLogger`, `ProxyRequestLoggingOptions`, `ProxyRequestLogger`, `ProxyRequestDumpRecord`, `ProxyResponseDumpRecord`, `ProxyResponseErrorDumpRecord`, `ProxyTimingMs`, `CapturedBody`

`packages/execution/src/proxy-redaction.ts`
Provides shared redaction helpers for proxy dumps and aligned fetch-transport logging, including credential-shaped header redaction and known-secret replacement in captured text.
`redactProxyHeaders`, `redactKnownSecretText`, `ProxyRedactionOptions`

`packages/execution/src/request-alteration.ts`
Extends existing request alteration utilities with the Phase 1 Claude subprocess stopgap that merges endpoint.authHeaderName credentials into ANTHROPIC_CUSTOM_HEADERS while preserving headersToRewrite and marking the custom header environment variable as secret-bearing. Reuses the existing ClaudeProcessLaunchInput and ClaudeProcessLaunchResult contracts.
`buildClaudeProcessLaunchEnvironment`, `ClaudeProcessLaunchInput`, `ClaudeProcessLaunchResult`, `ProviderCapabilityDegradation`

`packages/execution/src/connection.ts`
Selects proxy mode versus existing fetch/process-launch mechanisms, lazily starts and caches loopback proxy handles per runner session, supplies loopback base URLs to agent adapters, owns private conversion from api-contract proxy settings to execution proxy options, and closes proxies during connection cleanup.
`createAgentConnection`

`packages/execution/src/agent-provider-adapter.ts`
Extends execution connection contracts only if needed so provider adapters can receive ordinary SDK configuration backed by proxy mode, such as a local base URL or proxy-aware process launch config, without owning proxy internals.
`AgentConnection`, `ProcessLaunchConfig`, `ProviderFetchTransport`

`packages/api-contract/src/configuration-record.ts`
Adds additive endpoint configuration fields for proxy selection, optional diagnostic request logging, and value-level header filtering while preserving existing provider profile settings.
`ProxyMode`, `ProxyRequestLoggingSettings`, `HeaderValueFilterSettings`, `ProxyEndpointSettingsAdditions`

`packages/claude-agent-adapter/src/claude-agent-adapter.ts`
Consumes connection-created process launch configuration so the Claude Agent SDK subprocess can be pointed at the loopback base URL when proxy mode is selected.

`packages/openai-agent-adapter/src/openai-agent-adapter.ts`
Consumes connection-layer proxy selection so the per-session OpenAI client can route through the loopback proxy when enabled while avoiding global SDK state.

### Public API

#### `createLoopbackProxy`

```typescript
export function createLoopbackProxy(options: LoopbackProxyOptions): Promise
```
- Parameters:
	- `options: LoopbackProxyOptions` — Proxy startup configuration including the real upstream base URL, endpoint alteration policy, resolved credential, optional request logging, optional value filters, logging/telemetry context, and upstream forwarded-request timeout behavior.
- Returns: `Promise`
- Errors:
	- `proxy_invalid_upstream when upstreamBaseUrl is not a valid absolute upstream URL before the server starts.`
	- `proxy_start_failed when the loopback server cannot bind to 127.0.0.1 on an OS-assigned port.`
#### `LoopbackProxyHandle.baseUrl`

```typescript
readonly baseUrl: string
```
- Returns: `string`
#### `LoopbackProxyHandle.startedAt`

```typescript
readonly startedAt: string
```
- Returns: `string`
#### `LoopbackProxyHandle.close`

```typescript
close(): Promise
```
- Returns: `Promise`
#### `LoopbackProxyHandle.requestCount`

```typescript
requestCount(): number
```
- Returns: `number`
#### `applyProxyHeaderPolicy`

```typescript
export function applyProxyHeaderPolicy(input: ProxyHeaderPolicyInput): ProxyHeaderPolicyResult
```
- Parameters:
	- `input: ProxyHeaderPolicyInput` — Incoming request headers plus endpoint policy, resolved credential, header value filters, and capture/inspection requirements.
- Returns: `ProxyHeaderPolicyResult`
#### `mapLoopbackUrlToUpstream`

```typescript
export function mapLoopbackUrlToUpstream(loopbackUrl: string, upstreamBaseUrl: string): URL
```
- Parameters:
	- `loopbackUrl: string` — The local loopback request URL received by the proxy.
	- `upstreamBaseUrl: string` — The configured real provider or gateway base URL whose path prefix must be preserved.
- Returns: `URL`
- Errors:
	- `proxy_invalid_upstream when upstreamBaseUrl is invalid.`
	- `proxy_request_malformed when the incoming request attempts unsupported absolute-form host override semantics.`
#### `createProxyRequestLogger`

```typescript
export function createProxyRequestLogger(options: ProxyRequestLoggingOptions, redaction: ProxyRedactionOptions): Promise
```
- Parameters:
	- `options: ProxyRequestLoggingOptions` — Logging enablement, app-owned diagnostic root, optional relative dump directory, and body capture byte cap.
	- `redaction: ProxyRedactionOptions` — Known secret values and header redaction policy used before writing disk records.
- Returns: `Promise`
#### `ProxyRequestLogger.enabled`

```typescript
readonly enabled: boolean
```
- Returns: `boolean`
#### `ProxyRequestLogger.createDumpId`

```typescript
createDumpId(): string
```
- Returns: `string`
#### `ProxyRequestLogger.writeRequest`

```typescript
writeRequest(record: ProxyRequestDumpRecord): Promise
```
- Parameters:
	- `record: ProxyRequestDumpRecord` — Redacted request dump data for one proxied provider request.
- Returns: `Promise`
#### `ProxyRequestLogger.writeResponse`

```typescript
writeResponse(record: ProxyResponseDumpRecord): Promise
```
- Parameters:
	- `record: ProxyResponseDumpRecord` — Redacted successful upstream response dump data for one proxied provider request.
- Returns: `Promise`
#### `ProxyRequestLogger.writeResponseError`

```typescript
writeResponseError(record: ProxyResponseErrorDumpRecord): Promise
```
- Parameters:
	- `record: ProxyResponseErrorDumpRecord` — Safe transport-failure dump data for one proxied provider request.
- Returns: `Promise`
#### `redactProxyHeaders`

```typescript
export function redactProxyHeaders(headers: Record, options: ProxyRedactionOptions): Record
```
- Parameters:
	- `headers: Record` — Request or response headers to redact before structured logging or disk dumps.
	- `options: ProxyRedactionOptions` — Direction-specific credential header names and known secret values.
- Returns: `Record`
#### `redactKnownSecretText`

```typescript
export function redactKnownSecretText(text: string, options: ProxyRedactionOptions): string
```
- Parameters:
	- `text: string` — Captured request or response text that may contain known secret sentinel values.
	- `options: ProxyRedactionOptions` — Known secret values to replace with a safe redaction marker.
- Returns: `string`
#### `buildClaudeProcessLaunchEnvironment`

```typescript
export function buildClaudeProcessLaunchEnvironment(input: ClaudeProcessLaunchInput): ClaudeProcessLaunchResult
```
- Parameters:
	- `input: ClaudeProcessLaunchInput` — Existing Claude launch environment input, including endpoint settings, resolved credential, and materialized environment/redaction metadata.
- Returns: `ClaudeProcessLaunchResult`
### Types

#### `LoopbackProxyOptions`

```typescript
interface LoopbackProxyOptions { readonly upstreamBaseUrl: string; readonly endpoint: RunnerEndpointSettings; readonly credential?: string; readonly authScheme?: 'raw' | 'Bearer'; readonly logging?: ProxyRequestLoggingOptions; readonly headerValueFilters?: readonly HeaderValueFilter[]; readonly logger?: ProviderConnectionLogger; readonly telemetryContext: AgentConnectionTelemetryContext; readonly requestTimeoutMs?: number; }
```
#### `LoopbackProxyHandle`

```typescript
interface LoopbackProxyHandle { readonly baseUrl: string; readonly startedAt: string; requestCount(): number; close(): Promise; }
```
#### `ProxyFailureCode`

```typescript
type ProxyFailureCode = 'proxy_start_failed' | 'proxy_upstream_failed' | 'proxy_invalid_upstream' | 'proxy_logging_disabled' | 'proxy_request_malformed' | 'unsupported_required_capability';
```
#### `ProxyRequestLoggingOptions`

```typescript
interface ProxyRequestLoggingOptions { readonly enabled: boolean; readonly diagnosticRoot: string; readonly logDir?: string; readonly bodyCaptureBytes?: number; }
```
#### `HeaderValueFilter`

```typescript
interface HeaderValueFilter { readonly headerName: string; readonly removeValues: readonly string[]; }
```
#### `ProxyHeaderPolicyInput`

```typescript
interface ProxyHeaderPolicyInput { readonly headers: Record; readonly endpoint: Pick; readonly credential?: string; readonly headerValueFilters?: readonly HeaderValueFilter[]; readonly forceIdentityAcceptEncoding?: boolean; }
```
#### `ProxyHeaderPolicyResult`

```typescript
interface ProxyHeaderPolicyResult { readonly headers: Record; readonly strippedHeaders: readonly string[]; readonly filteredHeaders: readonly string[]; readonly injectedAuthHeaderName?: string; }
```
#### `ProxyRedactionOptions`

```typescript
interface ProxyRedactionOptions { readonly direction?: 'request' | 'response'; readonly knownSecretValues?: readonly string[]; readonly additionalHeaderNames?: readonly string[]; }
```
#### `CapturedBody`

```typescript
interface CapturedBody { readonly body?: unknown; readonly bodyText?: string; readonly bodyBytes: number; readonly bodyCaptureTruncated: boolean; readonly contentType?: string; }
```
#### `ProxyTimingMs`

```typescript
interface ProxyTimingMs { readonly headers?: number; readonly firstBodyByte?: number; readonly total?: number; }
```
#### `ProxyRequestDumpRecord`

```typescript
interface ProxyRequestDumpRecord extends CapturedBody { readonly dumpId: string; readonly timestamp: string; readonly method: string; readonly url: string; readonly headers: Record; }
```
#### `ProxyResponseDumpRecord`

```typescript
interface ProxyResponseDumpRecord extends CapturedBody { readonly dumpId: string; readonly timestamp: string; readonly status: number; readonly headers: Record; readonly timingMs: ProxyTimingMs; readonly outputTokens?: number; readonly streamState: 'completed' | 'aborted' | 'errored'; }
```
#### `ProxyResponseErrorDumpRecord`

```typescript
interface ProxyResponseErrorDumpRecord { readonly dumpId: string; readonly timestamp: string; readonly errorCode: ProxyFailureCode; readonly elapsedMs: number; readonly upstreamOrigin?: string; readonly upstreamPath?: string; }
```
#### `ProxyRequestLogger`

```typescript
interface ProxyRequestLogger { readonly enabled: boolean; readonly logDir?: string; readonly bodyCaptureBytes: number; createDumpId(): string; writeRequest(record: ProxyRequestDumpRecord): Promise; writeResponse(record: ProxyResponseDumpRecord): Promise; writeResponseError(record: ProxyResponseErrorDumpRecord): Promise; }
```
#### `ProxyMode`

```typescript
type ProxyMode = 'auto' | 'disabled' | 'required';
```
#### `ProxyRequestLoggingSettings`

```typescript
interface ProxyRequestLoggingSettings { readonly enabled: boolean; readonly logDir?: string; readonly bodyCaptureBytes?: number; }
```
#### `HeaderValueFilterSettings`

```typescript
interface HeaderValueFilterSettings { readonly headerName: string; readonly removeValues: readonly string[]; }
```
#### `ProxyEndpointSettingsAdditions`

```typescript
interface ProxyEndpointSettingsAdditions { readonly proxyMode?: ProxyMode; readonly proxyRequestLogging?: ProxyRequestLoggingSettings; readonly headerValueFilters?: readonly HeaderValueFilterSettings[]; }
```
#### `SafeProxyErrorEnvelope`

```typescript
interface SafeProxyErrorEnvelope { readonly error: { readonly code: ProxyFailureCode; readonly message: string; }; }
```
#### `ProviderCapabilityDegradation`

```typescript
interface ProviderCapabilityDegradation { readonly capability: string; readonly reason: string; readonly required: boolean; }
```
#### `ClaudeProcessLaunchInput`

```typescript
interface ClaudeProcessLaunchInput { readonly endpoint: RunnerEndpointSettings; readonly credential: string; readonly materializedEnvironment: { readonly variables: Readonly>; readonly secretVariableNames: readonly string[]; }; }
```
#### `ClaudeProcessLaunchResult`

```typescript
interface ClaudeProcessLaunchResult { readonly environment: Readonly>; readonly secretVariableNames: readonly string[]; readonly degradedCapabilities: readonly ProviderCapabilityDegradation[]; }
```
### Notes

The artifact proposes code-facing APIs and types from the spec; exact implementation visibility can remain package-internal where possible. Adapter files are listed even when they do not add exports because they consume the connection-layer API changes. Direct adapter packages are intentionally omitted because the spec expects them to remain on existing createFetchTransport behavior unless shared log-shape changes require local test updates. Critic-round revisions: loopback-proxy.ts exports SafeProxyErrorEnvelope; configuration-record.ts exports ProxyEndpointSettingsAdditions; buildClaudeProcessLaunchEnvironment now references the existing exported ClaudeProcessLaunchInput and ClaudeProcessLaunchResult shapes; ProxyRedactionOptions no longer exposes a caller-controlled redaction placeholder; LoopbackProxyHandle.baseUrl and startedAt are documented as public handle fields; and connection.ts is explicitly responsible for private conversion from api-contract ProxyRequestLoggingSettings/HeaderValueFilterSettings to execution ProxyRequestLoggingOptions/HeaderValueFilter. LoopbackProxyOptions.requestTimeoutMs is documented as an upstream forwarded-request bound only, not a proxy startup timeout. Current critic-round revisions: ProxyRequestDumpRecord and ProxyResponseDumpRecord now compose CapturedBody as the single canonical body-capture contract, including optional contentType, and ProxyRequestLogger.enabled plus createDumpId() are documented in public_api to make the no-op and dump-id contracts explicit.
## Task list

### Story 1: Add the Phase 1 Claude subprocess auth-header stopgap

#### Task 1.1: Map `authHeaderName` into Claude custom headers

- **Description:** Update `buildClaudeProcessLaunchEnvironment()` in `packages/execution/src/request-alteration.ts` so a resolved credential is added to `ANTHROPIC_CUSTOM_HEADERS` under `endpoint.authHeaderName` when that setting is present.
- **Acceptance criteria:**
	- Existing `headersToRewrite` entries still appear in `ANTHROPIC_CUSTOM_HEADERS`.
	- The `authHeaderName` entry replaces any static rewrite for the same header so the secret-sourced value wins.
	- Existing default SDK credential environment variables still behave as they do today.
	- No custom auth header is added when `authHeaderName` is absent.
- **Dependencies:** None.
#### Task 1.2: Mark Claude custom headers as secret-bearing

- **Description:** Extend the process-launch redaction metadata so `ANTHROPIC_CUSTOM_HEADERS` is included in `secretVariableNames` whenever it contains the resolved credential.
- **Acceptance criteria:**
	- Process-launch logs redact `ANTHROPIC_CUSTOM_HEADERS` when it carries the credential.
	- Redaction preserves the existing secret-variable behavior for other launch variables.
	- A test with a sentinel credential proves the credential does not appear in launch diagnostics.
- **Dependencies:** Task 1.1.
#### Task 1.3: Test the Grove auth stopgap

- **Description:** Add focused tests in `packages/execution/src/request-alteration.spec.ts` for `authHeaderName: "api-key"` on the Claude agent subprocess launch path.
- **Acceptance criteria:**
	- A test proves the raw subprocess environment `ANTHROPIC_CUSTOM_HEADERS` contains the real secret-sourced `api-key` custom header.
	- A test proves redacted launch diagnostics replace the credential and mark `ANTHROPIC_CUSTOM_HEADERS` secret-bearing.
	- A test proves custom headers merge with `headersToRewrite`.
	- A test documents the stopgap limitation that it does not strip SDK default headers.
- **Dependencies:** Tasks 1.1 and 1.2.
### Story 2: Create shared proxy header policy and redaction helpers

#### Task 2.1: Implement proxy URL mapping

- **Description:** Add `mapLoopbackUrlToUpstream()` in `packages/execution/src/proxy-header-policy.ts` to map loopback requests to the configured upstream base URL.
- **Acceptance criteria:**
	- The upstream base path prefix is preserved.
	- The incoming path and query string are preserved.
	- Invalid upstream base URLs fail with `proxy_invalid_upstream`.
	- Absolute-form or malformed loopback requests that attempt host override semantics fail with `proxy_request_malformed`.
- **Dependencies:** None.
#### Task 2.2: Implement outbound proxy header policy

- **Description:** Add `applyProxyHeaderPolicy()` in `packages/execution/src/proxy-header-policy.ts` to apply hop-by-hop stripping, endpoint stripping, value filters, rewrites, auth injection, and `accept-encoding` handling.
- **Acceptance criteria:**
	- Hop-by-hop headers are stripped regardless of endpoint settings.
	- `headersToStrip` removes whole request headers case-insensitively.
	- Configured value filters remove only exact matching comma-delimited header tokens, with case-insensitive header-name matching, trimmed token comparison, duplicate/repeated header handling, and no partial substring removal.
	- `headersToRewrite` adds or replaces outbound headers in proxy mode; fetch/direct transports remain rewrite-only unless their contract is separately changed.
	- `authHeaderName` injection runs after rewrites so the resolved credential wins.
	- `accept-encoding: identity` is set when response capture or inspection requires it.
- **Dependencies:** Task 2.1.
#### Task 2.3: Implement proxy redaction helpers

- **Description:** Add `packages/execution/src/proxy-redaction.ts` with `redactProxyHeaders()` and `redactKnownSecretText()` for proxy dumps and aligned fetch logs.
- **Acceptance criteria:**
	- Request headers `authorization`, `x-api-key`, and `api-key` are redacted by default.
	- Response headers `set-cookie`, `authorization`, `www-authenticate`, and `proxy-authenticate` are redacted by default.
	- Known secret values are replaced in captured text.
	- Redaction handles header names case-insensitively.
	- Redaction does not expose a caller-controlled placeholder that could weaken safety.
- **Dependencies:** None.
#### Task 2.4: Test header policy and redaction

- **Description:** Add `proxy-header-policy.spec.ts` and `proxy-redaction.spec.ts` or equivalent additions to existing execution tests.
- **Acceptance criteria:**
	- Tests cover URL mapping, invalid upstreams, and malformed loopback requests.
	- Tests cover hop-by-hop stripping, endpoint stripping, value filtering, rewrite order, auth injection order, and identity encoding.
	- Value-filter tests cover comma-separated `anthropic-beta` values, repeated header instances, optional whitespace trimming, case-insensitive header names, case-sensitive token values, all-token removal omitting the header, and forbidden partial substring matches.
	- Tests prove sentinel secrets never appear in redacted headers or captured text.
- **Dependencies:** Tasks 2.1, 2.2, and 2.3.
### Story 3: Build the loopback proxy core

#### Task 3.1: Add the loopback proxy factory and handle

- **Description:** Add `packages/execution/src/loopback-proxy.ts` with `createLoopbackProxy()`, `LoopbackProxyOptions`, `LoopbackProxyHandle`, proxy failure codes, and the safe error envelope type from the Converged API.
- **Acceptance criteria:**
	- The server binds only to `127.0.0.1` on an OS-assigned random port.
	- The returned handle exposes `baseUrl`, `startedAt`, `requestCount()`, and `close()`.
	- Invalid upstream configuration fails before the server starts.
	- Startup bind failures surface as `proxy_start_failed`.
	- `close()` stops accepting new requests and releases server resources.
- **Dependencies:** Task 2.1.
#### Task 3.2: Forward proxied requests exactly once

- **Description:** Implement proxy request forwarding from loopback to the real upstream using the shared URL and header policy helpers.
- **Acceptance criteria:**
	- The proxy forwards one upstream request per incoming request.
	- Request method, path, query string, and body are preserved.
	- Hop-by-hop headers are stripped on request and response paths.
	- Endpoint header policy runs before forwarding.
	- The proxy never performs its own retry.
- **Dependencies:** Tasks 2.1, 2.2, and 3.1.
#### Task 3.3: Preserve streaming and backpressure

- **Description:** Stream upstream response chunks to the loopback client without buffering the full response, and pause upstream reads when downstream writes are saturated.
- **Acceptance criteria:**
	- Upstream chunks are forwarded as they arrive.
	- Response capture, when enabled later, stops at the cap without stopping forwarding.
	- `response.write()` backpressure pauses upstream reads and resumes on `drain`.
	- Client disconnect aborts or closes the upstream request when safe.
- **Dependencies:** Task 3.2.
#### Task 3.4: Return safe proxy failure envelopes

- **Description:** Handle upstream transport failures and malformed requests with safe JSON responses and sanitized metadata.
- **Acceptance criteria:**
	- DNS, connection, TLS, and socket failures return HTTP `502` with code `proxy_upstream_failed`.
	- Malformed or unsupported requests return a safe failure response.
	- Failure bodies do not contain raw stack traces, credentials, headers, or local absolute paths.
	- Upstream HTTP error statuses are forwarded unchanged rather than reclassified.
- **Dependencies:** Task 3.2.
#### Task 3.5: Test loopback proxy core behavior

- **Description:** Add `packages/execution/src/loopback-proxy.spec.ts` coverage for startup, forwarding, streaming, backpressure, failures, and shutdown.
- **Acceptance criteria:**
	- Tests prove loopback binding and clean shutdown.
	- Tests prove path/query preservation and one-shot forwarding.
	- Tests prove safe `502` envelopes on upstream transport failure.
	- Tests prove streaming pass-through and backpressure behavior.
	- Tests prove request counting and close behavior.
- **Dependencies:** Tasks 3.1 through 3.4.
### Story 4: Add optional proxy request and response logging

#### Task 4.1: Implement proxy request logger setup

- **Description:** Add `packages/execution/src/proxy-request-logging.ts` with `createProxyRequestLogger()` and the logging contracts from the Converged API.
- **Acceptance criteria:**
	- Logging is disabled by default.
	- Enabled logging prepares the dump directory with `0o700` permissions under the app-owned diagnostic root.
	- User-editable `logDir` values are normalized as relative children of that root; absolute paths, `..` traversal, symlink escapes, non-directory final paths, and unsafe existing permissions disable logging.
	- Existing directories with wider permissions are chmodded to `0o700` when owned and supported; otherwise logging is disabled.
	- Log-directory preparation failure disables logging for that proxy instance and emits a safe warning.
	- The logger still returns a no-op handle with `enabled: false` when setup fails.
	- Dump ids are stable and collision-resistant enough for concurrent requests.
- **Dependencies:** Task 2.3.
#### Task 4.2: Write redacted request, response, and response-error dumps

- **Description:** Implement `writeRequest()`, `writeResponse()`, and `writeResponseError()` with restrictive file permissions and the agreed record shapes.
- **Acceptance criteria:**
	- Request dumps include timestamp, method, URL, redacted headers, captured body, byte count, content type, and truncation state.
	- Response dumps include status, redacted headers, timing, body byte count, truncation state, output-token count when extractable, and stream state.
	- Response-error dumps include safe error code, elapsed time, and safe upstream metadata.
	- Dump files are written with `0o600` permissions.
	- Known secret sentinel values do not appear in dump files.
- **Dependencies:** Task 4.1.
#### Task 4.3: Add bounded body capture and timing

- **Description:** Add reusable capture helpers that collect at most the configured byte cap while request and response streams continue to flow.
- **Acceptance criteria:**
	- The default capture cap is 64 KiB.
	- Captured JSON bodies are parsed when safe.
	- Non-JSON bodies fall back to redacted text where practical.
	- Truncation is marked when capture exceeds the cap.
	- Timing records headers, first body byte, and total duration where measurable.
- **Dependencies:** Tasks 4.1 and 4.2.
#### Task 4.4: Integrate logging into the loopback proxy

- **Description:** Wire `createLoopbackProxy()` to create a request logger, capture bounded request/response bodies, and write dump files without changing forwarding behavior.
- **Acceptance criteria:**
	- Each logged proxied request writes one request dump and one response or response-error dump.
	- Logging failures do not fail provider requests.
	- Body capture does not require full response buffering.
	- `accept-encoding: identity` is forced when capture requires readable response bodies.
- **Dependencies:** Tasks 3.3, 3.4, and 4.3.
#### Task 4.5: Test proxy logging behavior

- **Description:** Add `proxy-request-logging.spec.ts` and proxy integration tests for dump setup, records, redaction, truncation, timing, and graceful degradation.
- **Acceptance criteria:**
	- Tests cover default-off logging and explicit enablement.
	- Tests cover directory and file permissions where the platform allows.
	- Tests cover containment under the diagnostic root, absolute path rejection, `..` traversal rejection, symlink escape rejection, existing non-directory paths, wider existing permissions being chmodded when safe, and graceful disablement when permissions cannot be made safe.
	- Tests cover log-directory setup failure disabling dumps without breaking forwarding.
	- Tests cover request, response, and response-error dump shapes.
	- Tests cover cap/truncation behavior and sentinel secret absence.
- **Dependencies:** Tasks 4.1 through 4.4.
### Story 5: Add configuration and connection-layer proxy selection

#### Task 5.1: Add additive endpoint configuration fields

- **Description:** Update `packages/api-contract/src/configuration-record.ts` with `ProxyMode`, `ProxyRequestLoggingSettings`, `HeaderValueFilterSettings`, and `ProxyEndpointSettingsAdditions` if implementation confirms schema ownership belongs in the public configuration record.
- **Acceptance criteria:**
	- Existing provider profile records remain valid.
	- New fields are optional and additive under the `/v1` contract.
	- `proxyMode` supports `auto`, `disabled`, and `required`.
	- Request logging settings express `enabled`, optional relative `logDir`, and optional `bodyCaptureBytes`; the app-owned diagnostic root is supplied by the connection/runtime layer, not by user-editable endpoint config.
	- Header value filters express `headerName` and `removeValues`.
- **Dependencies:** None.
#### Task 5.2: Implement deterministic proxy-mode selection

- **Description:** Update `packages/execution/src/connection.ts` so `createAgentConnection()` chooses proxy mode from endpoint settings, required capabilities, provider cell capabilities, and logging needs.
- **Acceptance criteria:**
	- `auto` chooses proxy when required subprocess alterations cannot be satisfied in process.
	- `required` fails session start with `unsupported_required_capability` when the cell cannot use proxy mode.
	- `disabled` keeps the existing mechanism and fails or records degradation according to `requiredAlterations`.
	- Direct cells continue to default to `createFetchTransport()`.
	- Selection is covered by unit tests.
- **Dependencies:** Task 5.1.
#### Task 5.3: Lazily start and cache proxy handles per session

- **Description:** Add connection-owned lifecycle management so proxy startup is lazy, concurrent first use shares one startup promise, and cleanup closes the proxy.
- **Acceptance criteria:**
	- Parallel first requests for the same session do not create multiple proxy servers.
	- `createProcessLaunchConfig()` or equivalent adapter inputs receive the loopback base URL when proxy mode is active.
	- The proxy keeps the real upstream base URL internally.
	- Connection/session cleanup closes the proxy handle.
	- Proxy startup failures are sanitized before they reach run failure mapping.
- **Dependencies:** Tasks 3.1, 5.1, and 5.2.
#### Task 5.4: Align fetch-transport log projection where practical

- **Description:** Update the existing `createFetchTransport()` logging projection so direct-cell logs share common fields with proxy dumps where practical, without forcing direct traffic through the proxy.
- **Acceptance criteria:**
	- Direct-cell logs include common method, URL, redacted request headers, status, redacted response headers, duration, outcome, and provider/profile/run context fields where available.
	- Existing fetch transport timeout and retry behavior is preserved.
	- Direct-cell auth-header injection and header stripping behavior remains unchanged.
- **Dependencies:** Task 2.3.
#### Task 5.5: Test connection-layer selection and lifecycle

- **Description:** Add or update `packages/execution/src/connection.spec.ts` coverage for proxy mode, lifecycle, degradation, and direct fetch behavior.
- **Acceptance criteria:**
	- Tests prove lazy startup and startup-promise caching.
	- Tests prove cleanup closes proxy handles.
	- Tests prove `proxyMode` selection behavior.
	- Tests prove unsupported required proxy behavior fails safely.
	- Tests prove direct profiles keep fetch transport mode by default.
- **Dependencies:** Tasks 5.2 through 5.4.
### Story 6: Route agent adapters through connection-owned proxy mode

#### Task 6.1: Point the Claude Agent SDK subprocess at the loopback base URL

- **Description:** Update `packages/claude-agent-adapter/src/claude-agent-adapter.ts` only as needed so it consumes the connection-created process launch config and uses the loopback base URL when proxy mode is selected.
- **Acceptance criteria:**
	- The Claude adapter does not directly create or configure the proxy.
	- The SDK base-url environment variable points to `http://127.0.0.1:` when proxy mode is active.
	- The real upstream base URL is not passed to the subprocess in proxy mode.
	- Existing Claude event mapping and result handling remain unchanged.
- **Dependencies:** Tasks 5.2 and 5.3.
#### Task 6.2: Route the OpenAI agent cell through proxy mode when selected

- **Description:** Update `packages/openai-agent-adapter/src/openai-agent-adapter.ts` so its per-session OpenAI client uses the connection-supplied loopback route when proxy mode is selected.
- **Acceptance criteria:**
	- OpenAI agent proxy mode uses the per-session client.
	- No global OpenAI SDK state is introduced.
	- Existing sandbox session behavior is unchanged.
	- Proxy mode can be enabled without changing direct OpenAI cell behavior.
- **Dependencies:** Tasks 5.2 and 5.3.
#### Task 6.3: Prove direct adapters keep equivalent fetch alteration

- **Description:** Update Anthropic direct and OpenAI direct tests only as needed to prove they still use `createFetchTransport()` for auth-header injection, header stripping, retry/timeout handling, and redacted logging.
- **Acceptance criteria:**
	- Anthropic direct tests continue to pass on fetch transport mode.
	- OpenAI direct tests continue to pass on fetch transport mode.
	- Direct/fetch tests keep the existing `headersToRewrite` rewrite-only contract explicit unless an implementation change upgrades that path for all in-process transports.
	- No direct adapter gains proxy-specific logic unless a shared contract change requires a small adapter update.
- **Dependencies:** Task 5.4.
#### Task 6.4: Add agent-cell integration coverage

- **Description:** Add integration tests with a fake Grove-like upstream that expects `api-key`, rejects configured stripped headers, and returns streaming responses where useful.
- **Acceptance criteria:**
	- Claude Agent SDK cell receives a loopback base URL and authenticates with `api-key`.
	- Claude proxy mode can strip or filter gateway-rejected headers before upstream.
	- OpenAI agent proxy mode routes through the proxy without global SDK clients.
	- Integration dumps, when enabled, use the common redacted record shape.
- **Dependencies:** Tasks 6.1 and 6.2.
### Story 7: Update documentation and validation artifacts

#### Task 7.1: Update agent code navigation notes

- **Description:** Update `context-agent/wiki/code-map.md` with the new proxy modules, connection-layer selection behavior, logging settings, and adapter touch points.
- **Acceptance criteria:**
	- The code map lists the proxy modules and their responsibilities.
	- The code map explains where proxy mode is selected and where adapter code consumes it.
	- The code map notes that direct cells stay on fetch transport by default.
- **Dependencies:** Stories 3, 4, 5, and 6.
#### Task 7.2: Revisit ADR-023 documentation during implementation

- **Description:** Update the relevant human-facing documentation only after implementation confirms the proxy supersedes ADR-023's previous subprocess capability exception for cells that can point at a loopback base URL.
- **Acceptance criteria:**
	- Documentation states which cells now support auth-header injection, stripping/filtering, and request observability through proxy mode.
	- Documentation keeps any unsupported provider behavior explicit.
	- Documentation does not claim direct cells are forced through proxy mode.
- **Dependencies:** Stories 5 and 6.
#### Task 7.3: Run targeted and broad validation

- **Description:** Execute the targeted test commands from the tech spec as implementation lands, then run the broader project validation when practical.
- **Acceptance criteria:**
	- Targeted execution tests pass for request alteration, proxy core, header policy, request logging, and connection lifecycle.
	- Targeted Claude and OpenAI agent adapter tests pass.
	- Runner-cell integration tests pass against fake Grove-like upstream behavior.
	- `pnpm test:boundaries` passes.
	- `pnpm validate` passes when time permits, or any skipped validation is documented with the reason.
- **Dependencies:** Stories 1 through 6.