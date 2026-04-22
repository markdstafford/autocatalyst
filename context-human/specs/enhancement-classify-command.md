---
created: 2026-04-21
last_updated: 2026-04-22
status: implementing
issue: 65
specced_by: markdstafford
implemented_by: markdstafford
superseded_by: null
---
# Enhancement: Intent classification probe (`:ac-classify-intent:`)

## Parent feature

`feature-command-mode.md`
## What

Adds the `:ac-classify-intent:` command — the first of two testing utilities planned but deferred in the initial command mode release. The command runs any message text through `AnthropicIntentClassifier.classify()` and posts the result in-thread: the intent and the context used. An optional context override lets callers test classification in any stage context. No run, workspace, or persistent state is created.
## Why

Diagnosing intent misclassifications requires starting a full pipeline run and watching how the message is routed. There is no way to test the classifier in isolation — against a known input, in a specific context, without side effects. This makes it slow and noisy to validate prompt changes or reproduce a reported misclassification. The probe closes that gap: any message can be tested in any context with a single command, with a result in under a second.
## User stories

- Phoebe can use `:ac-``classify-intent``: what's the status of the onboarding work` to see how a message would be classified before sending it as a real request, without starting a run
- Phoebe can use `:ac-classify-intent: ``reviewing_spec`` looks good` to test how a message would be classified in a specific stage context (e.g., to confirm an approval message is recognized as `approval` during spec review)
- Enzo can use the probe to confirm that a known message receives the expected intent after a classifier prompt change, without triggering the pipeline
- Existing classification for all normal messages is unaffected
## Design changes

No UI — the reply is plain Slack text.
## Technical changes

### Affected files

- `src/adapters/slack/classifier.ts` — add `'ac-classify-intent': 'classify-intent'` to `EMOJI_COMMAND_TABLE`
- `src/core/commands/classify-intent-command.ts` — new file; `makeClassifyIntentHandler(intentClassifier: IntentClassifier)` implementation
- `src/index.ts` — register `classify-intent` command with `makeClassifyIntentHandler(intentClassifier)` and a usage string
### No changes needed

- `src/adapters/agent/intent-classifier.ts` — called as-is; no changes
- `src/core/orchestrator.ts` — command dispatch is already in place via `_launchCommand` and `CommandRegistry`
- `src/adapters/slack/slack-adapter.ts` — command detection and `CommandEvent` emission already handle any registered emoji in the table
### Changes

#### 1. Introduction and overview

**Prerequisites and assumptions**
- Depends on `feature-command-mode.md` (complete) — `CommandRegistry`, `CommandEvent`, `CommandHandler` types; `_launchCommand` dispatch in `OrchestratorImpl`; `EMOJI_COMMAND_TABLE` in `classifier.ts`; command registration pattern in `src/index.ts`
- Depends on `enhancement-intent-classifier-routing.md` (complete) — `AnthropicIntentClassifier`, `IntentClassifier` interface, `ClassificationContext` type, `VALID_INTENTS_BY_CONTEXT`
- No new ADRs, database changes, or API surface required
**Technical goals**
- `:ac-classify-intent:` is dispatched through the existing `CommandRegistry` — no new event types, no changes to the `classifyMessage()` detection logic beyond adding one entry to `EMOJI_COMMAND_TABLE`
- The handler treats `args[0]` as a context override if it matches a key in `VALID_INTENTS_BY_CONTEXT`; otherwise the full args are joined as message text and `new_thread` is used
- No run, workspace, `ThreadRegistry` entry, or any persistent state is created
**Non-goals**
- Implementing `:ac-route:` (the other deferred testing utility from `feature-command-mode.md`)
- Logging or persisting probe results
- Restricting probe access to specific users or channels
#### 2. System design and architecture

No architectural changes. The classify-intent probe is a pure addition within the existing command infrastructure:
```javascript
User: :ac-classify-intent: reviewing_spec looks good
  → classifyMessage() matches 'ac-classify-intent' in EMOJI_COMMAND_TABLE
  → { intent: 'command', command: 'classify-intent', args: ['reviewing_spec', 'looks', 'good'] }
  → SlackAdapter builds and emits CommandEvent
  → OrchestratorImpl._runLoop detects type: 'command' → _launchCommand
  → CommandRegistry.dispatch('classify-intent', event, reply)
  → makeClassifyIntentHandler: 'reviewing_spec' found in VALID_INTENTS_BY_CONTEXT → context override
  → intentClassifier.classify('looks good', 'reviewing_spec')
  → reply: *Classification result* / Context: `reviewing_spec` / Intent: `approval`
```
**Context argument syntax**
If `args[0]` is a key in `VALID_INTENTS_BY_CONTEXT`, it is treated as a context override and the remaining args are joined as the message text. Otherwise, all args are joined as the message text and the context defaults to `new_thread`.
Examples:
- `:ac-classify-intent: the login button is broken` → context = `new_thread`, text = `the login button is broken`
- `:ac-classify-intent: reviewing_spec is this the right approach?` → context = `reviewing_spec`, text = `is this the right approach?`
**Reply format**
```javascript
*Classification result*
Context: `new_thread`
Intent: `question`
```
#### 3. Detailed design

