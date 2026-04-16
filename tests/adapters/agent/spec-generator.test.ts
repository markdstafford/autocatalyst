// tests/adapters/agent/spec-generator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSDKSpecGenerator, parseRelayMessage } from '../../../src/adapters/agent/spec-generator.js';
import type { Request, ThreadMessage } from '../../../src/types/events.js';

const nullDest = { write: () => {} };

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'request-001',
    source: 'slack',
    content: 'add a setup wizard to the CLI',
    author: 'U123',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

function makeFeedback(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    request_id: 'request-001',
    content: 'the wizard should not require all settings before exiting',
    author: 'U456',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

// Empty async iterator — agent "runs" but writes nothing; result file provided via readFile mock.
function makeQueryFn() {
  return vi.fn().mockReturnValue((async function* () {})());
}

// queryFn that writes revisedContent to specPath as a side effect (simulates agent writing the revised spec).
function makeQueryFnWithRevision(specPath: string, revisedContent: string) {
  return vi.fn().mockReturnValue((async function* () {
    writeFileSync(specPath, revisedContent, 'utf-8');
  })());
}

// queryFn that throws during iteration.
function makeThrowingQueryFn(message: string) {
  return vi.fn().mockReturnValue((async function* () {
    throw new Error(message);
  })());
}

// Injects the JSON result file content returned after agent completes.
function makeReadFileFn(result: object) {
  return vi.fn().mockResolvedValue(JSON.stringify(result));
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'sg-test-'));
  mkdirSync(join(tempRoot, 'context-human', 'specs'), { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe('AgentSDKSpecGenerator.create — query invocation', () => {
  it('calls queryFn with cwd set to workspace_path', async () => {
    const queryFn = makeQueryFn();
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest(), tempRoot);

    const call = queryFn.mock.calls[0][0] as { options: { cwd: string } };
    expect(call.options.cwd).toBe(tempRoot);
  });

  it('calls queryFn with permissionMode: bypassPermissions', async () => {
    const queryFn = makeQueryFn();
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest(), tempRoot);

    const call = queryFn.mock.calls[0][0] as { options: { permissionMode: string } };
    expect(call.options.permissionMode).toBe('bypassPermissions');
  });

  it('calls queryFn with settingSources containing user and project', async () => {
    const queryFn = makeQueryFn();
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest(), tempRoot);

    const call = queryFn.mock.calls[0][0] as { options: { settingSources: string[] } };
    expect(call.options.settingSources).toContain('user');
    expect(call.options.settingSources).toContain('project');
  });
});

describe('AgentSDKSpecGenerator.create — prompt', () => {
  it('prompt contains /mm:planning', async () => {
    const queryFn = makeQueryFn();
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest(), tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('/mm:planning');
  });

  it('prompt contains request content', async () => {
    const queryFn = makeQueryFn();
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest({ content: 'build a time machine' }), tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('build a time machine');
  });

  it('prompt contains spec-create-result.json path', async () => {
    const queryFn = makeQueryFn();
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest(), tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    const expectedPath = join(tempRoot, '.autocatalyst', 'spec-create-result.json');
    expect(call.prompt).toContain(expectedPath);
  });
});

describe('AgentSDKSpecGenerator.create — result handling', () => {
  it('returns spec_path from result file', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: specPath }),
    });

    const result = await sg.create(makeRequest(), tempRoot);

    expect(result).toBe(specPath);
  });

  it('throws result file not found when ENOENT after agent completes', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: vi.fn().mockRejectedValue(enoentError),
    });

    await expect(sg.create(makeRequest(), tempRoot)).rejects.toThrow(/result file not found/i);
  });

  it('throws when result file is not valid JSON', async () => {
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: vi.fn().mockResolvedValue('not json'),
    });

    await expect(sg.create(makeRequest(), tempRoot)).rejects.toThrow(/not valid JSON/i);
  });

  it('throws when spec_path is missing from result', async () => {
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ other_field: 'oops' }),
    });

    await expect(sg.create(makeRequest(), tempRoot)).rejects.toThrow(/spec_path/i);
  });

  it('throws when queryFn iterator throws', async () => {
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeThrowingQueryFn('agent crashed'),
      logDestination: nullDest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await expect(sg.create(makeRequest(), tempRoot)).rejects.toThrow(/agent crashed/);
  });
});

