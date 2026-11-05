---
created: 2026-11-05
last_updated: 2026-11-05
status: approved
issue: 177
specced_by: markdstafford
---
# Settings back button and Connection apply on commit

## What

Settings should feel like a place an operator visits and then leaves, not like a dialog they dismiss. The settings sidebar title row changes from a title with a close button at the far right to a back button followed by the title, so the navigation reads as `← Settings` and returns to the prior app view.

The Connection page should apply a bearer token when the operator commits the field. The page keeps one write-only token field and a status line, removes the Test connection, Save, and Cancel controls, and checks then stores a typed token on `Enter` or an in-document blur. A rejected token stays visible with an inline fix and does not change the app-wide authorization state.

## Why

Operators should not have to reason about a one-field form with separate test and save steps. Testing and saving are the same intent here: make this token the app credential if the control plane accepts it. Applying the token on commit also matches the immediate-apply behavior planned for other simple settings pages.

The back button makes settings navigation clearer. It communicates that settings is a place in the shell, preserves the existing close behavior, and keeps the keyboard layer order unchanged.

## Personas

- **Enzo (Engineer)** configures local and fake-mode control-plane access, validates that runs load, and needs fast recovery from a mistyped token.
- **Phoebe (PM)** opens settings during review or demos and expects navigation to feel consistent with the shell rather than modal.
- **Dani (Designer)** reviews the settings frame for alignment, focus, and keyboard behavior against the design system.

## Narratives

### Correcting a wrong token

Enzo opens Settings with `Cmd+,` or `Ctrl+,` and lands on Connection. The sidebar title starts with a back arrow and the Settings label, so he knows the control returns him to the shell. The Connection page shows only the write-only bearer token field and an empty status line because no token is being checked.

He pastes an old token and presses `Enter`. The status changes to `Checking`, then `Failed` with the existing one-line fix for a rejected token. The token remains in the field, the app-wide authorization state does not change, and he can edit the same value instead of starting over.

Enzo replaces it with the fake-mode token and tabs away. The in-document blur commits the value, the check succeeds, the token is stored, the field clears, and the status reads `Connected`. He clicks Back and returns to the runs list, which now loads with the accepted token.

### Copying the rest of a token

Phoebe starts typing a token and switches to a password manager or terminal to copy the rest. The browser blurs the field because the window lost focus, but Connection does not commit the partial value. When she returns and finishes the token, the field still contains her draft and no failed check has been sent.

She can then press `Enter`, tab to another control, click the page background, click another settings row, or click Back to commit the complete token. Only blurs that keep focus inside the document, or move focus to the document body from an in-page click, count as commit intent.

### Checking locks the field briefly

Enzo presses `Enter` and the field changes to a read-only busy state while `Checking` is visible. It keeps focus, shows the existing loading affordance, and ignores duplicate `Enter` or blur commits until the request settles. Because the local check is expected to be brief, typo correction happens after the result: `Failed` returns the typed value to an editable field, and `Connected` clears the accepted value.

### Leaving after committing

Phoebe types a token and clicks Back. The blur starts a check, and settings does not leave while `Checking` is visible. Back and settings-row navigation are temporarily disabled or ignore activation until the check finishes, so the result is always visible on the Connection page.

If the token is wrong, she sees `Failed` and the fix before she can leave. If the token is accepted, the token is stored, `Connected` is shown, and Back can then return her to the runs list.

## User stories

- Enzo can use a Back button in the settings sidebar title row to leave settings the same way the old close button did.
- Enzo can type or paste a bearer token and press `Enter` to check and store it in one step.
- Enzo can tab or click within the page away from a non-empty token field and have that in-document blur commit the token.
- Enzo can switch windows while a partial token is typed without committing the partial value.
- Enzo sees the field become read-only and busy while a check is in flight, keeping focus without accepting more typing until the result appears.
- Enzo can see `Checking`, `Connected`, or `Failed` status without the secret value appearing in text, names, logs, or URLs.
- Enzo can recover from a rejected token because the typed value stays in the field and the app-wide authorization remains unchanged.
- Phoebe can press `Escape` in a non-empty token field to clear the draft token and status without closing settings or sending a request.
- Phoebe can press `Escape` in an empty field and keep the existing shell layer behavior.
- Phoebe can click Back after a commit result is visible, so a failed token is not hidden by navigation.
- Dani can verify that the settings title row still aligns with the header title row and that keyboard focus is visible and ordered.

## Goals

- Replace the settings sidebar close affordance with a keyboard-reachable `Back` icon button that uses the existing settings close handler and `close-layer` key hint.
- Remove Connection page action buttons and apply non-empty typed tokens on `Enter` or blur only when focus remains in the document.
- Ignore window-loss blur so partial tokens are not sent while an operator switches to another app.
- Make the token field read-only and busy while a check is in flight, using the existing `Input loading` behavior.
- Guard the shared shell close path while a check is in flight so failed leave attempts remain visible.
- Preserve write-only secret guarantees: never render, name, log, or place the token in a URL.
- Prevent rejected tokens from mutating the app-wide authorization state.
- Cover the changed behavior with unit and Playwright tests, including fake mode on the production path.
- Update agent-facing documentation that describes settings, Connection, and navigation.

## Non-goals