**`src/adapters/slack/classifier.ts`**
Add one entry to `EMOJI_COMMAND_TABLE`:
```typescript
'ac-classify-intent': 'classify-intent',
```
No other changes to the module.
---
**`src/core/commands/classify-intent-command.ts`** (new file)
```typescript
import type { CommandHandler } from '../../types/commands.js';
import type { IntentClassifier, ClassificationContext } from '../../adapters/agent/intent-classifier.js';
import { VALID_INTENTS_BY_CONTEXT } from '../../adapters/agent/intent-classifier.js';

export function makeClassifyIntentHandler(intentClassifier: IntentClassifier): CommandHandler {
  return async (event, reply) => {
    const { args } = event;

    if (args.length === 0) {
      await reply('Usage: `:ac-classify-intent: ` or `:ac-classify-intent:  `');
      return;
    }

    let context: ClassificationContext = 'new_thread';
    let text: string;

    if (args[0] in VALID_INTENTS_BY_CONTEXT) {
      context = args[0] as ClassificationContext;
      text = args.slice(1).join(' ');
    } else {
      text = args.join(' ');
    }

    if (!text.trim()) {
      await reply('Usage: `:ac-classify-intent: ` or `:ac-classify-intent:  `');
      return;
    }

    const intent = await intentClassifier.classify(text, context);

    await reply(`*Classification result*\nContext: \`${context}\`\nIntent: \`${intent}\``);
  };
}
```
---
**`src/index.ts`** (addition)
After the existing command registrations, add:
```typescript
import { makeClassifyIntentHandler } from './core/commands/classify-intent-command.js';

// ...

