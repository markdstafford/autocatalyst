import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSDKImplementer, parseRelayMessage } from '../../../src/adapters/agent/implementer.js';

const nullDest = { write: () => {} };

function makeQueryFn() {
  return vi.fn().mockReturnValue((async function* () {})());
}

function makeReadFileFn(result: object) {
  return vi.fn().mockResolvedValue(JSON.stringify(result));
}

function makeImpl(result: object, queryFn = makeQueryFn()) {
  return {
    impl: new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn,
      readFile: makeReadFileFn(result),
    }),
    queryFn,
  };
}

function makeAssistantMsg(text: string): object {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function makeQueryFnWithMessages(messages: unknown[]) {
  return vi.fn().mockReturnValue((async function* () {
    for (const msg of messages) yield msg;
  })());
}

let tmpDir: string;
let specPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'impl-test-'));
  specPath = join(tmpDir, 'spec.md');
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('AgentSDKImplementer — query invocation', () => {
  it('calls queryFn with cwd set to workspace_path', async () => {
    const queryFn = makeQueryFn();
    const impl = new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn,
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir);

    expect(queryFn).toHaveBeenCalledOnce();
    const call = queryFn.mock.calls[0][0] as { options: { cwd: string } };
    expect(call.options.cwd).toBe(tmpDir);
  });

  it('calls queryFn with permissionMode: bypassPermissions', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });

    await impl.implement(specPath, tmpDir);

    const call = queryFn.mock.calls[0][0] as { options: { permissionMode: string } };
    expect(call.options.permissionMode).toBe('bypassPermissions');
  });

  it('prompt contains spec_path', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });

    await impl.implement(specPath, tmpDir);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain(specPath);
  });

  it('prompt contains result file path under .autocatalyst/', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });

    await impl.implement(specPath, tmpDir);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    const expectedPath = join(tmpDir, '.autocatalyst', 'impl-result.json');
    expect(call.prompt).toContain(expectedPath);
  });

  it('prompt contains writing-plans step on initial invocation', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });

    await impl.implement(specPath, tmpDir);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('writing-plans');
  });

  it('prompt does not contain additional context when not provided', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });

    await impl.implement(specPath, tmpDir);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).not.toMatch(/additional context/i);
  });

  it('prompt includes additional context when provided', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });

    await impl.implement(specPath, tmpDir, 'go with the subtype approach');

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('go with the subtype approach');
    expect(call.prompt).toMatch(/additional context/i);
  });

  it('prompt skips writing-plans and contains Skip Step 1 on re-invocation', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });

    await impl.implement(specPath, tmpDir, 'continue from here');

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('Skip Step 1');
    expect(call.prompt).not.toContain('/superpowers:writing-plans');
  });
});

describe('AgentSDKImplementer — result parsing (complete)', () => {
  it('returns complete result with summary and testing_instructions', async () => {
    const { impl } = makeImpl({ status: 'complete', summary: 'Implementation done.', testing_instructions: 'Pull branch, run npm test' });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.status).toBe('complete');
    expect(result.summary).toBe('Implementation done.');
    expect(result.testing_instructions).toBe('Pull branch, run npm test');
    expect(result.question).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('multi-line summary is preserved', async () => {
    const summary = 'Line 1\nLine 2\nLine 3';
    const { impl } = makeImpl({ status: 'complete', summary, testing_instructions: 'Run tests' });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.summary).toBe(summary);
  });

  it('multi-line testing_instructions is preserved', async () => {
    const instructions = 'Pull branch spec/my-feature\nnpm install\nnpm test';
    const { impl } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: instructions });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.testing_instructions).toBe(instructions);
  });
});

describe('AgentSDKImplementer — result parsing (needs_input)', () => {
  it('returns needs_input result with question', async () => {
    const { impl } = makeImpl({ status: 'needs_input', question: 'Should I use approach A or B?' });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.status).toBe('needs_input');
    expect(result.question).toBe('Should I use approach A or B?');
    expect(result.summary).toBeUndefined();
    expect(result.testing_instructions).toBeUndefined();
  });
});