describe('AgentSDKSpecGenerator.create — logging', () => {
  it('logs spec.agent_invoked before querying', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: dest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest(), tempRoot);

    const invoked = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'spec.agent_invoked');
    expect(invoked).toBeDefined();
  });

  it('logs spec.agent_completed on success', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: dest,
      readFile: makeReadFileFn({ spec_path: join(tempRoot, 'context-human', 'specs', 'feature-wizard.md') }),
    });

    await sg.create(makeRequest(), tempRoot);

    const completed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'spec.agent_completed');
    expect(completed).toBeDefined();
  });

  it('logs spec.agent_failed when queryFn throws', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => { logs.push(JSON.parse(line)); } };
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeThrowingQueryFn('fail'),
      logDestination: dest,
      readFile: makeReadFileFn({ spec_path: '' }),
    });

    await expect(sg.create(makeRequest(), tempRoot)).rejects.toThrow();

    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'spec.agent_failed');
    expect(failed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// revise()
// ---------------------------------------------------------------------------

describe('AgentSDKSpecGenerator.revise — query invocation', () => {
  it('calls queryFn with cwd: workspace_path', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { options: { cwd: string } };
    expect(call.options.cwd).toBe(tempRoot);
  });

  it('calls queryFn with permissionMode: bypassPermissions', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { options: { permissionMode: string } };
    expect(call.options.permissionMode).toBe('bypassPermissions');
  });
});

describe('AgentSDKSpecGenerator.revise — prompt', () => {
  it('prompt contains feedback content', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback({ content: 'make the wizard optional' }), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('make the wizard optional');
  });

  it('prompt contains spec_path (write target)', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain(specPath);
  });

  it('prompt contains spec-revise-result.json path', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    const expectedPath = join(tempRoot, '.autocatalyst', 'spec-revise-result.json');
    expect(call.prompt).toContain(expectedPath);
  });

  it('prompt contains current spec content from disk', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Content', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('# Original Content');
  });

  it('prompt includes [COMMENT_ID:] blocks when notion_comments non-empty', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [{ comment_id: 'disc-abc', response: 'Done' }] }),
    });

    await sg.revise(makeFeedback(), [{ id: 'disc-abc', body: 'use inline flow' }], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('[COMMENT_ID: disc-abc]');
    expect(call.prompt).toContain('use inline flow');
  });

  it('prompt omits Notion section when notion_comments is []', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).not.toContain('[COMMENT_ID:');
    expect(call.prompt).not.toContain('Notion page comments');
  });
});

describe('AgentSDKSpecGenerator.revise — result handling', () => {
  it('returns comment_responses from result file', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [{ comment_id: 'disc-1', response: 'Fixed it' }] }),
    });

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    expect(result.comment_responses).toEqual([{ comment_id: 'disc-1', response: 'Fixed it' }]);
  });

  it('returns empty comment_responses array when none', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    expect(result.comment_responses).toEqual([]);
  });

  it('throws result file not found when ENOENT after agent completes', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: vi.fn().mockRejectedValue(enoentError),
    });

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/result file not found/i);
  });

  it('throws when result file is not valid JSON', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: vi.fn().mockResolvedValue('not json'),
    });

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/not valid JSON/i);
  });

  it('throws when comment_responses is missing from result', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ other: 'field' }),
    });

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/comment_responses/i);
  });

  it('throws when comment_responses entry missing comment_id', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [{ response: 'done' }] }),
    });

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/comment_id/i);
  });

  it('throws when queryFn iterator throws', async () => {
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeThrowingQueryFn('agent crashed'),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/agent crashed/);
  });
});

// ---------------------------------------------------------------------------
// revise() — span passthrough (uses real fs + makeQueryFnWithRevision)
// ---------------------------------------------------------------------------