- No control to clear or delete the stored token.
- No change to Projects credentials, including its Test credentials, Save, and Cancel controls.
- No change to where Settings appears in the primary sidebar.
- No re-check of the stored token on page load.
- No new control-plane endpoint or bearer-token persistence backend.
- No global toast or out-of-page failure surface for Connection checks; the shared settings close path blocks leaving instead.

## Design spec

### User flows

```mermaid
graph TD
    A[Operator opens Settings] --> B[Settings sidebar title row shows Back button then Settings]
    B --> C{Connection check in flight?}
    C -- No --> D[Operator activates Back]
    D --> E[Call existing onCloseSettings handler]
    E --> F[Return to the same destination as the old close button]
    C -- Yes --> G[Shared closeSettings guard refuses to leave]
    G --> H[Back appears soft-disabled and operator sees Checking until result appears]
```

```mermaid
graph TD
    A[Operator focuses bearer token field] --> B{Typed value?}
    B -- No --> C[Status line remains empty]
    B -- Yes --> D{Commit action}
    D -- Enter --> E[Start token check with committed value]
    D -- In-document blur by tab, click, row change, or Back --> E
    D -- Window loses focus --> F[Ignore blur and keep draft]
    D -- Escape --> G[Clear field and status; send no request]
    E --> H[Show Checking and make field read-only busy]
    H --> I{Control plane accepts committed value?}
    I -- Yes --> J[Store value, clear field, show Connected]
    I -- No --> K[Store nothing, keep value, show Failed with fix]
```

### Key UI components

#### Settings sidebar title row

- The row contains an `ArrowLeft` icon button followed by the text `Settings`.
- The former right-aligned `X` close button is removed.
- The button accessible name is `Back`.
- The tooltip label is `Back` and includes the key hint for the registry `close-layer` action.
- Activation calls the existing `onCloseSettings` behavior, which routes through the guarded shell `closeSettings` function.
- While Connection is checking, Back appears soft-disabled with `aria-disabled`, but remains focusable like the existing in-flight pattern. Activation reaches the guarded close path and settings remains open until `Connected` or `Failed` is visible.
- The row keeps the current header/title row vertical edges and text baseline alignment rules.
- The tab order starts with the Back button, then the Connection row. If Back is disabled while checking, the disabled state must be accessible and must not create a keyboard trap.

#### Connection page

- The page contains the existing write-only secret field and a status line.
- The page does not render Test connection, Save, Cancel, or Saved controls/text.
- With no stored token, the label is `Bearer token`; with a stored token, the label is `Bearer token (leave blank to keep existing)`.
- The stored token is never placed in the field.
- The field is not `required` on this page, or the surrounding form uses `noValidate`, so `Enter` in an empty field does not show a native browser validation bubble.
- `Enter` is handled once, preferably in the input `onKeyDown`, with `preventDefault` for the commit key. The form may still prevent default submit as a defensive fallback, but it must not create a second commit path.
- Empty typed values do not commit and do not send a request.
- A non-empty typed value commits on `Enter` or an in-document blur.
- A blur caused by the browser window or tab losing focus does not commit. Implementation checks `document.hasFocus()` and the blur target/active element: ignore blur when `document.hasFocus()` is false or when `document.activeElement` is still the field; commit when focus moves to another element in the document or to `document.body` from an in-page click.
- During commit, the status line shows `Checking`; the field passes `loading` to the shared input, which sets `aria-busy`, shows the trailing spinner, and makes the control read-only rather than disabled so focus stays in place. Duplicate `Enter` and blur triggers are ignored while the request is in flight.
- Each commit reads the field value once when it starts. Completion applies to that value.
- On success, `connection.setToken(committedValue)` runs once, the field clears, and `Connected` is shown.
- On failure, the page stores nothing, keeps the committed value in the field, returns the field to editable, and shows `Failed` with the existing fix.
- `Connected` stays visible until the operator edits the field or leaves the page.
- `Failed` and its fix stay visible until the field is edited, the field is cleared with `Escape`, or a new check starts.
- A new commit replaces the previous result with `Checking`, then the new final result.

#### Write-only secret field component

- `WriteOnlySecretField` remains the shared write-only field used by Connection and future Projects credentials.
- The component receives additive optional input event props, such as `onBlur` and `onKeyDown`, or equivalently named commit/escape callbacks. They default to doing nothing.
- The component also forwards an optional `loading` prop to the underlying `Input` so Connection can use the existing read-only busy state while checking.
- The component forwards these optional handlers and loading state to the underlying `Input` without changing existing callers.
- Existing props, including `required`, remain available for forms such as Projects, but Connection opts out of native required validation.

### Keyboard and layer behavior

- `Escape` in the token field with typed text clears the field, clears `Connected`/`Failed` status, and stops propagation so no layer closes. While `Checking`, `Escape` is ignored: the field is read-only and the check in flight cannot be cancelled, so it clears neither the field nor the status.
- `Escape` in the empty token field follows the existing layer order: confirm popover, overlay, full page, then settings.
- Back-button navigation, settings-row navigation, `Cmd+,`/`Ctrl+,`, and empty-field `Escape` all route through the shared shell close path. If a check starts, the shared guard keeps settings open until the check finishes.
- Focus rings remain visible on the Back button and field.

