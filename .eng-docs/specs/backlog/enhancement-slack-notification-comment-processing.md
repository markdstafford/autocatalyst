---
created: 2026-04-10
last_updated: 2026-04-10
status: draft
issue: null
specced_by: markdstafford
implemented_by: null
superseded_by: null
---

# Enhancement: Slack notification when comment processing completes

## Parent feature

`context-human/specs/feature-slack-message-routing.md`

## What

After Autocatalyst processes Notion comments on a spec — posting responses and resolving each comment — it posts a message in the originating Slack thread to confirm the run is complete. The message tells the user how many comments were addressed and signals that the spec is ready for another look.

## Why

Without a completion notification, users have no signal that Autocatalyst has finished processing their comments. The only way to confirm the run completed is to check the logs or watch for comment resolutions directly in Notion. This creates unnecessary friction in the review loop: users wait without knowing whether the system is still working or has already finished. A Slack message closes this gap and keeps the review cycle moving in the channel where it started.

## User stories

- Phoebe can see a Slack message in the spec thread after Autocatalyst finishes processing her Notion comments
- Phoebe can tell from the message how many comments were addressed in the run
- Enzo can start his next review pass immediately after receiving the completion message, without checking Notion or the logs first

## Design changes

Backend-only — no UI changes.

## Technical changes

### Affected files

- `src/core/orchestrator.ts` — add `postMessage` to `OrchestratorDeps`; call it at the end of `_handleSpecFeedback()` after comment resolution
- `src/index.ts` — wire `postMessage` into the orchestrator deps at construction time
- `tests/core/orchestrator.test.ts` — extend existing `_handleSpecFeedback` tests to assert the completion message is posted

### Changes

**`OrchestratorDeps` — add `postMessage` callback**

Add a `postMessage` field alongside the existing `postError`:

```typescript
interface OrchestratorDeps {
  // ... existing fields ...
  postError: (channel_id: string, thread_ts: string, text: string) => Promise<void>;
  postMessage: (channel_id: string, thread_ts: string, text: string) => Promise<void>;
}
```

`postError` retains its existing name and semantics. `postMessage` is used for non-error notifications.

**`_handleSpecFeedback()` — post completion message**

After the comment dispatch block (after line 215 in the current file), before `this.transition(run, 'review')`:

```typescript
// Step 5: Notify user that comment processing is complete
const count = commentResponses?.length ?? 0;
const noun = count === 1 ? 'comment' : 'comments';
const summary = count > 0
  ? `Done — responded to ${count} ${noun}. The spec is ready for another look.`
  : `Done — the spec has been updated. Ready for another look.`;
try {
  await this.deps.postMessage(feedback.channel_id, feedback.thread_ts, summary);
} catch (err) {
  this.logger.error({ event: 'run.notify_failed', run_id: run.id, error: String(err) }, 'Failed to post completion notification');
}

this.transition(run, 'review');
```

The notification is best-effort: a failure logs an error but does not fail the run or prevent the transition to `review`.

**`src/index.ts` — wire `postMessage`**

In the orchestrator constructor call, pass `postMessage` using the same `SlackAdapter` method used for `postError`. The parent feature's `slack-adapter.ts` already has a `postMessage()` method at line 225 — wire it directly:

```typescript
postMessage: (channel_id, thread_ts, text) =>
  slackAdapter.postMessage(channel_id, thread_ts, text),
```

## Task list

*(Added by task decomposition stage)*
