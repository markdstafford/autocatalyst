// tests/adapters/agent/issue-filer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentSDKIssueFiler,
  parseRelayMessage,
  buildEnrichmentPrompt,
  buildSummary,
  readAndValidateEnrichmentResult,
} from '../../../src/adapters/agent/issue-filer.js';
import type { FiledIssue } from '../../../src/adapters/agent/issue-filer.js';
import type { IssueManager } from '../../../src/adapters/agent/issue-manager.js';
import type { Request } from '../../../src/types/events.js';

const nullDest = { write: () => {} };

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    id: 'request-001',
    source: 'slack',
    content: 'please file these: 1) add dark mode 2) fix login redirect',
    author: 'U123',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

function makeIssueManager(overrides: Partial<IssueManager> = {}): IssueManager {
  return {
    writeIssue: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue(42),
    create: vi.fn().mockResolvedValue({ number: 42 }),
    ...overrides,
  };
}

function makeQueryFn() {
  return vi.fn().mockReturnValue((async function* () {})());
}

function makeThrowingQueryFn(message: string) {
  return vi.fn().mockReturnValue((async function* () {
    throw new Error(message);
  })());
}

function makeQueryFnWithMessages(messages: unknown[]) {
  return vi.fn().mockReturnValue((async function* () {
    for (const msg of messages) yield msg;
  })());
}

function makeAssistantMsg(text: string): object {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

function makeReadFileFn(result: object) {
  return vi.fn().mockResolvedValue(JSON.stringify(result));
}

function makeEnrichmentResult(items: Array<{
  proposed_title?: string;
  proposed_body?: string;
  proposed_labels?: string[];
  duplicate_of?: { number: number; title: string } | null;
}>) {
  return {
    status: 'complete' as const,
    items: items.map(item => ({
      proposed_title: item.proposed_title ?? 'Test Title',
      proposed_body: item.proposed_body ?? 'Test body',
      proposed_labels: item.proposed_labels ?? [],
      duplicate_of: item.duplicate_of ?? null,
    })),
  };
}

let tempRoot: string;
let enrichmentDir: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'filer-test-'));
  enrichmentDir = join(tempRoot, '.autocatalyst');
  mkdirSync(enrichmentDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Prompt structure
// ---------------------------------------------------------------------------

describe('buildEnrichmentPrompt — structure', () => {
  it('contains mm:issue-triage instruction', () => {
    const prompt = buildEnrichmentPrompt(makeRequest(), '/ws/.autocatalyst/enrichment-result.json');
    expect(prompt).toContain('mm:issue-triage');
  });

  it('contains request content in >>> delimiters', () => {
    const req = makeRequest({ content: 'please file these: 1) dark mode 2) fix login' });
    const prompt = buildEnrichmentPrompt(req, '/ws/.autocatalyst/enrichment-result.json');
    expect(prompt).toContain('>>>');
    expect(prompt).toContain('please file these: 1) dark mode 2) fix login');
  });

  it('contains explicit "Do NOT create GitHub issues" instruction', () => {
    const prompt = buildEnrichmentPrompt(makeRequest(), '/ws/.autocatalyst/enrichment-result.json');
    expect(prompt).toContain('Do NOT create GitHub issues');
  });

  it('contains duplicate detection instructions', () => {
    const prompt = buildEnrichmentPrompt(makeRequest(), '/ws/.autocatalyst/enrichment-result.json');
    expect(prompt).toContain('duplicate_of');
    expect(prompt).toContain('leave a comment on the existing issue');
  });

  it('contains the enrichment result file path and expected JSON schema', () => {
    const filePath = '/my/workspace/.autocatalyst/enrichment-result.json';
    const prompt = buildEnrichmentPrompt(makeRequest(), filePath);
    expect(prompt).toContain(filePath);
    expect(prompt).toContain('"status"');
    expect(prompt).toContain('"items"');
    expect(prompt).toContain('"proposed_title"');
  });
});

// ---------------------------------------------------------------------------
// Enrichment result validation
// ---------------------------------------------------------------------------

describe('readAndValidateEnrichmentResult — validation', () => {
  it('throws with path context when file is missing (ENOENT)', async () => {
    const readFn = vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await expect(readAndValidateEnrichmentResult(readFn, '/fake/path.json'))
      .rejects.toThrow('/fake/path.json');
  });

  it('throws with path context when JSON is invalid', async () => {
    const readFn = vi.fn().mockResolvedValue('not json {{{');
    await expect(readAndValidateEnrichmentResult(readFn, '/fake/path.json'))
      .rejects.toThrow('/fake/path.json');
  });

  it('throws when status is neither complete nor failed', async () => {
    const readFn = vi.fn().mockResolvedValue(JSON.stringify({ status: 'pending', items: [] }));
    await expect(readAndValidateEnrichmentResult(readFn, '/fake/path.json'))
      .rejects.toThrow('invalid status');
  });

  it('throws when items is missing', async () => {
    const readFn = vi.fn().mockResolvedValue(JSON.stringify({ status: 'complete' }));
    await expect(readAndValidateEnrichmentResult(readFn, '/fake/path.json'))
      .rejects.toThrow('"items" array');
  });

  it('throws when non-duplicate item is missing proposed_title', async () => {
    const readFn = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'complete',
      items: [{ proposed_title: '', proposed_body: 'body', proposed_labels: [], duplicate_of: null }],
    }));
    await expect(readAndValidateEnrichmentResult(readFn, '/fake/path.json'))
      .rejects.toThrow('proposed_title');
  });

  it('throws when non-duplicate item is missing proposed_body', async () => {
    const readFn = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'complete',
      items: [{ proposed_title: 'title', proposed_body: '', proposed_labels: [], duplicate_of: null }],
    }));
    await expect(readAndValidateEnrichmentResult(readFn, '/fake/path.json'))
      .rejects.toThrow('proposed_body');
  });

  it('throws when duplicate_of is not null and not a valid object', async () => {
    const readFn = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'complete',
      items: [{ duplicate_of: { number: 'not-a-number', title: 'some title' } }],
    }));
    await expect(readAndValidateEnrichmentResult(readFn, '/fake/path.json'))
      .rejects.toThrow('duplicate_of');
  });
});