describe('AgentSDKImplementer — result parsing (failed)', () => {
  it('returns failed result with error', async () => {
    const { impl } = makeImpl({ status: 'failed', error: 'Could not find the config file.' });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Could not find the config file.');
  });
});

describe('AgentSDKImplementer — error cases', () => {
  it('throws with result file not found message when ENOENT after agent completes', async () => {
    const queryFn = makeQueryFn();
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const readFile = vi.fn().mockRejectedValue(enoentError);
    const impl = new AgentSDKImplementer({ logDestination: nullDest, queryFn, readFile });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/result file not found/i);
  });

  it('throws when result file is not valid JSON', async () => {
    const queryFn = makeQueryFn();
    const readFile = vi.fn().mockResolvedValue('not json');
    const impl = new AgentSDKImplementer({ logDestination: nullDest, queryFn, readFile });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/not valid JSON/i);
  });

  it('throws when status field is missing', async () => {
    const queryFn = makeQueryFn();
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ summary: 'hi' }));
    const impl = new AgentSDKImplementer({ logDestination: nullDest, queryFn, readFile });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/STATUS/i);
  });

  it('throws when status is an invalid value', async () => {
    const queryFn = makeQueryFn();
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ status: 'unknown' }));
    const impl = new AgentSDKImplementer({ logDestination: nullDest, queryFn, readFile });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/STATUS|invalid/i);
  });

  it('throws when queryFn iterator throws', async () => {
    const queryFn = vi.fn().mockReturnValue((async function* () {
      throw new Error('agent crashed');
    })());
    const impl = new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn,
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/agent crashed/);
  });
});

describe('AgentSDKImplementer — logging', () => {
  it('impl.agent_invoked logged before query with has_additional_context: false', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const impl = new AgentSDKImplementer({
      logDestination: dest,
      queryFn: makeQueryFn(),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir);

    const invoked = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'impl.agent_invoked');
    expect(invoked).toBeDefined();
    expect(invoked!['has_additional_context']).toBe(false);
  });

  it('impl.agent_invoked logged with has_additional_context: true when additional context provided', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const impl = new AgentSDKImplementer({
      logDestination: dest,
      queryFn: makeQueryFn(),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir, 'use approach A');

    const invoked = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'impl.agent_invoked');
    expect(invoked!['has_additional_context']).toBe(true);
  });

  it('impl.agent_completed logged on success with correct status', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const impl = new AgentSDKImplementer({
      logDestination: dest,
      queryFn: makeQueryFn(),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir);

    const completed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'impl.agent_completed');
    expect(completed).toBeDefined();
    expect(completed!['status']).toBe('complete');
  });

  it('impl.agent_failed logged when queryFn iterator throws', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const queryFn = vi.fn().mockReturnValue((async function* () {
      throw new Error('fail');
    })());
    const impl = new AgentSDKImplementer({
      logDestination: dest,
      queryFn,
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow();

    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'impl.agent_failed');
    expect(failed).toBeDefined();
  });
});