commandRegistry.register(
  'classify-intent',
  makeClassifyIntentHandler(intentClassifier),
  'Test how a message would be classified. Usage: `:ac-classify-intent: ` or `:ac-classify-intent:  `',
);
```
#### 4. Security, privacy, and compliance

**Input handling**
- `event.args` values are not logged — consistent with the existing args-not-logged policy from `feature-command-mode.md`. Only `event.command`, `event.author`, and the extracted context name are logged.
- The message text is passed to `AnthropicIntentClassifier.classify()` as an opaque string, which is the same call path used for all normal message classification. No new data sharing model is introduced.
**No side effects**
- The handler creates no runs, workspaces, `ThreadRegistry` entries, or persistent state. All side effects are confined to posting a single reply message.
#### 5. Observability

The classify-intent command inherits all command-level observability from the existing infrastructure:

Event
Level
Fields

`command.dispatched`
info
`command: 'classify-intent'`, `author`

`command.succeeded`
info
`command: 'classify-intent'`, `author`

`command.failed`
error
`command: 'classify-intent'`, `error`

`intent.classified`
info
`context`, `classified_intent`, `message_length` (from `AnthropicIntentClassifier`)

Metrics inherited from command infrastructure:
- `command.received` counter with `command: 'classify-intent'` label
- `command.succeeded` / `command.failed` counters with `command: 'classify-intent'` label
No new metrics are required.
#### 6. Testing plan

**`classifier.ts`**** — unit tests (classify-intent entry in EMOJI_COMMAND_TABLE)**
- `:ac-classify-intent: hello world` → `{ intent: 'command', command: 'classify-intent', args: ['hello', 'world'] }`
- `:ac-classify-intent:` with no trailing text → `{ intent: 'command', command: 'classify-intent', args: [] }`
- `:ac-classify-intent: reviewing_spec looks good` → `{ intent: 'command', command: 'classify-intent', args: ['reviewing_spec', 'looks', 'good'] }`
- All existing `classifyMessage` tests still pass
- `tsc --noEmit` passes
**`classify-intent-command.ts`**** — unit tests**
*Normal classification:*
- Args `['the', 'login', 'button', 'is', 'broken']` → `classify('the login button is broken', 'new_thread')` called; reply contains `Context: \`new_thread\`` and `Intent: \`\\`\`
- Args `['reviewing_spec', 'is', 'this', 'right?']` → `classify('is this right?', 'reviewing_spec')` called; reply contains `Context: \`reviewing_spec\`\`
- Args `['awaiting_impl_input', 'more', 'context']` → valid context; `classify('more context', 'awaiting_impl_input')` called
*Context detection:*
- Args `['foo', 'message']` → `foo` not in `VALID_INTENTS_BY_CONTEXT`; `classify('foo message', 'new_thread')` called
- Args `['new_thread', 'message']` → `new_thread` is valid; `classify('message', 'new_thread')` called
*Edge cases:*
- Empty args `[]` → usage message posted; `classify()` not called
- Args `['reviewing_spec']` with no message text after context → usage message posted; `classify()` not called
- `classify()` throws → error propagates to `_launchCommand`, which posts the standard command-failed fallback reply; handler does not swallow the error
*Reply format:*
- Reply is exactly `*Classification result*\nContext: \`new_thread\`nIntent: \`question\`\` (or actual intent)
**`src/index.ts`**** — integration smoke test**
- `commandRegistry.has('classify-intent')` returns `true` after startup
- `commandRegistry.getUsage('classify-intent')` returns a non-empty usage string
- `:ac-help:` output includes `classify-intent`
#### 7. Alternatives considered

**Text-prefix approach (****`@ac classify: message`****)**
The issue proposes detecting a `classify:` text prefix in `classifyMessage()` after the `@mention`, rather than using a `:ac-classify-intent:` emoji token. This avoids requiring a custom emoji but introduces a parallel detection path in `classifyMessage()` with different logic and a new `InboundEvent` handling branch in the adapter. Rejected because the parent feature spec (`feature-command-mode.md`) explicitly names `:ac-classify:` as the intended command format, and the emoji approach requires zero changes beyond adding a table entry and implementing the handler — all routing infrastructure already exists.
**Route through the orchestrator as a new event type**
The issue also proposes routing through a new `probe_classify` event type in `InboundEvent` rather than through the command registry. Rejected for the same reason: the command registry exists precisely for deterministic, non-pipeline operations that post a reply without creating a run. A new event type would require changes to `classifyMessage()`, `SlackAdapter`, and the orchestrator's main dispatch loop, all of which are avoided by using the existing command path.
#### 8. Risks

**`:ac-classify-intent:`**** custom Slack emoji must exist in the workspace**
Like all `:ac-*:` commands, `:ac-classify-intent:` requires a custom emoji to be created in the Slack workspace. If the emoji does not exist, the command cannot be triggered. Mitigation: document the emoji alongside the other required `:ac-*:` emojis in the project README. No code change required.
**`intentClassifier`**** is required (not optional)**
The handler accepts `IntentClassifier`, not `IntentClassifier | undefined`. In `src/index.ts`, `intentClassifier` is always constructed before command registration, so this is not a runtime risk. Tests that construct the handler must supply a mock; the non-optional type signature enforces this at compile time.
## Task list

- [ ] **Story: Wire ****`:ac-classify-intent:`**** into the command table and register the handler**
	- [x] **Task: Add ****`:ac-classify-intent:`**** to ****`EMOJI_COMMAND_TABLE`**** in ****`classifier.ts`**
		- **Description**: Add `'ac-classify-intent': 'classify-intent'` to the `EMOJI_COMMAND_TABLE` record in `src/adapters/slack/classifier.ts`. No other changes to the module.
		- **Acceptance criteria**:
			- [x] `EMOJI_COMMAND_TABLE['ac-classify-intent']` equals `'classify-intent'`
			- [x] `:ac-classify-intent: hello world` passes through `classifyMessage()` as `{ intent: 'command', command: 'classify-intent', args: ['hello', 'world'] }`
			- [x] All existing `classifyMessage` tests pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: None
	- [ ] **Task: Implement ****`makeClassifyIntentHandler`**** in ****`classify-intent-command.ts`**
		- **Description**: Create `src/core/commands/classify-intent-command.ts`. Export `makeClassifyIntentHandler(intentClassifier: IntentClassifier): CommandHandler`. The handler: (1) returns usage message if args is empty; (2) checks if `args[0]` is a key in `VALID_INTENTS_BY_CONTEXT` — if so, uses it as the context override and joins the remaining args as message text; otherwise joins all args as message text with context defaulting to `new_thread`; (3) returns usage message if text is empty after context extraction; (4) calls `intentClassifier.classify(text, context)`; (5) posts the formatted reply as specified in §2. Write unit tests in `tests/core/commands/classify-intent-command.test.ts` covering all cases in §6.
		- **Acceptance criteria**:
			- [ ] Empty args → usage message posted; `classify()` not called
			- [ ] `['reviewing_spec', 'is', 'this', 'right?']` → `classify('is this right?', 'reviewing_spec')` called; reply includes `Context: \`reviewing_spec\`\`
			- [ ] `['reviewing_spec']` only → usage message posted; `classify()` not called
			- [ ] `['hello', 'world']` (no valid context as first arg) → `classify('hello world', 'new_thread')` called
			- [ ] Reply format matches spec
			- [ ] All unit tests pass
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `:ac-classify-intent:` to `EMOJI_COMMAND_TABLE`
	- [ ] **Task: Register ****`classify-intent`**** command in ****`src/index.ts`**
		- **Description**: Import `makeClassifyIntentHandler` from `./core/commands/classify-intent-command.js`. After the existing command registrations, call `commandRegistry.register('classify-intent', makeClassifyIntentHandler(intentClassifier), '')`. Use usage string: `Test how a message would be classified. Usage: \`:ac-classify-intent: \\` or \`:ac-classify-intent: \ \\`\`.
		- **Acceptance criteria**:
			- [ ] `commandRegistry.has('classify-intent')` returns `true` at startup
			- [ ] `commandRegistry.getUsage('classify-intent')` returns a non-empty string
			- [ ] `:ac-help:` lists `classify-intent` in its output
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Implement `makeClassifyIntentHandler` in `classify-intent-command.ts`