// ---------------------------------------------------------------------------
// Creation phase — IssueManager.create() interactions
// ---------------------------------------------------------------------------

describe('AgentSDKIssueFiler.file() — creation phase', () => {
  it('single new item: create() called once with title/body/labels; number appears in filed_issues', async () => {
    const im = makeIssueManager({ create: vi.fn().mockResolvedValue({ number: 99 }) });
    const filer = new AgentSDKIssueFiler(im, {
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn(makeEnrichmentResult([
        { proposed_title: 'Add dark mode', proposed_body: 'Body text', proposed_labels: ['enhancement'] },
      ])),
    });

    const result = await filer.file(makeRequest(), tempRoot);

    expect(im.create).toHaveBeenCalledTimes(1);
    expect(im.create).toHaveBeenCalledWith(tempRoot, 'Add dark mode', 'Body text', ['enhancement']);
    expect(result.filed_issues).toHaveLength(1);
    expect(result.filed_issues[0]).toEqual({ number: 99, title: 'Add dark mode', action: 'filed' });
  });

  it('single duplicate: create() not called; duplicate values in filed_issues', async () => {
    const im = makeIssueManager();
    const filer = new AgentSDKIssueFiler(im, {
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn(makeEnrichmentResult([
        { duplicate_of: { number: 45, title: 'Existing issue' } },
      ])),
    });

    const result = await filer.file(makeRequest(), tempRoot);

    expect(im.create).not.toHaveBeenCalled();
    expect(result.filed_issues).toHaveLength(1);
    expect(result.filed_issues[0]).toEqual({ number: 45, title: 'Existing issue', action: 'duplicate' });
  });

  it('mixed batch (2 new + 1 duplicate): create() called exactly twice; 3 entries with correct actions', async () => {
    let callCount = 0;
    const im = makeIssueManager({
      create: vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ number: 100 + callCount });
      }),
    });
    const filer = new AgentSDKIssueFiler(im, {
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn(makeEnrichmentResult([
        { proposed_title: 'Issue A', proposed_body: 'Body A', proposed_labels: [] },
        { duplicate_of: { number: 55, title: 'Duplicate' } },
        { proposed_title: 'Issue B', proposed_body: 'Body B', proposed_labels: ['bug'] },
      ])),
    });

    const result = await filer.file(makeRequest(), tempRoot);

    expect(im.create).toHaveBeenCalledTimes(2);
    expect(result.filed_issues).toHaveLength(3);
    expect(result.filed_issues[0].action).toBe('filed');
    expect(result.filed_issues[1].action).toBe('duplicate');
    expect(result.filed_issues[2].action).toBe('filed');
  });

  it('all duplicates: create() never called', async () => {
    const im = makeIssueManager();
    const filer = new AgentSDKIssueFiler(im, {
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn(makeEnrichmentResult([
        { duplicate_of: { number: 10, title: 'Dup 1' } },
        { duplicate_of: { number: 11, title: 'Dup 2' } },
      ])),
    });

    const result = await filer.file(makeRequest(), tempRoot);

    expect(im.create).not.toHaveBeenCalled();
    expect(result.filed_issues.every(i => i.action === 'duplicate')).toBe(true);
  });

  it('empty items: create() never called; filed_issues empty', async () => {
    const im = makeIssueManager();
    const filer = new AgentSDKIssueFiler(im, {
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn({ status: 'complete', items: [] }),
    });

    const result = await filer.file(makeRequest(), tempRoot);

    expect(im.create).not.toHaveBeenCalled();
    expect(result.filed_issues).toHaveLength(0);
  });

  it('create() throws: error propagates from file()', async () => {
    const im = makeIssueManager({ create: vi.fn().mockRejectedValue(new Error('gh failed')) });
    const filer = new AgentSDKIssueFiler(im, {
      queryFn: makeQueryFn(),
      logDestination: nullDest,
      readFile: makeReadFileFn(makeEnrichmentResult([
        { proposed_title: 'Title', proposed_body: 'Body', proposed_labels: [] },
      ])),
    });

    await expect(filer.file(makeRequest(), tempRoot)).rejects.toThrow('gh failed');
  });
});