describe('parseRelayMessage', () => {
  it('single relay line: returns text after [Relay], trimmed', () => {
    const content = [{ type: 'text' as const, text: '[Relay] Planning started' }];
    expect(parseRelayMessage(content as never)).toBe('Planning started');
  });

  it('first of multiple relay lines: returns only the first', () => {
    const content = [{ type: 'text' as const, text: '[Relay] First\n[Relay] Second' }];
    expect(parseRelayMessage(content as never)).toBe('First');
  });

  it('relay line among non-relay lines: returns correct extraction', () => {
    const content = [{ type: 'text' as const, text: 'line one\n[Relay] Found it\nline three' }];
    expect(parseRelayMessage(content as never)).toBe('Found it');
  });

  it('no relay line: returns null', () => {
    const content = [{ type: 'text' as const, text: 'just regular text' }];
    expect(parseRelayMessage(content as never)).toBeNull();
  });

  it('tool-use block only: returns null', () => {
    const content = [{ type: 'tool_use' as const, id: 'x', name: 'bash', input: {} }];
    expect(parseRelayMessage(content as never)).toBeNull();
  });

  it('empty content array: returns null', () => {
    expect(parseRelayMessage([])).toBeNull();
  });

  it('case-sensitive prefix: [relay] lowercase and [Relay]: with colon do not match', () => {
    const content = [{ type: 'text' as const, text: '[relay] lowercase\n[Relay]: with colon' }];
    expect(parseRelayMessage(content as never)).toBeNull();
  });

  it('multi-block content: relay line in second block is found', () => {
    const content = [
      { type: 'text' as const, text: 'no relay here' },
      { type: 'text' as const, text: '[Relay] In second block' },
    ];
    expect(parseRelayMessage(content as never)).toBe('In second block');
  });
});

describe('AgentSDKImplementer — drain loop relay detection', () => {
  it('relay line forwarded: onProgress called once with extracted text', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const impl = new AgentSDKImplementer({
      logDestination: dest,
      queryFn: makeQueryFnWithMessages([makeAssistantMsg('[Relay] Task 1 of 3: Starting')]),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir, undefined, onProgress);
    await new Promise(r => setTimeout(r, 0));

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith('Task 1 of 3: Starting');
    const progressLog = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'progress_update');
    expect(progressLog).toBeDefined();
    expect(progressLog!['phase']).toBe('implementation');
    expect(progressLog!['message']).toBe('Task 1 of 3: Starting');
  });

  it('non-relay assistant turn: onProgress not called', async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const impl = new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn: makeQueryFnWithMessages([makeAssistantMsg('Just a regular message')]),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir, undefined, onProgress);
    await new Promise(r => setTimeout(r, 0));

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('non-assistant messages ignored: onProgress not called', async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const nonAssistantMessages = [
      { type: 'tool_progress', content: 'something' },
      { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 0, num_turns: 1, result: '', session_id: 'x', is_error: false },
    ];
    const impl = new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn: makeQueryFnWithMessages(nonAssistantMessages),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir, undefined, onProgress);
    await new Promise(r => setTimeout(r, 0));

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('tool-use-only assistant message: onProgress not called', async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const toolUseMsg = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'bash', input: { command: 'ls' } }] } };
    const impl = new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn: makeQueryFnWithMessages([toolUseMsg]),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir, undefined, onProgress);
    await new Promise(r => setTimeout(r, 0));

    expect(onProgress).not.toHaveBeenCalled();
  });

  it('failed callback does not throw: implement resolves normally, progress_failed logged', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const onProgress = vi.fn().mockRejectedValue(new Error('Slack down'));
    const impl = new AgentSDKImplementer({
      logDestination: dest,
      queryFn: makeQueryFnWithMessages([makeAssistantMsg('[Relay] Starting')]),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    const result = await impl.implement(specPath, tmpDir, undefined, onProgress);
    await new Promise(r => setTimeout(r, 0));

    expect(result.status).toBe('complete');
    const failLog = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'progress_failed');
    expect(failLog).toBeDefined();
    expect(failLog!['phase']).toBe('implementation');
    expect(failLog!['error']).toContain('Slack down');
  });

  it('no callback: behavior unchanged, no progress events logged', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const impl = new AgentSDKImplementer({
      logDestination: dest,
      queryFn: makeQueryFnWithMessages([makeAssistantMsg('[Relay] Something')]),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.status).toBe('complete');
    const progressLog = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'progress_update' || l['event'] === 'progress_failed');
    expect(progressLog).toBeUndefined();
  });

  it('multiple relay lines in one turn: onProgress called once (first relay only)', async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const impl = new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn: makeQueryFnWithMessages([makeAssistantMsg('[Relay] First\n[Relay] Second')]),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir, undefined, onProgress);
    await new Promise(r => setTimeout(r, 0));

    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith('First');
  });

  it('relay across multiple messages: onProgress called twice', async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const impl = new AgentSDKImplementer({
      logDestination: nullDest,
      queryFn: makeQueryFnWithMessages([
        makeAssistantMsg('[Relay] First message'),
        makeAssistantMsg('[Relay] Second message'),
      ]),
      readFile: makeReadFileFn({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' }),
    });

    await impl.implement(specPath, tmpDir, undefined, onProgress);
    await new Promise(r => setTimeout(r, 0));

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 'First message');
    expect(onProgress).toHaveBeenNthCalledWith(2, 'Second message');
  });
});