## Tech spec

### Introduction and overview

This feature modifies the existing web shell settings sidebar, the shared write-only secret field, and the Connection page. It depends on issue #132 for the settings frame and Connection page, the current action registry for `close-layer` key hints, and the existing `useControlPlaneConnection` provider API with `createTestClient(token)`, `listProjects`, and `setToken`. It does not add API routes, persistence tables, or SDK methods.

Technical goals:

- Reuse the existing close-settings path so Back is behaviorally identical to the old close button when no token check is pending.
- Use the throwaway client for token validation so a bad typed token cannot change app-wide authorization.
- Ignore window-loss blur so partial tokens are not sent to the control plane.
- Keep settings mounted through the shared `closeSettings` guard while a check is pending so a failed commit is visible before the operator leaves.
- Guard page-local state updates after unmount for non-checking teardown and defensive cleanup.
- Keep token values out of status strings, accessible names, URLs, and logs.

Glossary:

- **Commit**: an attempt to validate and, on success, store a typed token committed value.
- **Committed value**: the exact field value captured when a commit starts.
- **Typed token**: the value currently in the write-only field; never the stored token.
- **In-document blur**: a blur where focus remains in the document, either on another element or `document.body` after an in-page click.
- **Throwaway client**: the client returned by `connection.createTestClient(typed)` for checking a token without changing app-wide authorization.

### System design and architecture

```mermaid
graph LR
    Sidebar[SettingsNav in apps/web/src/shell/sidebar.tsx] --> Registry[Action registry close-layer hint]
    Sidebar --> Close[Guarded closeSettings in shell-layout.tsx]
    Shortcuts[Cmd+, Ctrl+, Escape close-layer] --> Close
    Close --> Pending[settingsCheckPending from shell connection-state context]
    ConnectionPage[ConnectionPage] --> SecretField[WriteOnlySecretField with handlers and loading]
    ConnectionPage --> Provider[useControlPlaneConnection]
    Provider --> TestClient[createTestClient committed value]
    TestClient --> API[listProjects]
    Provider --> Store[setToken on success]
```

Shell pending-state design:

- Add `settingsCheckPending` to the shell-level connection-state context in `apps/web/src/shell/connection-state.tsx`, following the existing connection indicator sharing pattern.
- The Connection page is the only writer for this flag and sets it true while `Checking`, then false on success, failure, empty cleanup, or unmount cleanup.
- `closeSettings` in `apps/web/src/shell/shell-layout.tsx` is the single guard point. If `settingsCheckPending` is true, it returns without closing settings. This covers Back, settings toggle shortcuts, and close-layer Escape because they all flow through `closeSettings`.
- The browser's own Back button cannot be blocked by this app-level guard. The Connection page still protects against state updates after unmount for browser navigation, tab close, route replacement, and forced test unmounts.

Modified components:

- `apps/web/src/shell/sidebar.tsx`: replace the settings title row close button with an `ArrowLeft` back button before the title, keep `onCloseSettings`, update accessible name and tooltip, and show Back as soft-disabled with `aria-disabled` while Connection reports `Checking`.
- `apps/web/src/settings/connection-page.tsx`: replace form/action-row state with commit-on-enter/in-document-blur state, remove Test connection/Save/Cancel/Saved rendering, opt out of native required validation, set shell-level `settingsCheckPending` while checking, pass `loading` to the secret field, and update the file comment.
- `apps/web/src/ui/write-only-secret-field.tsx`: add optional event handlers and `loading`, then forward them to the input without breaking existing callers.
- Existing tests for sidebar, write-only secret field, and Connection page: rename queries from `Close settings` to `Back` and assert the new flow.
- Playwright fake-mode test: exercise wrong token failure then `fake-mode-token` success through the production path.
- `context-agent/wiki/design-system.md` and `context-agent/wiki/code-map.md`: document the changed pattern and file flow during implementation.

Primary commit sequence:

```mermaid
sequenceDiagram
    participant Operator
    participant Field as WriteOnlySecretField
    participant Page as ConnectionPage
    participant Conn as ControlPlaneConnection
    participant Client as Throwaway client

    Operator->>Field: Type token and press Enter or in-document blur
    Field->>Page: commit current value
    Page->>Conn: createTestClient(committed value)
    Page->>Page: show Checking, set settingsCheckPending, make field read-only busy
    Conn-->>Page: client
    Page->>Client: listProjects()
    alt accepted
        Client-->>Page: projects response
        Page->>Conn: setToken(committed value)
        Page->>Page: clear field, clear settingsCheckPending, show Connected
    else rejected or unavailable
        Client-->>Page: 401, other status, or network error
        Page->>Page: keep value, clear settingsCheckPending, show Failed + failureFix
    end
```

### Detailed design

No data model or API contract changes are required. The existing `listProjects` check remains the validation call. The existing failure mapping remains authoritative, including `401`, other status, and network or no-answer cases.

Connection page logic:

1. Track the typed field value, status state, failure fix text, stored-token presence, and whether a check is in flight.
2. Add optional input event props to `WriteOnlySecretField` and pass Connection handlers through to the underlying `Input`.
3. Opt Connection out of native required validation by dropping `required` for this page or setting `noValidate` on the form. Empty `Enter` sends no request and shows no native validation bubble.
4. Handle `Enter` in the input `onKeyDown` as the single intended commit path. Prevent default, ignore empty values, and commit the current value if no matching request is already in flight. Keep form `onSubmit` as prevent-default only if the form remains.
5. Handle blur by first deciding whether it is a commit blur. Ignore blur when `document.hasFocus()` is false, when `document.activeElement` is still the input, or when the value is empty. Commit when focus moves to another document element or to `document.body` because of an in-page click.
6. On commit, read the current field value once and call `connection.createTestClient(committedValue)` and then `listProjects`.
7. While a check is in flight, show `Checking`, pass `loading` to `WriteOnlySecretField`, and set shell-level `settingsCheckPending` through the connection-state context. The underlying `Input loading` behavior sets `aria-busy`, shows the trailing spinner, and makes the input read-only rather than disabled so focus is not lost.
8. On success, call `connection.setToken(committedValue)` exactly once, clear the field, clear `settingsCheckPending`, and show `Connected`.
9. On failure, do not call `connection.setToken`. Keep the committed value, clear `settingsCheckPending`, return the field to editable, show `Failed`, and show unchanged `failureFix`.
10. `Connected` remains until the operator edits the field or leaves the page. `Failed` and its fix remain until the field is edited, cleared with `Escape`, or a new check starts. `Checking` replaces any previous result during a new request.
11. `Escape` with a typed value clears the field and clears `Connected` or `Failed` status, sends no request, and stops propagation. While `Checking`, `Escape` is ignored because the request in flight cannot be cancelled and the field is read-only. `Escape` with an empty value falls through to existing layer handling.
12. Use an unmount guard as a defensive measure. The browser's own Back button cannot be blocked by the app-level guard, so this defensive cleanup covers browser navigation, tab close, route replacement, and test-forced unmounts.

Back button logic:

1. Import and render `ArrowLeft` using the project icon conventions.
2. Put the button before `Settings` in the settings sidebar title row.
3. Remove the right-side close button.
4. Use accessible name `Back`.
5. Use tooltip text `Back` plus the formatted key hint from the `close-layer` registry action.
6. Call the existing `onCloseSettings` handler on click and keyboard activation. The shared `closeSettings` function in `shell-layout.tsx` checks `settingsCheckPending` and refuses to close while a token check is pending.
7. Apply the same shared guard to `Cmd+,`/`Ctrl+,` toggle settings and empty-field `Escape` close-layer paths because they also reach `closeSettings`. The browser's own Back button is not blockable, so the Connection page still uses defensive unmount cleanup.

### Security, privacy, and compliance

- The typed token is sensitive. It must not appear in status text, accessible names, URLs, log lines, test names that include runtime values, or thrown error messages.
- Window-loss blur must not commit because operators commonly switch to a password manager, terminal, or another app while a partial token is typed. This avoids needless rejected-token requests and reduces the chance that partial bearer tokens appear in control-plane access logs.
- A rejected token must not change the app-wide authorization state. The throwaway client remains the only validation path before `setToken`.
- The field remains write-only: no reveal button, no stored badge, no clear/delete stored-token control, and no populated stored value.
- Unit and E2E tests must avoid real model calls and use fake mode or mocked clients only.

### Observability

No new telemetry is required. If existing error logging runs during failed checks, it must use sanitized messages that do not include the typed token. Status text remains user-facing and generic: `Checking`, `Connected`, or `Failed` plus the existing one-line fix.

### Testing plan

Unit/component tests:

- Settings sidebar renders `Back`, no `Close settings`, uses the `close-layer` hint, and has the expected tab order.
- Back activation calls the same settings close path as before when no check is pending.
- Back and settings-row activation while `Checking` do not leave Connection; a wrong token followed by Back leaves the operator seeing `Failed` and the fix.
- `Cmd+,`/`Ctrl+,` during `Checking` do not leave settings, and work again after the check settles.
- Empty-field `Escape` during `Checking` does not leave settings, and works again after the check settles.
- A good token followed by Back stores the token, then allows leaving settings so the runs list loads.
- `WriteOnlySecretField` forwards new optional `onBlur` and `onKeyDown` handlers to the input and existing callers can omit them.
- Connection page renders no Test connection, Save, Cancel, or Saved controls.
- `Enter` with a typed value calls `createTestClient(committed value)`, calls `listProjects`, then calls `connection.setToken(committed value)` once on success.
- `Enter` in an empty field shows no native validation message and sends no request.
- In-document blur with a typed value commits exactly once; empty values send no request.
- A blur dispatched while `document.hasFocus()` is false sends no request.
- A blur with focus moving to another element sends exactly one request.
- 401, other-status, and network failures show `Failed` and the fix, keep the typed value, call no `setToken`, and do not mutate app-wide authorization.
- While checking, repeated `Enter` and blur do not start a second request.
- While checking, the token field is read-only, keeps focus, exposes `aria-busy`, and shows the loading spinner.
- No field change during a check results in exactly one request.
- Edit after `Connected` clears the status.
- `Escape` after `Failed` clears the status and the field.
- A new commit replaces the previous result with `Checking` and then the new result.
- `Escape` with a typed value clears the field and makes no request; `Escape` with an empty field keeps existing layer behavior.
- `Escape` while `Checking` does not clear the field or the status.
- Unmount during an in-flight check, if forced directly by a test harness, does not set page-local state after unmount.
- Existing secret-safety tests continue to pass.