describe('AgentSDKSpecGenerator.revise — span passthrough', () => {
  it('uses current_page_markdown (with spans) as prompt source when spans present', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">commented text</span> here.';
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ncommented text here.', 'utf-8');
    const revisedWithSpan = '# Revised\n\n<span discussion-urls="discussion://abc">commented text</span> here.';
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFnWithRevision(specPath, revisedWithSpan),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    // Prompt must contain the span-bearing markdown (not stripped disk content)
    // We can't inspect the prompt from this test because queryFn is overridden;
    // verify via a separate prompt test below.
    const diskContent = readFileSync(specPath, 'utf-8');
    expect(diskContent).not.toContain('<span'); // strips spans when writing back
    expect(diskContent).toContain('# Revised');
  });

  it('adds CRITICAL span-preservation instructions to prompt when spans present', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ntext', 'utf-8');
    const revisedWithSpan = '# Revised\n\n<span discussion-urls="discussion://abc">text</span>';
    // Use a capturing queryFn so we can inspect the prompt
    let capturedPrompt = '';
    const queryFn = vi.fn().mockReturnValue((async function* () {
      writeFileSync(specPath, revisedWithSpan, 'utf-8');
    })());
    // Wrap to capture prompt
    const capturingQueryFn = vi.fn().mockImplementation((arg: { prompt: string }) => {
      capturedPrompt = arg.prompt;
      return queryFn(arg);
    });
    const sg = new AgentSDKSpecGenerator({
      queryFn: capturingQueryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    expect(capturedPrompt).toContain('CRITICAL');
    expect(capturedPrompt).toContain('span');
    expect(capturedPrompt).toContain('<span discussion-urls="discussion://abc">');
  });

  it('returns page_content with spans intact', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ntext', 'utf-8');
    const revisedWithSpan = '# Revised\n\n<span discussion-urls="discussion://abc">text</span>';
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFnWithRevision(specPath, revisedWithSpan),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    expect(result.page_content).toContain('<span discussion-urls="discussion://abc">');
  });

  it('writes stripped (no span tags) spec to disk when spans present', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ntext', 'utf-8');
    const revisedWithSpan = '# Revised\n\n<span discussion-urls="discussion://abc">text</span>';
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFnWithRevision(specPath, revisedWithSpan),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    const diskContent = readFileSync(specPath, 'utf-8');
    expect(diskContent).not.toContain('<span');
    expect(diskContent).toContain('# Revised');
    expect(diskContent).toContain('text');
  });

  it('appends orphaned spans section when agent drops a span', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">commented</span> text.';
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ncommented text.', 'utf-8');
    const revisedNoSpan = '# Revised\n\ntext without the span.';
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFnWithRevision(specPath, revisedNoSpan),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    expect(result.page_content).toContain('## Orphaned comments');
    expect(result.page_content).toContain('<span discussion-urls="discussion://abc">commented</span>');
  });

  it('does not return page_content when no spans in current_page_markdown', async () => {
    const pageMarkdown = '# Spec\n\nno spans here';
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\nno spans here', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    expect(result.page_content).toBeUndefined();
  });

  it('falls back to disk spec when no current_page_markdown provided', async () => {
    const queryFn = makeQueryFn();
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Disk Spec Content', 'utf-8');
    const sg = new AgentSDKSpecGenerator({
      queryFn,
      logDestination: nullDest,
      readFile: makeReadFileFn({ comment_responses: [] }),
    });

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('# Disk Spec Content');
    expect(result.page_content).toBeUndefined();
  });
});

describe('parseRelayMessage (spec-generator)', () => {
  it('single relay line: returns text after [Relay], trimmed', () => {
    const content = [{ type: 'text' as const, text: '[Relay] Analyzing requirements' }];
    expect(parseRelayMessage(content as never)).toBe('Analyzing requirements');
  });

  it('first of multiple relay lines: returns only the first', () => {
    const content = [{ type: 'text' as const, text: '[Relay] First\n[Relay] Second' }];
    expect(parseRelayMessage(content as never)).toBe('First');
  });

  it('relay line among non-relay lines: returns correct extraction', () => {
    const content = [{ type: 'text' as const, text: 'thinking...\n[Relay] Processing comment 2\ndone' }];
    expect(parseRelayMessage(content as never)).toBe('Processing comment 2');
  });

  it('no relay line: returns null', () => {
    const content = [{ type: 'text' as const, text: 'just writing the spec' }];
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
