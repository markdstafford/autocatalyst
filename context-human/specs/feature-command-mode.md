---
created: 2026-04-21
last_updated: 2026-04-21
status: implementing
issue: 68
specced_by: markdstafford
implemented_by: markdstafford
superseded_by: null
---
# Command mode

## What

Command mode gives users a way to invoke system capabilities with explicit, named intent from any Autocatalyst message channel. Instead of asking the system to infer what a message is asking for, users include a command token in their message — or supply one as a reaction — and the system dispatches directly to the appropriate handler. No intent classification happens; the path from command to action is deterministic.
Command mode is built in two distinct layers. The **command system** is channel-agnostic: a `CommandRegistry` maps command names to `CommandHandler` functions, `CommandEvent` carries the normalized command and its arguments, and handler logic runs independently of any specific interaction channel. Any adapter that can produce a `CommandEvent` can participate. The **Slack adapter** is the first such adapter: it extracts command tokens from `:ac-*:` emoji in channel messages and reactions, normalizes them into `CommandEvent`s, and emits them to the command system. Thread context does significant work — most commands invoked inside a run's thread need no arguments because the relevant run or spec is implied.
## Why

The AI routing layer works well for natural-language ideas and feedback, but it introduces friction and uncertainty for structured tasks where intent is unambiguous. Checking on a run, fetching logs, canceling a stuck process, and testing how a message would be classified are all tasks that don't benefit from AI inference — the intent is clear, the action is deterministic, and routing through a classifier only adds latency and a failure mode.
Command mode removes the AI from that path. It also makes the system more legible: when a user adds `:ac-run-status:` to a message, what will happen is obvious. That clarity matters for team adoption, for debugging, and for use cases where predictable behavior is more valuable than natural-language flexibility.
## Personas

- **Enzo: Engineer** — uses commands to inspect and manage active runs, test classification behavior, and check system state without seeding new requests
- **Phoebe: Product manager** — uses commands to check run status, list available specs, and monitor system activity without introducing noise into the pipeline
## Narratives

### Troubleshooting a stuck run

Enzo notices that a run he kicked off fifteen minutes ago hasn't posted a progress update. Without leaving the Slack channel, he reacts to his original message with `:ac-run-status:`. Autocatalyst replies in the thread with the current run stage and how long it's been there. The run is stuck in `speccing` and hasn't moved in twelve minutes. Enzo reacts to the status reply with `:ac-run-logs:` and gets the last twenty log lines — a timeout talking to the agent is visible in the output. He reacts to the original message with `:ac-run-cancel:` to stop it, then re-seeds the idea. The second run completes without issue.
Throughout the entire sequence, Enzo stayed in the same thread and never wrote a natural-language message. Each reaction was a direct instruction; each response appeared in the thread. The thread context supplied the run ID automatically — Enzo never had to look one up.
### Testing an ambiguous message

> *Note: ****`:ac-classify:`**** and ****`:ac-route:`**** are planned commands not implemented in the initial release. This narrative describes intended future behavior.*
Phoebe is drafting a message to Autocatalyst and isn't sure whether it'll be classified as an idea or a question. Before sending it as a real request, she types `:ac-classify: what's the status of the onboarding work` in the channel. Autocatalyst replies immediately with the classification result: `intent: question`. She revises the message to lead with the feature description rather than the status question, re-runs classify, and confirms the classification changes to `idea`. She sends the real message with confidence.
Enzo uses `:ac-route: let's work on issue 68` during a code review to verify that a new intent classifier change doesn't break routing for a message he knows should trigger the spec pipeline. He doesn't need to create a real run — he just needs to confirm which handler would be invoked. The reply tells him in under a second.
## User stories

**Troubleshooting a stuck run**
- Enzo can react to any run-related message with `:ac-run-status:` to see the current stage of the associated run without writing a natural-language message
- Enzo can react with `:ac-run-logs:` in a run thread to retrieve the log tail for that run
- Enzo can react with `:ac-run-cancel:` to cancel a run without leaving the thread
- Enzo can use `:ac-run-list:` to see all active runs across the system at a glance
**System and help**
- Enzo can use `:ac-health:` to check system health without sending a natural-language request
- Phoebe can use `:ac-help:` to see the full list of available commands
- Anyone can use `:ac-help: [command]` for usage details on a specific command
**Testing (planned, not in initial release)**
- Phoebe can use `:ac-classify: [text]` to see how a message would be classified before sending it as a real request
- Enzo can use `:ac-route: [text]` to verify which handler would be invoked for a given input
## Goals

- The command system dispatches `CommandEvent`s to registered handlers directly, without passing through the intent classifier
- The Slack adapter recognizes `:ac-*:` emoji in messages and reactions and converts them into `CommandEvent`s before they reach the orchestrator
- The command token is stripped from the event before it is passed to the handler
- Commands invoked in a thread infer their arguments from thread context where applicable, requiring no explicit run ID or spec name
- An unrecognized `:ac-*:` emoji produces the same reply as `:ac-help:` and does not create a run
- All existing message routing behavior is unchanged for messages that contain no command emoji
## Non-goals

- Web, CLI, or non-Slack command interfaces
- Per-user or per-channel access control for commands
- Persistent command history across restarts
- Interactive multi-step command flows — all commands are single-message, single-response; the `CommandEvent` design does not foreclose stateful flows in the future, but they are out of scope for this feature
## Tech spec