Playwright test:

- In fake mode on the production path, open Settings, type a wrong token, press `Enter`, assert `Failed` plus the fix, then type `fake-mode-token`, press `Enter` or tab, assert `Connected`, and verify the run list works after Back. The test must not use a test-only hook and must make no model call.

Documentation checks:

- Update `context-agent/wiki/design-system.md` Settings pages and write-only secret field rules.
- Update `context-agent/wiki/code-map.md` with the changed Connection flow.
- Update the Connection page file comment.

### Alternatives considered

- Keep Test connection plus Save: rejected because it preserves unnecessary ceremony for one field and differs from simple settings that apply at once.
- Save first, then test stored authorization: rejected because a bad token would temporarily change app-wide authorization, which is exactly what testing is meant to prevent.
- Commit every blur, including window-loss blur: rejected because copying tokens from another app is normal and this would send partial tokens.
- Surface after-unmount failures in a global toast or runs-list status: rejected for this feature because settings can simply block leaving until the commit result is visible.
- Add a clear/delete stored-token control: rejected because the design system intentionally has no stored-token clear control for this secret field.

### Risks

- Browser focus behavior differs across test environments. Mitigation: centralize commit-blur detection and cover `document.hasFocus()`, active element, body focus, tab, and click cases.
- `Enter` followed by blur may accidentally double-submit if event ordering is not guarded. Mitigation: use an in-flight marker and ignore duplicate commits while checking.
- Read-only while checking may surprise operators who try to fix a typo immediately. Mitigation: use the existing `Input loading` read-only busy state so focus remains in place, and restore editability as soon as `Failed` appears.
- Blocking settings close while checking can feel unresponsive on a slow control plane. Mitigation: show `Checking`, keep focus stable, show Back as `aria-disabled`, and guard the shared close path only for the short validation window.
- Tooltip/key-hint formatting may depend on existing registry hooks. Mitigation: reuse the current action registry and tooltip helpers rather than hard-coding platform chords.

## Task list

- [ ] **Story: Settings sidebar back navigation**
  - [ ] **Task: Replace settings close button with Back button**
    - **Description**: Update `apps/web/src/shell/sidebar.tsx` so the settings title row renders an `ArrowLeft` icon button before the `Settings` title and removes the right-aligned close button. Wire the button to the existing `onCloseSettings` handler when Connection is not checking.
    - **Acceptance criteria**:
      - [ ] The settings title row renders an `ArrowLeft` icon button followed by `Settings`.
      - [ ] No right-side `Close settings` button remains.
      - [ ] The button accessible name is `Back`.
      - [ ] Activating the button leaves settings exactly as the previous close button did when no Connection check is in flight.
      - [ ] The tooltip label is `Back` and includes the registry `close-layer` key hint.
    - **Dependencies**: None
  - [ ] **Task: Guard the shared settings close path while Connection is checking**
    - **Description**: Add a shell-level `settingsCheckPending` flag in `shell/connection-state.tsx`, have Connection write it while checking, and have `closeSettings` in `shell-layout.tsx` refuse to close while it is true. Show Back as soft-disabled with `aria-disabled` while the shared guard is active.
    - **Acceptance criteria**:
      - [ ] Clicking Back during `Checking` does not leave settings.
      - [ ] Clicking another settings row during `Checking` does not hide the pending Connection result.
      - [ ] Pressing `Cmd+,` or `Ctrl+,` during `Checking` does not leave settings.
      - [ ] Pressing `Escape` from an empty field during `Checking` does not leave settings.
      - [ ] After the check settles, `Cmd+,`/`Ctrl+,` and empty-field `Escape` close settings again.
      - [ ] Back is focusable and marked `aria-disabled` while checking.
      - [ ] A wrong token followed by Back leaves the operator seeing `Failed` and the fix.
      - [ ] A good token followed by Back stores the token and then allows the runs list to load after the check completes.
    - **Dependencies**: `Task: Replace settings close button with Back button`, `Task: Implement commit-on-enter and commit-on-valid-blur`
  - [ ] **Task: Preserve settings row alignment and keyboard order**
    - **Description**: Adjust sidebar title-row layout only as needed so the row keeps the design-system top/bottom edges, text baseline, focus visibility, and tab order.
    - **Acceptance criteria**:
      - [ ] The settings title row aligns with the header title row with the sidebar open and closed.
      - [ ] The Back button has a visible focus ring.
      - [ ] The Back button is keyboard reachable when enabled.
      - [ ] The settings sidebar tab order is Back, then Connection.
    - **Dependencies**: `Task: Replace settings close button with Back button`
  - [ ] **Task: Update sidebar tests for Back and pending checks**
    - **Description**: Update existing sidebar and shell tests that query `Close settings` so they assert the new Back button behavior and no stale close button name. Add pending-check navigation tests.
    - **Acceptance criteria**:
      - [ ] Tests that previously found `Close settings` now find `Back`.
      - [ ] Tests assert activation calls the existing settings close path when enabled.
      - [ ] Tests cover Back being disabled or ignored while Connection is checking.
      - [ ] Tests cover the tooltip/key-hint expectation where current test helpers support it.
    - **Dependencies**: `Task: Guard the shared settings close path while Connection is checking`