describe('AgentSDKImplementer — status synonym normalization', () => {
  // → complete
  it('"done" normalizes to "complete" — implement resolves with status: complete', async () => {
    const { impl } = makeImpl({ status: 'done', summary: 'Done.', testing_instructions: 'Run tests' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('complete');
  });

  it('"finished" normalizes to "complete"', async () => {
    const { impl } = makeImpl({ status: 'finished', summary: 'Done.', testing_instructions: 'Run tests' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('complete');
  });

  it('"success" normalizes to "complete"', async () => {
    const { impl } = makeImpl({ status: 'success', summary: 'Done.', testing_instructions: 'Run tests' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('complete');
  });

  it('"ok" normalizes to "complete"', async () => {
    const { impl } = makeImpl({ status: 'ok', summary: 'Done.', testing_instructions: 'Run tests' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('complete');
  });

  // → failed
  it('"error" normalizes to "failed" — implement resolves with status: failed', async () => {
    const { impl } = makeImpl({ status: 'error', error: 'Something went wrong.' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('failed');
  });

  it('"failure" normalizes to "failed"', async () => {
    const { impl } = makeImpl({ status: 'failure', error: 'Something went wrong.' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('failed');
  });

  it('"crashed" normalizes to "failed"', async () => {
    const { impl } = makeImpl({ status: 'crashed', error: 'Something went wrong.' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('failed');
  });

  // → needs_input
  it('"pending" normalizes to "needs_input" — implement resolves with status: needs_input', async () => {
    const { impl } = makeImpl({ status: 'pending', question: 'Which approach?' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('needs_input');
  });

  it('"blocked" normalizes to "needs_input"', async () => {
    const { impl } = makeImpl({ status: 'blocked', question: 'Which approach?' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('needs_input');
  });

  it('"waiting" normalizes to "needs_input"', async () => {
    const { impl } = makeImpl({ status: 'waiting', question: 'Which approach?' });
    const result = await impl.implement(specPath, tmpDir);
    expect(result.status).toBe('needs_input');
  });

  // Truly invalid values still throw
  it('"unknown" still throws STATUS error — normalization does not obscure truly invalid values', async () => {
    const queryFn = makeQueryFn();
    const readFile = vi.fn().mockResolvedValue(JSON.stringify({ status: 'unknown' }));
    const impl = new AgentSDKImplementer({ logDestination: nullDest, queryFn, readFile });
    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/STATUS|invalid/i);
  });
});

describe('AgentSDKImplementer — prompt negative example', () => {
  it('prompt contains negative example forbidding "done" synonym', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });
    await impl.implement(specPath, tmpDir);
    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toMatch(/do not use synonyms/i);
  });

  it('prompt contains negative example forbidding "error" synonym', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });
    await impl.implement(specPath, tmpDir);
    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('"error"');
  });

  it('prompt contains negative example forbidding "pending" synonym', async () => {
    const { impl, queryFn } = makeImpl({ status: 'complete', summary: 'Done.', testing_instructions: 'Run tests' });
    await impl.implement(specPath, tmpDir);
    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('"pending"');
  });
});