// ---------------------------------------------------------------------------
// Summary building
// ---------------------------------------------------------------------------

describe('buildSummary', () => {
  it('all new: contains filed count; no duplicate language', () => {
    const issues: FiledIssue[] = [
      { number: 1, title: 'A', action: 'filed' },
      { number: 2, title: 'B', action: 'filed' },
    ];
    const summary = buildSummary(issues);
    expect(summary).toContain('2');
    expect(summary).toContain('#1 A');
    expect(summary).toContain('#2 B');
    expect(summary).not.toContain('existing');
  });

  it('all duplicates: contains existing count; no "filed" language', () => {
    const issues: FiledIssue[] = [
      { number: 45, title: 'Old', action: 'duplicate' },
    ];
    const summary = buildSummary(issues);
    expect(summary).toContain('#45 Old');
    expect(summary).toContain('existing');
    expect(summary).not.toContain('Filed');
  });

  it('mixed: both sections present', () => {
    const issues: FiledIssue[] = [
      { number: 10, title: 'New', action: 'filed' },
      { number: 45, title: 'Old', action: 'duplicate' },
    ];
    const summary = buildSummary(issues);
    expect(summary).toContain('#10 New');
    expect(summary).toContain('#45 Old');
  });
});

// ---------------------------------------------------------------------------
// Progress forwarding
// ---------------------------------------------------------------------------

describe('AgentSDKIssueFiler.file() — progress', () => {
  it('[Relay] messages forwarded to onProgress', async () => {
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const filer = new AgentSDKIssueFiler(makeIssueManager(), {
      queryFn: makeQueryFnWithMessages([
        makeAssistantMsg('[Relay] Investigating item 1 of 2'),
      ]),
      logDestination: nullDest,
      readFile: makeReadFileFn({ status: 'complete', items: [] }),
    });

    await filer.file(makeRequest(), tempRoot, onProgress);

    // Wait for fire-and-forget promise
    await new Promise(r => setTimeout(r, 10));
    expect(onProgress).toHaveBeenCalledWith('Investigating item 1 of 2');
  });

  it('no onProgress provided: no error thrown', async () => {
    const filer = new AgentSDKIssueFiler(makeIssueManager(), {
      queryFn: makeQueryFnWithMessages([makeAssistantMsg('[Relay] Some message')]),
      logDestination: nullDest,
      readFile: makeReadFileFn({ status: 'complete', items: [] }),
    });

    await expect(filer.file(makeRequest(), tempRoot)).resolves.not.toThrow();
  });

  it('onProgress throws: error swallowed; enrichment continues', async () => {
    const onProgress = vi.fn().mockRejectedValue(new Error('Slack down'));
    const filer = new AgentSDKIssueFiler(makeIssueManager(), {
      queryFn: makeQueryFnWithMessages([makeAssistantMsg('[Relay] Working...')]),
      logDestination: nullDest,
      readFile: makeReadFileFn({ status: 'complete', items: [] }),
    });

    await expect(filer.file(makeRequest(), tempRoot, onProgress)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseRelayMessage
// ---------------------------------------------------------------------------

describe('parseRelayMessage', () => {
  it('extracts [Relay] message from text block', () => {
    const content = [{ type: 'text' as const, text: 'Some output\n[Relay] Progress update here\nMore output' }];
    expect(parseRelayMessage(content)).toBe('Progress update here');
  });

  it('returns null when no [Relay] tag present', () => {
    const content = [{ type: 'text' as const, text: 'No relay here' }];
    expect(parseRelayMessage(content)).toBeNull();
  });
});