- [ ] **Story: Write-only secret field event support**
  - [ ] **Task: Add optional input handlers and loading to WriteOnlySecretField**
    - **Description**: Extend `apps/web/src/ui/write-only-secret-field.tsx` with additive optional handlers such as `onBlur` and `onKeyDown`, or equivalent commit/escape callbacks, plus optional `loading`, and forward them to the underlying `Input`. Defaults must preserve existing callers.
    - **Acceptance criteria**:
      - [ ] Existing props and behavior remain compatible.
      - [ ] Optional blur and key handlers are forwarded to the input.
      - [ ] Optional `loading` is forwarded to the input.
      - [ ] When `loading` is true, the input uses the existing read-only busy behavior with `aria-busy`.
      - [ ] Callers can omit the new props without behavior changes.
      - [ ] A unit test proves the new handlers fire for consumers such as Connection and future Projects credentials.
    - **Dependencies**: None

- [ ] **Story: Connection token applies on commit**
  - [ ] **Task: Remove Connection form action controls and native required validation**
    - **Description**: Update `apps/web/src/settings/connection-page.tsx` so the page renders only the write-only token field and status line, with no Test connection, Save, Cancel, or Saved UI. Opt out of native required validation for this page.
    - **Acceptance criteria**:
      - [ ] The page has the bearer token field and a status line.
      - [ ] Test connection, Save, Cancel, and Saved text are not rendered.
      - [ ] The field is not `required` on this page or the form uses `noValidate`.
      - [ ] Pressing `Enter` in an empty field shows no native validation bubble.
      - [ ] With no stored token, no typed value, and no check, the status line is empty.
      - [ ] Existing tests that asserted removed controls are updated with equivalent coverage of the new commit behavior.
    - **Dependencies**: `Task: Add optional input handlers and loading to WriteOnlySecretField`
  - [ ] **Task: Implement commit-on-enter and commit-on-valid-blur**
    - **Description**: Add commit logic that checks a non-empty typed token on `Enter` or valid in-document blur using `connection.createTestClient(committed value)` and `listProjects`. Ignore empty values and window-loss blur.
    - **Acceptance criteria**:
      - [ ] Pressing `Enter` with a typed value makes one check with that value.
      - [ ] `Enter` is handled once through input key handling, with form submit only preventing default if the form remains.
      - [ ] Blurring with focus moving to another element in the document makes exactly one check.
      - [ ] Blurring to `document.body` from an in-page click makes exactly one check.
      - [ ] Dispatching blur while `document.hasFocus()` is false sends no request.
      - [ ] Blur is ignored when `document.activeElement` is still the field.
      - [ ] An empty field makes no request.
      - [ ] The check uses the throwaway client and does not mutate app-wide authorization before success.
    - **Dependencies**: `Task: Remove Connection form action controls and native required validation`
  - [ ] **Task: Store successful committed values and clear the field**
    - **Description**: On successful `listProjects`, store the committed value through `connection.setToken`, clear the field, clear shell pending state, and show `Connected`.
    - **Acceptance criteria**:
      - [ ] `connection.setToken` is called once with the committed value after a successful check.
      - [ ] The field is emptied after success.
      - [ ] The status line shows `Connected`.
      - [ ] The label becomes `Bearer token (leave blank to keep existing)` when a token was not already stored.
      - [ ] Shell `settingsCheckPending` is cleared after success.
      - [ ] Unit tests cover the successful path.
    - **Dependencies**: `Task: Implement commit-on-enter and commit-on-valid-blur`
  - [ ] **Task: Handle rejected and unavailable token checks**
    - **Description**: Preserve existing failure mapping and show `Failed` plus `failureFix` without storing a rejected token. Keep the committed value editable after the failed check.
    - **Acceptance criteria**:
      - [ ] A 401 check shows `Failed` and the rejected-token fix.
      - [ ] Other status failures show `Failed` and the appropriate existing fix.
      - [ ] Network or no-answer failures show `Failed` and the existing control-plane-did-not-answer message/fix.
      - [ ] `connection.setToken` is not called on failure.
      - [ ] The committed value remains in the field and becomes editable again on failure.
      - [ ] Shell `settingsCheckPending` is cleared after failure.
      - [ ] App-wide authorization state does not change on failure.
      - [ ] Unit tests cover 401, another status, and a network error.
    - **Dependencies**: `Task: Implement commit-on-enter and commit-on-valid-blur`
  - [ ] **Task: Define status lifecycle and Escape reset**
    - **Description**: Implement status lifetime rules so results are not stale or contradictory as the operator edits, clears, or starts another commit.
    - **Acceptance criteria**:
      - [ ] `Checking` appears while a request is in flight.
      - [ ] `Connected` stays until the operator edits the field or leaves the page.
      - [ ] Editing after `Connected` clears the status.
      - [ ] `Failed` and its fix stay until the field is edited, cleared with `Escape`, or a new check starts.
      - [ ] `Escape` after `Failed` clears both the field and the status.
      - [ ] A new commit replaces the previous result with `Checking`, then the new final result.
      - [ ] Unit tests cover each status lifecycle rule.
    - **Dependencies**: `Task: Store successful committed values and clear the field`, `Task: Handle rejected and unavailable token checks`
  - [ ] **Task: Guard duplicate commits, read-only checking state, and defensive unmounts**
    - **Description**: Add in-flight handling so duplicate events do not start duplicate checks, the field uses read-only busy state while checking, and page-local state is not set after browser Back or forced unmounts.
    - **Acceptance criteria**:
      - [ ] While a check is in flight, a second `Enter` does not start a second request.
      - [ ] While a check is in flight, a blur does not start a second request.
      - [ ] The field is read-only and has `aria-busy` while `Checking`.
      - [ ] Focus remains on the field while it is read-only busy.
      - [ ] A unit test that simulates browser Back or forcibly unmounts during a check observes no state-after-unmount failure.
    - **Dependencies**: `Task: Store successful committed values and clear the field`, `Task: Handle rejected and unavailable token checks`
  - [ ] **Task: Implement Escape clearing behavior**
    - **Description**: Update field keyboard handling so `Escape` clears a non-empty typed token and status and sends no request, while empty-field `Escape` keeps the existing shell layer behavior.
    - **Acceptance criteria**:
      - [ ] `Escape` with a typed value empties the field.
      - [ ] `Escape` with a typed value clears `Connected` or `Failed` status.
      - [ ] `Escape` with a typed value makes no request.
      - [ ] `Escape` while `Checking` is ignored: it clears neither the field nor the status.
      - [ ] `Escape` with an empty field closes the top layer as before.
      - [ ] Unit tests cover non-empty Escape, Escape after `Failed`, Escape while `Checking`, and empty Escape behavior.
    - **Dependencies**: `Task: Define status lifecycle and Escape reset`
  - [ ] **Task: Preserve write-only secret safety**
    - **Description**: Audit status text, labels, accessible names, errors, request paths, and new tests touched by the flow so the typed token never appears outside the password input value.
    - **Acceptance criteria**:
      - [ ] The token never appears in status text.
      - [ ] The token never appears in an accessible name.
      - [ ] The token never appears in a log line or URL in the changed code paths.
      - [ ] Window-loss blur sends no partial token request.
      - [ ] Existing secret-safety tests pass.

