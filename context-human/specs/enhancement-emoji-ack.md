---
created: 2026-04-24
last_updated: 2026-04-25
status: implementing
issue: 63
specced_by: markdstafford
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Emoji-reaction acknowledgements

## Parent feature

[`feature-slack-message-routing.md`](https://feature-slack-message-routing.md) — connects Autocatalyst to a Slack channel, classifies inbound messages by intent, and routes them to the appropriate handler, posting acknowledgements to threads for new requests and thread replies.
## What

Add emoji reactions as immediate receipt signals on all inbound messages, replace the generic new-request text ack with intent-specific messages posted by the orchestrator after classification, and introduce an optional completion reaction to signal when a work item finishes.
## Why

- An immediate `:eyes:` reaction gives users fast, unambiguous receipt on every message without cluttering the thread.
- Intent-specific text messages make explicit what the bot understood and what happens next.
## User stories

- Phoebe sends a new idea and immediately sees `:eyes:` on her message, followed by "Writing a spec — will post it here when I'm done." confirming how the bot classified it
- Enzo files a bug and sees "Working on a plan — will post it here when I'm done." rather than a generic receipt
- Phoebe replies to a spec thread and sees `:eyes:` on her reply without a new text message appearing
- Enzo approves a spec and receives a `:eyes:` receipt on his approval without the old feedback-oriented ack string appearing before the approval confirmation
- A user watching a thread sees `:white_check_mark:` on the original request message when the work item completes
- A team running a high-volume channel sets `complete: null` in config to suppress completion reactions
## Technical changes

### Affected files

- `src/adapters/slack/slack-adapter.ts` — add `reactToMessage` helper; apply ack reaction to all inbound messages; remove text acks from both `new_request` and `thread_message` branches; expose method for orchestrator use
- `src/core/orchestrator.ts` — post intent-specific text messages after classification of new-thread messages; post completion reaction when configured
- `config/` — add `slack.reacjis.ack` and `slack.reacjis.complete` to config schema and defaults
- `tests/adapters/slack/slack-adapter.test.ts` — add tests for `reactToMessage` and updated inbound-handler behavior
- `tests/core/orchestrator.test.ts` — add tests for intent-specific messages and completion reaction
### Config

Add to config schema and defaults:
```yaml
slack:
  reacjis:
    ack: eyes
    complete: white_check_mark
```
Both values are emoji names (no colons). `complete` may be `null` or omitted to disable the completion reaction.
### `reactToMessage` in `SlackAdapter`

Add a `reactToMessage(channel: string, ts: string, emoji: string): Promise` method. Make it accessible to the orchestrator (public, or via the adapter interface). On failure, log `slack.error` and do not rethrow — consistent with existing `postMessage` error handling.
```typescript
async reactToMessage(channel: string, ts: string, emoji: string): Promise {
  try {
    await this.app.client.reactions.add({ channel, timestamp: ts, name: emoji });
    this.logger.info(
      { event: 'slack.reaction.sent', channel_id: channel, ts, emoji },
      'Reaction posted',
    );
  } catch (err) {
    this.logger.error(
      { event: 'slack.error', error: String(err) },
      'Failed to post reaction',
    );
  }
}
```
### `SlackAdapter` — inbound handler changes

**All inbound messages:** Call `reactToMessage(channelId, msg.ts, config.slack.reacjis.ack)` for both `new_request` and `thread_message` events. The reaction targets `msg.ts` (the specific message being acknowledged), not `msg.thread_ts`.
**`new_request`**** text ack:** Remove from the adapter. The orchestrator posts the intent-specific message after classification.
**`thread_message`**** text ack:** Remove (was "Thanks — I'll incorporate that feedback."). Replaced by the `:eyes:` reaction above.
### `Orchestrator` — intent-specific messages

After classifying a new-thread message, post the appropriate text message to the thread:

Intent
Message

idea
"Writing a spec — will post it here when I'm done."

bug / chore
"Working on a plan — will post it here when I'm done."

task
"Filing this — will confirm here when I'm done."

(fallback)
"On it — will update here when I'm done."

No text message is posted for `thread_message` events — the `:eyes:` reaction in the adapter covers those.
### `Orchestrator` — completion reaction

When a work item reaches a terminal completion state, call `slackAdapter.reactToMessage(channelId, originalRequestTs, config.slack.reacjis.complete)` if `config.slack.reacjis.complete` is non-null. `originalRequestTs` is the `ts` of the root thread message (the original new request).
**Orchestrator approval acks** ("Approved — committing spec and starting implementation." etc.) remain as text — no change.
### Observability

The following events are emitted by this enhancement. Add `slack.reaction.sent` to the observability table in the parent feature's tech spec.

Event
Level
Fields
Description

`slack.reaction.sent`
`info`
`channel_id`, `ts`, `emoji`
A reaction was successfully applied to a Slack message. Emitted by `reactToMessage` on success.

`slack.error`
`error`
`error`
A Slack API call failed. Emitted by `reactToMessage` on failure; adapter recovers without rethrowing. Reuses the existing event — no new event name needed.

`slack.post.sent`
`info`
(existing fields)
An outbound text message was successfully posted. Covers the orchestrator's intent-specific acknowledgements. No change to this event's definition.

No new error event is introduced for reaction failures — `slack.error` is reused for all Slack API errors to keep the event namespace flat.
## Test plan

### Scope

Tests live in `tests/adapters/slack/slack-adapter.test.ts` (adapter unit tests) and `tests/core/orchestrator.test.ts` (orchestrator unit tests). The Slack API client (`app.client.reactions.add`, `app.client.chat.postMessage`) is mocked at the unit level. Config is injected via the existing test-config helper.
### `SlackAdapter.reactToMessage`

#
Scenario
Setup
Assert

1
Success path
`reactions.add` resolves
Logs `slack.reaction.sent` with `channel_id`, `ts`, and `emoji`; method resolves

2
API error
`reactions.add` rejects
Logs `slack.error` with `error` field; method resolves without rethrowing

### `SlackAdapter` inbound handlers

#
Scenario
Setup
Assert

3
`new_request` ack
Inbound `new_request` event
`reactions.add` called once with `{ channel, timestamp: msg.ts, name: config.slack.reacjis.ack }`

4
`thread_message` ack
Inbound `thread_message` event
`reactions.add` called once with `{ channel, timestamp: msg.ts, name: config.slack.reacjis.ack }`

5
No post on `new_request`
Inbound `new_request` event
`chat.postMessage` not called from adapter

6
No post on `thread_message`
Inbound `thread_message` event
`chat.postMessage` not called from adapter

### `Orchestrator` — intent-specific messages

#
Scenario
Setup
Assert

7
`idea` intent
New-thread message classified as `idea`
`chat.postMessage` called with `"Writing a spec — will post it here when I'm done."`

8
`bug` intent
New-thread message classified as `bug`
`chat.postMessage` called with `"Working on a plan — will post it here when I'm done."`

9
`chore` intent
New-thread message classified as `chore`
`chat.postMessage` called with `"Working on a plan — will post it here when I'm done."`

10
`task` intent
New-thread message classified as `task`
`chat.postMessage` called with `"Filing this — will confirm here when I'm done."`

11
Fallback intent
New-thread message, unknown intent
`chat.postMessage` called with `"On it — will update here when I'm done."`

12
`thread_message` event
Inbound `thread_message` event
No intent-specific `chat.postMessage` from orchestrator

### `Orchestrator` — completion reaction

#
Scenario
Setup
Assert

13
Completion, emoji configured
Work item completes; `config.slack.reacjis.complete = 'white_check_mark'`
`reactions.add` called with `{ channel, timestamp: originalRequestTs, name: 'white_check_mark' }`

14
Completion, `complete` is `null`
Work item completes; `config.slack.reacjis.complete = null`
`reactions.add` not called for completion

15
Completion, `complete` omitted
Work item completes; `config.slack.reacjis` has no `complete` key
`reactions.add` not called for completion

### Regression

All tests not listed above must continue to pass without modification. `tsc --noEmit` passes across the entire project.
## Task list

- [ ] **Story: Emoji-reaction acknowledgements**
	- [x] **Task: Add ****`slack.reacjis`**** to config schema and defaults**
		- **Files**: `config/` schema file, `config/` defaults file
		- **Description**: Define `slack.reacjis.ack` (required string, default `'eyes'`) and `slack.reacjis.complete` (string \| null, default `'white_check_mark'`) in the config schema and default config.
		- **Acceptance criteria**:
			- [x] `slack.reacjis.ack` validates as a required string; missing value fails schema validation
			- [x] `slack.reacjis.complete` validates as string \| null; omitting it passes schema validation
			- [x] Default config sets `ack: 'eyes'` and `complete: 'white_check_mark'`
			- [x] `tsc --noEmit` passes
		- **Dependencies**: None
	- [x] **Task: Implement ****`reactToMessage`**** on ****`SlackAdapter`**
		- **Files**: `src/adapters/slack/slack-adapter.ts`
		- **Description**: Add `public async reactToMessage(channel: string, ts: string, emoji: string): Promise`. Calls `app.client.reactions.add({ channel, timestamp: ts, name: emoji })`. Logs `{ event: 'slack.reaction.sent', channel_id: channel, ts, emoji }` at info on success. Logs `{ event: 'slack.error', error: String(err) }` at error on failure and does not rethrow.
		- **Acceptance criteria**:
			- [x] Method is public (accessible to orchestrator)
			- [x] Calls `reactions.add` with `channel`, `timestamp: ts`, and `name: emoji`
			- [x] Logs `slack.reaction.sent` (info) with `channel_id`, `ts`, `emoji` on success
			- [x] Logs `slack.error` (error) on failure; method resolves without throwing
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `slack.reacjis` to config schema and defaults
	- [x] **Task: Apply ack reaction in ****`SlackAdapter`**** inbound handlers; remove text acks**
		- **Files**: `src/adapters/slack/slack-adapter.ts`
		- **Description**: In the `new_request` and `thread_message` handlers, call `this.reactToMessage(channelId, msg.ts, config.slack.reacjis.ack)`. Remove the existing `chat.postMessage` ack calls from both handlers (the generic new-request ack and "Thanks — I'll incorporate that feedback.").
		- **Acceptance criteria**:
			- [x] `reactToMessage` called with `msg.ts` (not `thread_ts`) in both handlers
			- [x] No `chat.postMessage` call remains in either handler
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Implement `reactToMessage` on `SlackAdapter`
	- [x] **Task: Post intent-specific messages in ****`Orchestrator`**** after classification**
		- **Files**: `src/core/orchestrator.ts`
		- **Description**: After classifying a new-thread message, post the intent-mapped text to the thread: idea → "Writing a spec — will post it here when I'm done.", bug/chore → "Working on a plan — will post it here when I'm done.", task → "Filing this — will confirm here when I'm done.", fallback → "On it — will update here when I'm done." Do not post for `thread_message` events.
		- **Acceptance criteria**:
			- [x] Each of the four intents (idea, bug, chore, task) maps to the correct message string
			- [x] Fallback intent posts "On it — will update here when I'm done."
			- [x] Message is posted after classification, not before
			- [x] No intent-specific message posted for `thread_message` events
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Apply ack reaction in `SlackAdapter` inbound handlers; remove text acks
	- [ ] **Task: Post completion reaction in ****`Orchestrator`**
		- **Files**: `src/core/orchestrator.ts`
		- **Description**: When a work item reaches terminal completion, call `slackAdapter.reactToMessage(channelId, originalRequestTs, config.slack.reacjis.complete)` if `config.slack.reacjis.complete` is non-null. `originalRequestTs` is the `ts` of the root thread message.
		- **Acceptance criteria**:
			- [ ] Completion reaction is posted with `config.slack.reacjis.complete` as the emoji
			- [ ] No reaction is posted when `config.slack.reacjis.complete` is null
			- [ ] No reaction is posted when `config.slack.reacjis.complete` is omitted from config
			- [ ] Reaction targets `originalRequestTs`, not a reply `ts`
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Implement `reactToMessage` on `SlackAdapter`; Task: Add `slack.reacjis` to config schema and defaults
	- [x] **Task: Unit-test ****`reactToMessage`**
		- **Files**: `tests/adapters/slack/slack-adapter.test.ts`
		- **Description**: Add unit tests for the `reactToMessage` method covering the success path (logs `slack.reaction.sent`) and failure path (`reactions.add` throws → logs `slack.error`, method resolves). These are tests 1–2 in the test plan.
		- **Acceptance criteria**:
			- [x] Test 1: success → `slack.reaction.sent` logged with `channel_id`, `ts`, `emoji`
			- [x] Test 2: `reactions.add` throws → `slack.error` logged; method resolves without throwing
			- [x] All previously passing tests continue to pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Implement `reactToMessage` on `SlackAdapter`
	- [x] **Task: Test ****`SlackAdapter`**** inbound-handler ack behavior**
		- **Files**: `tests/adapters/slack/slack-adapter.test.ts`
		- **Description**: Add tests asserting the updated inbound-handler behavior: `reactions.add` called with `msg.ts` for both event types; `chat.postMessage` not called from either handler. These are tests 3–6 in the test plan.
		- **Acceptance criteria**:
			- [x] Test 3: `new_request` → `reactions.add` called with `msg.ts` and ack emoji
			- [x] Test 4: `thread_message` → `reactions.add` called with `msg.ts` and ack emoji
			- [x] Test 5: `new_request` → `chat.postMessage` not called from adapter
			- [x] Test 6: `thread_message` → `chat.postMessage` not called from adapter
			- [x] All previously passing tests continue to pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Apply ack reaction in `SlackAdapter` inbound handlers; remove text acks
	- [x] **Task: Test orchestrator intent-specific messages**
		- **Files**: `tests/core/orchestrator.test.ts`
		- **Description**: Add tests for all four intent-to-message mappings and the no-post-for-thread-message rule. These are tests 7–12 in the test plan.
		- **Acceptance criteria**:
			- [x] Test 7: `idea` → correct message posted
			- [x] Test 8: `bug` → correct message posted
			- [x] Test 9: `chore` → correct message posted
			- [x] Test 10: `task` → correct message posted
			- [x] Test 11: fallback intent → "On it — will update here when I'm done." posted
			- [x] Test 12: `thread_message` → no intent-specific message from orchestrator
			- [x] All previously passing tests continue to pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Post intent-specific messages in `Orchestrator` after classification
	- [ ] **Task: Test orchestrator completion reaction**
		- **Files**: `tests/core/orchestrator.test.ts`
		- **Description**: Add tests for the completion reaction: posted when configured, skipped when `complete` is null or omitted. These are tests 13–15 in the test plan.
		- **Acceptance criteria**:
			- [ ] Test 13: completion + `complete` configured → `reactions.add` called with `originalRequestTs` and `complete` emoji
			- [ ] Test 14: completion + `complete` is null → `reactions.add` not called
			- [ ] Test 15: completion + `complete` omitted → `reactions.add` not called
			- [ ] All previously passing tests continue to pass
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Post completion reaction in `Orchestrator`