### 1. Introduction and overview

**Dependencies**
- Feature: Slack message routing — `SlackAdapter`, `classifyMessage`, `ThreadRegistry`, `InboundEvent` union
- Feature: Intent classifier routing — `IntentClassifier`, `OrchestratorImpl._handleRequest` dispatch logic
**Technical goals**
*Command system*
- `CommandRegistry` maps command names to `CommandHandler` functions; dispatching a `CommandEvent` calls the handler directly — `IntentClassifier.classify()` is never called for command events
- Command dispatch is async: `_launchCommand` fires the handler into `_inFlight` and the `_runLoop` continues immediately — no debouncing or queuing applies to commands
- Thread context infers arguments; the handler receives a pre-populated `inferred_context` with `request_id` when one is available
- Unrecognized command names produce the same reply as `:ac-help:`, listing available commands; non-command events continue through the existing routing path unchanged
*Slack adapter*
- The Slack adapter scans messages for a recognized `:ac-*:` emoji before the `@mention` check and normalizes them into `CommandEvent`s — the emoji is a stronger signal than natural language
- Message commands sent within a thread use the message's `thread_ts` for context inference directly. Reaction-based commands fetch the reacted-to message to determine `thread_ts`, then dispatch identically to message-based commands.
**Non-goals**
- Implementing the full command surface in this feature — initial handlers are `run.status`, `run.list`, `run.cancel`, `run.logs`, `health`, and `help`; `classify` and `route` are planned but deferred from the initial release
- Slash command registration (blocked by Slack's thread restriction)
- Persistent command registry or history across restarts
**Glossary**
- **Command system** — the channel-agnostic core: `CommandRegistry`, `CommandEvent`, `CommandHandler`, and the dispatch logic in `OrchestratorImpl`; any adapter can feed events to this system
- **Slack adapter** — the Slack-specific layer that extracts command tokens from `:ac-*:` emoji in messages and reactions and normalizes them into `CommandEvent`s for the command system
- **Command token** — a `:ac-*:` emoji in message text, or a reaction emoji, that maps to a registered command name
- **CommandRegistry** — the map from command name to handler (and optional usage string), owned by the orchestrator
- **CommandEvent** — the normalized event emitted by any adapter when a command token is detected; consumed by the orchestrator
- **Context inference** — using thread metadata (run ID from `ThreadRegistry`) to supply arguments not present in the command text
---
### 2. System design and architecture

**New files**
- `src/types/commands.ts` — `CommandEvent` type, `CommandHandler` type, `CommandRegistry` interface
- `src/core/command-registry.ts` — `CommandRegistry` implementation
- `src/core/commands/run-commands.ts` — `run.status`, `run.list`, `run.cancel`, and `run.logs` handlers
- `src/core/commands/meta-commands.ts` — `health` and `help` handlers
**Modified files**
- `src/types/events.ts` — add `command` variant to `InboundEvent` union
- `src/adapters/slack/classifier.ts` — scan for `:ac-*:` patterns before `@mention` check; return new `command` classification kind with parsed command name and args
- `src/adapters/slack/slack-adapter.ts` — emit `command` events on message-based commands; add `reaction_added` handler for reaction-based commands; fetch reacted-to message for context inference
- `src/core/orchestrator.ts` — add `CommandRegistry` to deps; add `_handleCommand()` dispatch branch in `_runLoop`; register initial handlers in the service setup
**Command detection priority in ****`classifyMessage`**
```javascript
1. Does message.text contain :ac-[a-z0-9_-]+: pattern?
   → Yes, recognized command (first match only): return { intent: 'command', command, args }
      (strip first emoji token; split remaining text into args)
   → Yes, unrecognized: fall through (log debug)
   → No: existing @mention logic unchanged
```
Only the **first** `:ac-*:` token in a message is matched. If a message contains multiple command emojis (e.g., `:ac-run-list: :ac-run-status:`), only the first is dispatched; support for multiple commands per message may be added in the future.
The `@mention` check does not run for recognized command emojis. An `@mention` in the same message as a command emoji is ignored — the emoji is sufficient.
**Message command dispatch**
When a Slack message containing a command emoji is received:
1. `classifyMessage()` detects the first `:ac-*:` token in message text
2. If recognized, returns `{ intent: 'command', command, args }`
3. `SlackAdapter` builds a `CommandEvent`, resolving `thread_ts` from `msg.thread_ts ?? msg.ts`; if the message is inside a thread, `msg.thread_ts` is set and the `ThreadRegistry` lookup uses it to populate `inferred_context.request_id`
4. Emit `{ type: 'command', payload: CommandEvent }`
**Reaction command dispatch**
When `reaction_added` fires:
1. Check if `reaction` emoji name is in the command emoji table
2. If yes, fetch the reacted-to message (`conversations.history` with the `item.ts` timestamp)
3. Look up `thread_ts` in `ThreadRegistry` to populate `inferred_context.request_id`
4. Build and emit a `CommandEvent` with `thread_ts` set to the reacted-to message's thread (or `ts` for root messages)
5. If emoji not in table, log debug and drop
**High-level event flow**
```javascript
Slack message (with :ac-*:)
  → Bolt message handler
  → classifyMessage() → { intent: 'command', command, args }
  → SlackAdapter builds CommandEvent (with inferred_context from ThreadRegistry)
  → emit({ type: 'command', payload: CommandEvent })
  → OrchestratorImpl._runLoop
  → _handleCommand() (bypasses _classify entirely)
  → CommandRegistry.dispatch(command, event, reply)
  → Handler posts reply to thread
```
```javascript
Slack reaction (:ac-run-status:)
  → Bolt reaction_added handler
  → emoji in command table?
  → fetch reacted-to message
  → resolve thread context
  → emit({ type: 'command', payload: CommandEvent })
  → (same path as above)
```
---
### 3. Detailed design

**`src/types/commands.ts`** (new file)
```typescript
export interface CommandEvent {
  command: string;              // normalized command name: 'run.status', 'health', etc.
  args: string[];               // parsed arguments: text after the emoji token, split on whitespace
  source: 'slack';
  channel_id: string;
  thread_ts: string;
  author: string;
  received_at: string;          // ISO 8601
  inferred_context?: {
    request_id?: string;        // resolved from ThreadRegistry using thread_ts
  };
}

export type CommandHandler = (
  event: CommandEvent,
  reply: (text: string) => Promise,
) => Promise;

export interface CommandRegistry {
  register(command: string, handler: CommandHandler, usage?: string): void;
  dispatch(command: string, event: CommandEvent, reply: (text: string) => Promise): Promise;
  has(command: string): boolean;
  list(): string[];
  getUsage(command: string): string | undefined;
}
```
**`src/core/command-registry.ts`** (new file)
Simple `Map` implementation. `dispatch()` calls the handler if found; if not, throws so the orchestrator can post the fallback reply. `getUsage()` returns the usage string for a registered command, or `undefined` if none was provided.
**`src/types/events.ts`** (extend `InboundEvent`)
```typescript
export type InboundEvent =
  | { type: 'new_request'; payload: Request }
  | { type: 'thread_message'; payload: ThreadMessage }
  | { type: 'command'; payload: CommandEvent };
```
**Emoji-to-command **mapping**\** (static table in `src/adapters/slack/classifier.ts`)
*Initial commands (implemented in this feature):*

Emoji
Command name

`:ac-run-status:`
`run.status`

`:ac-run-list:`
`run.list`

`:ac-run-cancel:`
`run.cancel`

`:ac-run-logs:`
`run.logs`

`:ac-health:`
`health`

`:ac-help:`
`help`

*Additional commands (examples of future additions; not implemented in this feature):*

Emoji
Command name

`:ac-spec-list:`
`spec.list`

`:ac-spec-show:`
`spec.show`

`:ac-spec-sync:`
`spec.sync`

`:ac-classify:`
`classify`

`:ac-route:`
`route`

`:ac-publish:`
`publish`

`:ac-publish-status:`
`publish.status`

`:ac-config:`
`config.show`

`:ac-config-set:`
`config.set`

`:ac-history:`
`history`

**`classifyMessage`**** changes** (`src/adapters/slack/classifier.ts`)
New classification variant added to `MessageClassification`:
```typescript
| { intent: 'command'; command: string; args: string[] }
```
New logic prepended to the existing function body. The command name regex uses `[a-z0-9_-]+` to allow numbers and underscores alongside lowercase letters and hyphens, matching all characters valid in Slack emoji names. All `:ac-*:` regex patterns in this module use `[a-z0-9_-]+` consistently.
```typescript
// Command detection: scan for :ac-*: pattern before @mention check (first match only)
const commandMatch = message.text?.match(/:ac-([a-z0-9_-]+):/);
if (commandMatch) {
  const emojiName = `ac-${commandMatch[1]}` as const;
  const commandName = EMOJI_COMMAND_TABLE[emojiName];
  if (commandName) {
    const stripped = (message.text ?? '').replace(/:ac-[a-z0-9_-]+:/, '').trim();
    const args = stripped ? stripped.split(/\s+/) : [];
    return { intent: 'command', command: commandName, args };
  }
  // Unrecognized :ac-*: emoji — log and fall through to @mention logic
  // (logged by caller)
}
```
The `EMOJI_COMMAND_TABLE` is a plain `Record` const exported from the module for use in tests.
**`SlackAdapter`**** changes** (`src/adapters/slack/slack-adapter.ts`)
In the message handler, add a branch for `result.intent === 'command'`:
```typescript
} else if (result.intent === 'command') {
  const commandEvent: CommandEvent = {
    command: result.command,
    args: result.args,
    source: 'slack',
    channel_id: this.channelId!,
    thread_ts: msg.thread_ts ?? msg.ts,
    author: msg.user,
    received_at: new Date().toISOString(),
    inferred_context: {
      request_id: this.registry.resolve(msg.thread_ts ?? msg.ts),
    },
  };
  this.logger.info(
    { event: 'slack.command.received', author: msg.user, channel_id: this.channelId, command: result.command },
    'Command received',
  );
  this.emit({ type: 'command', payload: commandEvent });
}
```
No acknowledgement is posted before emission — command handlers post their own reply.
Add a `reaction_added` handler after the message handler registration:
```typescript
this.app.event('reaction_added', async ({ event: reactionEvent }) => {
  if (reactionEvent.item.type !== 'message') return;
  if ((reactionEvent.item as { channel?: string }).channel !== this.channelId) return;

  const emojiKey = `ac-${reactionEvent.reaction}`;
  const commandName = EMOJI_COMMAND_TABLE[emojiKey as keyof typeof EMOJI_COMMAND_TABLE];
  if (!commandName) {
    this.logger.debug({ event: 'slack.reaction.ignored', emoji: reactionEvent.reaction }, 'Reaction ignored');
    return;
  }

  // Fetch the reacted-to message for context
  const item = reactionEvent.item as { channel: string; ts: string };
  let reactedThreadTs: string = item.ts;
  try {
    const historyResult = await this.app.client.conversations.history({
      channel: item.channel,
      latest: item.ts,
      limit: 1,
      inclusive: true,
    });
    const reactedMessage = historyResult.messages?.[0];
    if (reactedMessage?.thread_ts) {
      reactedThreadTs = reactedMessage.thread_ts;
    }
  } catch (err) {
    this.logger.warn({ event: 'slack.error', error: String(err) }, 'Failed to fetch reacted-to message; using item.ts as thread_ts');
  }

  const commandEvent: CommandEvent = {
    command: commandName,
    args: [],
    source: 'slack',
    channel_id: item.channel,
    thread_ts: reactedThreadTs,
    author: reactionEvent.user,
    received_at: new Date().toISOString(),
    inferred_context: {
      request_id: this.registry.resolve(reactedThreadTs),
    },
  };
  this.logger.info(
    { event: 'slack.command.received', author: reactionEvent.user, channel_id: item.channel, command: commandName },
    'Reaction command received',
  );
  this.emit({ type: 'command', payload: commandEvent });
});
```
**`OrchestratorImpl`**** changes** (`src/core/orchestrator.ts`)
Add `commandRegistry?: CommandRegistry` to `OrchestratorDeps`.
In `_runLoop`, add a branch for `command` events that bypasses `_classify`:
```typescript
if (event.type === 'command') {
  // Command events bypass classification and run concurrently
  this._launchCommand(event.payload);
  continue;
}
const action = await this._classify(event as Exclude);
```
New `_launchCommand` method:
```typescript
private _launchCommand(event: CommandEvent): void {
  const reply = (text: string) =>
    this.deps.postMessage(event.channel_id, event.thread_ts, text).catch(err => {
      this.logger.error({ event: 'command.reply_failed', command: event.command, error: String(err) }, 'Failed to post command reply');
    });

  const p: Promise = (async () => {
    this.logger.info({ event: 'command.dispatched', command: event.command, author: event.author }, 'Command dispatched');
    this.metrics.increment('command.received', { command: event.command });
    if (!this.deps.commandRegistry?.has(event.command)) {
      this.logger.warn({ event: 'command.unknown', command: event.command }, 'Unknown command');
      this.metrics.increment('command.unknown');
      // Respond with help output if available; raw fallback otherwise
      if (this.deps.commandRegistry?.has('help')) {
        await this.deps.commandRegistry.dispatch('help', event, reply);
      } else {
        await reply(`Unknown command \`:${event.command}:\` — use \`:ac-help:\` to see available commands.`);
      }
      return;
    }
    try {
      await this.deps.commandRegistry.dispatch(event.command, event, reply);
      this.logger.info({ event: 'command.succeeded', command: event.command, author: event.author }, 'Command succeeded');
      this.metrics.increment('command.succeeded', { command: event.command });
    } catch (err) {
      this.logger.error({ event: 'command.failed', command: event.command, error: String(err) }, 'Command handler failed');
      this.metrics.increment('command.failed', { command: event.command });
      await reply(`Something went wrong running \`${event.command}\` — check logs.`);
    }
  })().finally(() => {
    this._inFlight.delete(p);
  });
  this._inFlight.add(p);
}
```
**Initial command handlers**
Handlers are registered in `src/index.ts` (or wherever the orchestrator is constructed) after the orchestrator is created. The handlers themselves live in `src/core/commands/`.

Command
Handler behavior

`run.status`
Looks up run by `inferred_context.request_id` or first arg as request ID; formats stage, intent, and time in stage

`run.list`
Iterates the orchestrator's run map; formats a summary list of active runs (ID, stage, intent); excludes done/failed runs

`run.cancel`
Cancels the run identified by `inferred_context.request_id` or first arg as request ID; replies with confirmation; handles already-terminal runs with a descriptive message

`run.logs`
Retrieves the last 20 log lines for the run identified by `inferred_context.request_id` or first arg; replies with formatted log tail

`health`
Checks adapter connection state; replies with a brief status summary including active run count

`help`
With no args: lists registered commands with usage strings. With one arg: replies with usage for that command. Also invoked when an unrecognized command is received.

The handlers have access to orchestrator state via closure; they are registered as closures capturing `this.runs`, `this.deps.intentClassifier`, etc. (or as methods on a command handler class injected at construction time).
---
### 4. Security, privacy, and compliance

- Command arguments are untrusted user input; handlers that pass args to downstream systems (e.g., `classify`) must treat them as opaque strings, not interpolate them into shell commands or system prompts beyond their defined role
- `config.set` (deferred from initial handlers) must reject writes to sensitive fields (`bot_token`, `app_token`); all config changes must be logged at `info` level regardless of whether argument values are logged
- The content-not-logged policy from the Slack message routing feature applies: `args` values are not logged; only command name, author, and channel_id are logged
---
### 5. Observability

**Log events**

Event
Level
Fields

`slack.command.received`
info
`author`, `channel_id`, `command`, `thread_ts`

`slack.reaction.ignored`
debug
`emoji`

`command.dispatched`
info
`command`, `author`

`command.succeeded`
info
`command`, `author`

`command.unknown`
warn
`command`

`command.failed`
error
`command`, `error`

`command.reply_failed`
error
`command`, `error`

Argument values are never logged.
**Metrics**
- `command.received` — counter with `command` label; incremented on every recognized command event
- `command.unknown` — counter; incremented when the command is not in the registry
- `command.succeeded` — counter with `command` label; incremented on successful handler completion
- `command.failed` — counter with `command` label; incremented on handler errors
---
### 6. Testing plan

**`classifier.ts`**** — unit tests (command detection)**
*Command recognition*
- Message with `:ac-run-status:` and no other text → `{ intent: 'command', command: 'run.status', args: [] }`
- Message with `:ac-run-list:` and no other text → `{ intent: 'command', command: 'run.list', args: [] }`
- Message with `:ac-help: run.status` → `{ intent: 'command', command: 'help', args: ['run.status'] }`
*Argument parsing*
- Emoji followed by multiple whitespace-separated tokens → args split on whitespace
- Emoji followed by leading/trailing whitespace → args trimmed before split; no empty strings in result
- Emoji only (no trailing text) → args is `[]`
- Emoji followed only by whitespace → args is `[]`
*Regex permissiveness*
- Emoji with hyphens in name (`:ac-run-status:`) → recognized
- Emoji with number in name (`:ac-run2:`, if in table) → recognized
- Emoji with underscore in name (`:ac-run_status:`, if in table) → recognized
- Unrecognized emoji with permissive characters (`:ac-foo123:`) → falls through to `@mention` logic
*First-match behavior*
- Message with two recognized command emojis (`:ac-run-list: :ac-run-status:`) → only `run.list` dispatched; `:ac-run-status:` appears in `args`
- Message with recognized emoji followed by text → first emoji matched; text becomes args
*Priority and fallthrough*
- Message with recognized command emoji plus `@mention` → command classification wins; `@mention` ignored
- Message with unrecognized `:ac-foo-bar:` emoji → falls through to `@mention` logic
- Message with no `:ac-*:` pattern → falls through to `@mention` logic unchanged
*Regression*
- All existing `classifyMessage` test cases continue to pass unmodified
**`slack-adapter.ts`**** — integration tests (command events)**
*Message-based commands*
- Message with recognized command emoji in root message → `command` event emitted with `thread_ts = msg.ts`, correct `command`, `args`, `author`, `channel_id`
- Message with recognized command emoji inside a thread reply → `command` event emitted with `thread_ts = msg.thread_ts`
- `inferred_context.request_id` populated when `thread_ts` resolves in the `ThreadRegistry`
- `inferred_context.request_id` is `undefined` when thread is not registered
- No `chat.postMessage` call made by the adapter for command messages (handler posts its own reply)
*Reaction-based commands*
- `reaction_added` with recognized emoji on root message → `conversations.history` called; `command` event emitted with `thread_ts` from reacted-to message
- `reaction_added` with recognized emoji on thread reply → `command` event emitted with `thread_ts = reactedMessage.thread_ts`
- `reaction_added` with recognized emoji, `conversations.history` fails → event still emitted using `item.ts` as fallback `thread_ts`; warning logged
- `reaction_added` with unrecognized emoji → no event emitted; `slack.reaction.ignored` logged at debug
- `reaction_added` on a message from a different channel → ignored; no event emitted
*Logging*
- `slack.command.received` logged at info for both message and reaction commands; no args values in log fields
- `slack.reaction.ignored` logged at debug for unrecognized reactions
*Regression*
- All existing `SlackAdapter` tests still pass
- `tsc --noEmit` passes
**`command-registry.ts`**** — unit tests**
- `register` then `dispatch` → handler called with event and reply function
- `register` with usage string → `getUsage` returns that string; `getUsage` on unregistered command returns `undefined`
- `dispatch` on unknown command → throws with descriptive message
- `has` returns `true` for registered, `false` for unregistered
- `list` returns all registered command names
- `list` returns empty array when no commands registered
- Registering the same command name twice → second registration overwrites first (or throws — document which)
**Orchestrator — unit tests (command dispatch)**
*Dispatch path*
- `command` event → `_launchCommand` called; `_classify` not called; no run created
- `command` event with registered handler → handler invoked; reply function posts to correct `channel_id` / `thread_ts`
- Handler completes successfully → `command.succeeded` logged at info; `command.succeeded` metric incremented
- `command` event with unregistered command → `help` handler invoked; no error thrown; `command.unknown` metric incremented
- `command` event with unregistered command when `help` also not registered → raw fallback reply posted
- Handler throws → `command.failed` logged; `command.failed` metric incremented; fallback reply posted; subsequent events still processed normally
- Reply function fails (network error) → `command.reply_failed` logged; no exception propagates to run loop
- `command.received` metric incremented on every dispatched command event
*Concurrency*
- Two `command` events arriving back-to-back → both dispatched concurrently without blocking the run loop
- `new_request` event processed while a command handler is in flight
*Regression*
- `new_request` and `thread_message` events continue through existing `_classify` path unchanged
- All existing orchestrator tests still pass
**`run.status`**** handler — unit tests**
- With `inferred_context.request_id` set → replies with stage, intent, and time in stage
- With explicit run ID as first arg, no inferred context → looks up by ID; replies correctly
- Run ID not found in either source → replies with clear "no active run found" message
- No inferred context, no args → replies with "no run found in this thread"
- Run in terminal state (done/failed) → reply shows final stage and status
- Reply posted to correct `thread_ts`
**`run.list`**** handler — unit tests**
- No active runs → replies with "no active runs"
- One active run → replies with summary including ID, stage, intent
- Multiple active runs → all listed with correct formatting; done/failed runs excluded
- Reply posted to correct `thread_ts`
**`run.cancel`**** handler — unit tests**
- With `inferred_context.request_id` set → cancels the run; replies with confirmation message
- With explicit run ID as first arg, no inferred context → looks up by ID and cancels; replies with confirmation
- Run ID not found in either source → replies with "no active run found"
- No inferred context, no args → replies with "no run found in this thread"
- Run already in terminal state (done/failed) → replies with message indicating the run is already complete/failed; no error thrown
- Reply posted to correct `thread_ts`
**`run.logs`**** handler — unit tests**
- With `inferred_context.request_id` set → replies with last 20 log lines formatted
- With explicit run ID as first arg, no inferred context → retrieves logs by ID; replies correctly
- Run ID not found in either source → replies with "no active run found"
- No inferred context, no args → replies with "no run found in this thread"
- Log tail is empty → replies with "no log entries found for this run"
- Reply posted to correct `thread_ts`
**`health`**** handler — unit tests**
- Adapter connected, no active runs → posts connected state and zero run count
- Adapter connected, runs in flight → posts correct active run count
- Adapter disconnected → posts disconnected status
**`help`**** handler — unit tests**
- No args → lists all registered commands with usage strings (at minimum the six initial handlers)
- Known command arg → posts usage description for that command
- Unknown command arg → replies "unknown command: \[name\]"
- Invoked via unrecognized-command fallback path → same reply as direct `:ac-help:`
---
### 7. Alternatives considered

**Slash commands**
Slack slash commands are a natural fit for structured commands but cannot be invoked from threads. Since most commands are most useful inside a run's thread (where context infers the run ID), slash commands would force users to specify IDs manually. The emoji approach preserves full thread context and works everywhere slash commands don't.
**`@mention`**** prefix syntax (****`@ac run status`****)**
Reusing the `@mention` prefix creates ambiguity: "run status" could be a command or a natural-language request. The emoji prefix is unambiguous — it is a signal no human would use in normal conversation, making false positives extremely rare.
**Separate command bot**
A dedicated bot for commands would have cleaner separation but would double operational overhead and split the configuration surface. Since command handlers share infrastructure with the main bot (run map, thread registry, intent classifier), a separate process would require IPC or duplicated state. Keeping everything in one process is simpler and more coherent for the current scale.
---
### 8. Risks

**Emoji name collisions**
A user could include an `:ac-*:` emoji in a message without intending a command. The `ac-` prefix makes this unlikely in practice, but it can happen. Unrecognized emojis fall through to normal classification; recognized emojis will always be treated as commands with no opt-out. The risk is accepted as low-probability for this prefix choice.
**`config.set`**** scope**
If `config.set` is registered as a handler, it writes to the workspace config. An accidentally sent command could misconfigure the system. The mitigation is: reject writes to sensitive fields, log all config changes, and defer `config.set` until there is a clear need and explicit scope definition.
## Task list

- [x] **Story: Types and event extension**
	- [x] **Task: Define command types**
		- **Description**: Create `src/types/commands.ts` with `CommandEvent`, `CommandHandler`, and `CommandRegistry` as specified in the tech spec's detailed design section. The `CommandRegistry` interface must include `register(command, handler, usage?)`, `dispatch`, `has`, `list`, and `getUsage(command)` to support the `help` handler's per-command usage strings.
		- **Acceptance criteria**:
			- [x] `CommandEvent` has `command`, `args`, `source`, `channel_id`, `thread_ts`, `author`, `received_at`, and optional `inferred_context.request_id`
			- [x] `CommandHandler` type matches `(event: CommandEvent, reply: (text: string) => Promise) => Promise`
			- [x] `CommandRegistry` interface has `register` (with optional `usage` param), `dispatch`, `has`, `list`, and `getUsage` methods
			- [x] `tsc --noEmit` passes
		- **Dependencies**: None
	- [x] **Task: Add ****`command`**** variant to ****`InboundEvent`**
		- **Description**: Extend the `InboundEvent` union in `src/types/events.ts` to include `{ type: 'command'; payload: CommandEvent }`. Import `CommandEvent` from `src/types/commands.ts`.
		- **Acceptance criteria**:
			- [x] `InboundEvent` union includes `command` variant
			- [x] Existing `new_request` and `thread_message` variants unchanged
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Define command types
- [x] **Story: Command registry**
	- [x] **Task: Implement ****`CommandRegistry`**
		- **Description**: Create `src/core/command-registry.ts` with a `CommandRegistryImpl` class backed by a `Map`. `register()` stores the handler and optional usage string. `dispatch()` calls the handler if found; throws with a descriptive message if not. `getUsage()` returns the stored usage string or `undefined`. Write unit tests in `tests/core/command-registry.test.ts` covering: register + dispatch, register with usage string + getUsage, dispatch on unknown command, `has` for registered and unregistered, `list` returns all registered names, `list` returns empty array when empty, re-registering a command name.
		- **Acceptance criteria**:
			- [x] `register` then `dispatch` invokes the handler with correct args
			- [x] `register` with usage string → `getUsage` returns that string
			- [x] `getUsage` on unregistered command returns `undefined`
			- [x] `dispatch` on unregistered command throws with descriptive message
			- [x] `has` returns `true` for registered commands, `false` otherwise
			- [x] `list` returns all registered command names
			- [x] All unit tests pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Define command types
- [x] **Story: Slack command detection**
	- [x] **Task: Add command classification to ****`classifyMessage`**
		- **Description**: Extend `classifyMessage` in `src/adapters/slack/classifier.ts` to detect `:ac-*:` patterns (using `[a-z0-9_-]+`) before the `@mention` check. Add the `EMOJI_COMMAND_TABLE` const (exported for tests) with all six initial commands. Only the first command token in a message is matched. If a recognized emoji is found, return `{ intent: 'command', command, args }` with the emoji token stripped and remaining text split on whitespace. Unrecognized `:ac-*:` emojis fall through to the existing `@mention` logic. Add the new `command` variant to `MessageClassification`. Write unit tests covering all cases in the testing plan's classifier section.
		- **Acceptance criteria**:
			- [x] `:ac-run-status:` with no other text → `{ intent: 'command', command: 'run.status', args: [] }`
			- [x] `:ac-help: run.status` → `{ intent: 'command', command: 'help', args: ['run.status'] }`
			- [x] `:ac-*:` + `@mention` in same message → command classification wins
			- [x] Multiple command emojis → only first matched
			- [x] Unrecognized `:ac-foo:` falls through to `@mention` logic
			- [x] No `:ac-*:` pattern falls through to `@mention` logic unchanged
			- [x] All existing `classifyMessage` tests still pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Define command types
	- [x] **Task: Emit command events in ****`SlackAdapter`**
		- **Description**: In `src/adapters/slack/slack-adapter.ts`, add a `command` branch in the message handler for `result.intent === 'command'`. Build a `CommandEvent` using `msg.thread_ts ?? msg.ts` for thread context; resolve `inferred_context.request_id` from `ThreadRegistry`. No acknowledgement is posted before emission. Add a `reaction_added` handler that checks the emoji against `EMOJI_COMMAND_TABLE`, fetches the reacted-to message via `conversations.history` for `thread_ts` inference, and emits a `CommandEvent`. On `conversations.history` failure, fall back to `item.ts` and log a warning. Ignore reactions from other channels. Log `slack.command.received` at info and `slack.reaction.ignored` at debug. Write integration tests covering all cases in the testing plan's adapter section.
		- **Acceptance criteria**:
			- [x] Message command in root message → event with `thread_ts = msg.ts`; no `chat.postMessage`
			- [x] Message command in thread reply → event with `thread_ts = msg.thread_ts`
			- [x] `inferred_context.request_id` populated when `thread_ts` is in registry; `undefined` when not
			- [x] `reaction_added` with recognized emoji → `conversations.history` called; event emitted with correct `thread_ts`
			- [x] `reaction_added`, `conversations.history` fails → event emitted with `item.ts` fallback; warning logged
			- [x] `reaction_added` with unrecognized emoji → no event; `slack.reaction.ignored` logged
			- [x] `reaction_added` from different channel → ignored
			- [x] All existing `SlackAdapter` tests still pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Add command classification to `classifyMessage`
- [x] **Story: Orchestrator command dispatch**
	- [x] **Task: Add ****`_handleCommand`**** dispatch branch to orchestrator**
		- **Description**: In `src/core/orchestrator.ts`, add `commandRegistry?: CommandRegistry` to `OrchestratorDeps`. In `_runLoop`, detect `command` events before `_classify` and dispatch them via `_launchCommand`. Implement `_launchCommand` as described in the tech spec: build a `reply` closure, call `commandRegistry.dispatch`, invoke the `help` handler for unknown commands (falling back to a raw reply if `help` is also not registered), log and increment metrics at each outcome (`command.received`, `command.succeeded`, `command.failed`, `command.unknown`), log and post fallback on handler errors. Command events do not create runs and are not subject to concurrency limiting via `_queue`. Write unit tests covering all cases in the testing plan's orchestrator section.
		- **Acceptance criteria**:
			- [x] `command` event → `_launchCommand` called; `_classify` not called; no run created
			- [x] Registered handler invoked with correct event and reply function
			- [x] Handler succeeds → `command.succeeded` logged at info; `command.succeeded` metric incremented with `command` label
			- [x] Unregistered command → `help` handler invoked (or raw fallback); no error thrown; `command.unknown` metric incremented
			- [x] Handler throws → `command.failed` logged; `command.failed` metric incremented; fallback reply posted; subsequent events processed normally
			- [x] Reply function fails (network error) → `command.reply_failed` logged; no exception propagates to run loop
			- [x] `command.received` metric incremented on every dispatched command event
			- [x] Multiple commands dispatched concurrently without blocking run loop
			- [x] `new_request` and `thread_message` events continue through existing `_classify` path unchanged
			- [x] All existing orchestrator tests still pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Implement `CommandRegistry`, Task: Emit command events in `SlackAdapter`
- [ ] **Story: Initial command handlers**
	- [x] **Task: Implement ****`run.status`**** and ****`run.list`**** handlers**
		- **Description**: Create `src/core/commands/run-commands.ts`. `run.status`: looks up run by `inferred_context.request_id`, or by first arg as request ID if no inferred context. Formats and replies with stage, intent, and time in current stage. If no run found, replies with a clear message. `run.list`: formats a summary of all non-done/non-failed runs; replies "no active runs" if none exist. Register both handlers with usage strings in `src/index.ts`. Write unit tests covering all cases in the testing plan's `run.status` and `run.list` sections.
		- **Acceptance criteria**:
			- [x] `run.status` with inferred `request_id` → posts stage, intent, time in stage
			- [x] `run.status` with explicit ID arg → looks up by ID; replies correctly
			- [x] `run.status` with no context and no args → posts "no run found in this thread"
			- [x] `run.status` for terminal run (done/failed) → reply shows final stage and status
			- [x] `run.list` → posts summary of active runs; "no active runs" if empty; done/failed runs excluded
			- [x] Both handlers registered with usage strings in `src/index.ts`
			- [x] All unit tests pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `_handleCommand` dispatch branch to orchestrator
	- [x] **Task: Implement ****`run.cancel`**** handler**
		- **Description**: Add `run.cancel` to `src/core/commands/run-commands.ts`. Resolves the target run from `inferred_context.request_id` or first arg as request ID. Calls the orchestrator's run cancellation mechanism (cancel the in-flight promise and mark the run as cancelled). Replies with a confirmation message on success. Handles already-terminal runs (done/failed/cancelled) by replying with a descriptive message rather than erroring. If no run is found, replies with "no active run found". Register with a usage string in `src/index.ts`. Write unit tests covering all cases in the testing plan's `run.cancel` section.
		- **Acceptance criteria**:
			- [x] With inferred `request_id` → cancels the run; replies with confirmation
			- [x] With explicit run ID arg → cancels by ID; replies with confirmation
			- [x] Run ID not found → replies "no active run found"
			- [x] No inferred context, no args → replies "no run found in this thread"
			- [x] Run already in terminal state → replies with descriptive message; no error thrown
			- [x] Handler registered with usage string in `src/index.ts`
			- [x] All unit tests pass
			- [x] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `_handleCommand` dispatch branch to orchestrator
	- [ ] **Task: Implement ****`run.logs`**** handler**
		- **Description**: Add `run.logs` to `src/core/commands/run-commands.ts`. Resolves the target run from `inferred_context.request_id` or first arg as request ID. Retrieves the last 20 log lines for that run from wherever run logs are stored (align with the existing logging infrastructure). Formats the log tail as a code block in the reply. If no run is found, replies with "no active run found". If the log tail is empty, replies with "no log entries found for this run". Register with a usage string in `src/index.ts`. Write unit tests covering all cases in the testing plan's `run.logs` section.
		- **Acceptance criteria**:
			- [ ] With inferred `request_id` → replies with last 20 log lines formatted as code block
			- [ ] With explicit run ID arg → retrieves logs by ID; replies correctly
			- [ ] Run ID not found → replies "no active run found"
			- [ ] No inferred context, no args → replies "no run found in this thread"
			- [ ] Empty log tail → replies "no log entries found for this run"
			- [ ] Handler registered with usage string in `src/index.ts`
			- [ ] All unit tests pass
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `_handleCommand` dispatch branch to orchestrator
	- [ ] **Task: Implement ****`health`**** and ****`help`**** handlers**
		- **Description**: Create `src/core/commands/meta-commands.ts`. `health`: checks adapter connection state and replies with a brief status (connected/disconnected, number of active runs, queue depth). `help` with no args: calls `commandRegistry.list()` and for each command calls `commandRegistry.getUsage()` to format a list of commands with their usage strings. `help` with one arg: looks up the command name and replies with its usage string. `help` with an unknown arg: replies "unknown command: \[name\]". `help` is also invoked by the orchestrator when an unrecognized command is received — its output should be identical to a direct `:ac-help:` invocation. Register both with usage strings in `src/index.ts`. Write unit tests covering all cases in the testing plan's `health` and `help` sections.
		- **Acceptance criteria**:
			- [ ] `health` connected with runs in flight → posts connected status and correct run count
			- [ ] `health` disconnected → posts disconnected status
			- [ ] `help` with no args → lists all registered commands with usage strings (at minimum all six initial handlers)
			- [ ] `help` with known command arg → posts usage string for that command
			- [ ] `help` with unknown command arg → replies "unknown command: \[name\]"
			- [ ] `help` invoked via unrecognized-command fallback → same output as direct `:ac-help:`
			- [ ] Both handlers registered with usage strings in `src/index.ts`
			- [ ] All unit tests pass
			- [ ] `tsc --noEmit` passes
		- **Dependencies**: Task: Add `_handleCommand` dispatch branch to orchestrator