- [ ] **Story: End-to-end coverage in fake mode**
  - [ ] **Task: Add production-path Playwright coverage for token commit**
    - **Description**: Add or update a Playwright test that starts fake mode, opens Settings, rejects a wrong token, accepts `fake-mode-token`, and verifies the run list works without using test-only hooks.
    - **Acceptance criteria**:
      - [ ] The test types a wrong token and sees `Failed` with the fix.
      - [ ] The test then types `fake-mode-token`, commits it, and sees `Connected`.
      - [ ] The test verifies a working run list after Back.
      - [ ] The test uses the production path and no test-only hook.
      - [ ] The test makes no model call.
    - **Dependencies**: `Task: Guard the shared settings close path while Connection is checking`, `Task: Store successful committed values and clear the field`, `Task: Handle rejected and unavailable token checks`

- [ ] **Story: Documentation and code map updates**
  - [ ] **Task: Update settings design-system documentation**
    - **Description**: Update `context-agent/wiki/design-system.md` so Settings pages describe the title row as Back plus title, Connection as apply-on-commit with valid blur behavior, and Projects as the form page that keeps test/action-row controls. Update the write-only secret field rule to say the field empties after a successful check when the field still contains the checked value.
    - **Acceptance criteria**:
      - [ ] Settings pages document the Back button and title row.
      - [ ] Connection documents commit on `Enter` or valid in-document blur and no action row.
      - [ ] Connection documents ignoring window-loss blur.
      - [ ] Connection documents checking-state navigation blocking.
      - [ ] Projects keeps the form-page test button and action-row rules.
      - [ ] The write-only secret field section says the field empties after a successful check when the field still contains the checked value.
    - **Dependencies**: `Task: Guard the shared settings close path while Connection is checking`, `Task: Remove Connection form action controls and native required validation`
  - [ ] **Task: Update code map and Connection page comment**
    - **Description**: Update `context-agent/wiki/code-map.md` and the file comment in `apps/web/src/settings/connection-page.tsx` so future agents can find and understand the apply-on-commit flow, valid blur rule, read-only checking state, shell pending flag, and shared close-path guard.
    - **Acceptance criteria**:
      - [ ] The code map mentions Back navigation in `sidebar.tsx`.
      - [ ] The code map mentions Connection commit-on-enter/valid-blur, ignored window-loss blur, throwaway-client check, success store, failure no-store behavior, read-only busy checking state, and shared close-path guard.
      - [ ] The Connection page file comment describes the write-only apply-on-commit flow.
    - **Dependencies**: `Task: Store successful committed values and clear the field`, `Task: Handle rejected and unavailable token checks`, `Task: Guard the shared settings close path while Connection is checking`

## Acceptance criteria

### Back button

- [ ] The settings sidebar's title row shows an `ArrowLeft` icon button, then the title `Settings`, and no button at the right. The button's accessible name is `Back` and its tooltip is `Back` with the `close-layer` key from the registry. Activating it leaves settings exactly as the close button did when no token check is in flight.
- [ ] While Connection shows `Checking`, the shell-level `settingsCheckPending` flag makes `closeSettings` refuse to close. Back is soft-disabled with `aria-disabled`, settings rows cannot hide the pending result, `Cmd+,`/`Ctrl+,` cannot close settings, and empty-field `Escape` cannot close settings. After the check settles, those close paths work again.
- [ ] The title row's top and bottom edges and its text baseline still equal the header title row's alignment rules, with the sidebar open and closed.
- [ ] The button has a visible focus ring and is reachable by keyboard when enabled. The settings sidebar's tab order is the back button, then the Connection row.
- [ ] Existing tests that find the `Close settings` button use the new name.

### Connection page

- [ ] The page has the token field and a status line, and no Test connection, Save or Cancel button and no `Saved` text.
- [ ] `WriteOnlySecretField` supports additive optional input event handlers for blur and keydown plus optional `loading`, defaulting to no behavior change for other callers.
- [ ] Connection opts out of native required validation, so pressing `Enter` in an empty field shows no browser validation bubble and sends no request.
- [ ] Pressing `Enter` in the field with a typed value makes one check with that typed token.
- [ ] Moving focus out of the field with a typed value makes one check only when focus moves to another element in the document or to `document.body` from an in-page click.
- [ ] A blur fired while `document.hasFocus()` is false, or while `document.activeElement` is still the field, sends no request.
- [ ] A check that succeeds stores the token, empties the field, shows `Connected`, clears `settingsCheckPending`, and the label becomes `Bearer token (leave blank to keep existing)` if it was not already. A unit test shows `connection.setToken` called once with the typed value.
- [ ] While `Checking`, the field is read-only, keeps focus, exposes `aria-busy`, and shows the existing loading spinner through `Input loading`.
- [ ] A check that fails with a `401` shows `Failed` and the rejected-token fix, stores nothing, keeps the typed value in the field, clears `settingsCheckPending`, returns the field to editable, and does not change the app-wide authorization state. Unit tests cover `401`, another status, and a network error.
- [ ] While a check is in flight the status line shows `Checking`, a second `Enter` or blur does not start a second request, and the field stays focused but read-only.
- [ ] `Connected` stays until the field is edited or the operator leaves the page. `Failed` and its fix stay until the field is edited, cleared with `Escape`, or a new check starts. A new commit replaces the previous result.
- [ ] `Escape` in the field with a typed value empties it, clears the status, and makes no request. With an empty field it behaves as before and closes the top layer.
- [ ] Clicking Back, pressing `Cmd+,`/`Ctrl+,`, pressing empty-field `Escape`, or clicking another settings row with a typed value commits through a valid in-document blur and then the shared close guard waits for the result; failed checks remain visible on Connection, and successful checks store the token before the operator leaves. The browser's own Back button cannot be blocked, and defensive unmount cleanup covers that path.
- [ ] With no stored token, no typed value and no check, the status line is empty. The token never appears in the status text, an accessible name, a log line or a URL.
- [ ] A Playwright test against fake mode on the production path types the wrong token and sees `Failed` with the fix, then types `fake-mode-token`, presses `Enter` and sees `Connected` and a working run list after Back. It uses no test-only hook.
- [ ] Existing tests that assert the Test connection, Save, Cancel or `Saved` controls are updated, and none is deleted without an equivalent.
- [ ] No test makes a model call.

### Docs

- [ ] `context-agent/wiki/design-system.md` Settings pages is updated: the settings sidebar's title row is a back button and the title, and the Connection page is documented as applying on commit. The form-page rules, test button, and action row stay for Projects. The write-only secret field's `After a save, the field empties` rule says `after a successful check when the field still contains the checked value`.
- [ ] `context-agent/wiki/code-map.md` and the Connection page's file comment describe the flow, including valid blur, ignored window-loss blur, read-only busy checking state, `settingsCheckPending`, and shared close-path guarding.

## How to try it

1. Start fake mode using `docs/operators/fake-mode.md`, open `http://127.0.0.1:4010`, and open Settings with `Cmd+,` or `Ctrl+,`. The sidebar's top row reads `← Settings`.
2. On Connection, type half a token, switch to another app, and return. Nothing is sent and the field still has your draft.
3. Type a wrong token and press `Enter`. The status shows `Failed` and a fix, and the field keeps your text. Press `Escape`; the field and status clear.
4. Type `fake-mode-token`, then press `Tab`. The status shows `Connected` and the field is empty.
5. Type something and press `Enter`. While `Checking` is visible, the field keeps focus but is read-only and busy; wait for `Failed` before editing.
6. Type a wrong token and click Back. Settings stays on Connection until `Failed` is visible. Replace it with `fake-mode-token`, commit, wait for `Connected`, then click Back. You leave settings, and the runs list loads.

## References

- `context-agent/wiki/design-system.md` Settings pages, Focus and keyboard, Alignment.
- `context-agent/wiki/code-map.md`.
- `apps/web/src/shell/sidebar.tsx`.
- `apps/web/src/settings/connection-page.tsx`.
- `apps/web/src/ui/write-only-secret-field.tsx`.
- `apps/web/src/client/client-provider.tsx`.
- Issue #132 settings frame and Connection page.
- Issue #161 General and Appearance apply at once.
- Issue #142 Projects.
