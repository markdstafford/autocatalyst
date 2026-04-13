// tests/adapters/agent/spec-generator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentSDKSpecGenerator } from '../../../src/adapters/agent/spec-generator.js';
import type { Idea, ThreadMessage } from '../../../src/types/events.js';

const nullDest = { write: () => {} };

function makeIdea(overrides: Partial<Idea> = {}): Idea {
  return {
    id: 'idea-001',
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
    idea_id: 'idea-001',
    content: 'the wizard should not require all settings before exiting',
    author: 'U456',
    received_at: new Date().toISOString(),
    thread_ts: '100.0',
    channel_id: 'C123',
    ...overrides,
  };
}

// Returns a queryFn mock that yields a single result message with the given text.
function makeQueryFn(resultText: string) {
  return vi.fn().mockReturnValue((async function* () {
    yield { result: resultText };
  })());
}

// Builds the raw response text for create() — what Claude would return directly.
function makeCreateResponse(filename: string, body: string): string {
  return `FILENAME: ${filename}\n${body}`;
}

// Builds the raw response text for revise() — SPEC/COMMENT_RESPONSES sections directly.
function makeReviseResponse(spec: string, commentResponses: unknown[] = []): string {
  return [
    'SPEC:',
    '<<<',
    spec,
    '>>>',
    '',
    'COMMENT_RESPONSES:',
    '<<<',
    JSON.stringify(commentResponses),
    '>>>',
  ].join('\n');
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'sg-test-'));
  mkdirSync(join(tempRoot, 'context-human', 'specs'), { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('SpecGenerator.create', () => {
  it('calls queryFn with cwd set to workspace_path and returns spec path', async () => {
    const queryFn = makeQueryFn(makeCreateResponse('feature-setup-wizard.md', '# My Spec\n\ncontent here'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    expect(queryFn).toHaveBeenCalledOnce();
    const call = queryFn.mock.calls[0][0] as { options: { cwd: string } };
    expect(call.options.cwd).toBe(tempRoot);
    expect(result).toBe(join(tempRoot, 'context-human', 'specs', 'feature-setup-wizard.md'));
  });

  it('correctly parses FILENAME: feature-setup-wizard.md', async () => {
    const queryFn = makeQueryFn(makeCreateResponse('feature-setup-wizard.md', '# Spec content'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('# Spec content');
  });

  it('correctly parses FILENAME: enhancement-some-thing.md', async () => {
    const queryFn = makeQueryFn(makeCreateResponse('enhancement-some-thing.md', '# Enhancement'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    expect(result).toContain('enhancement-some-thing.md');
  });

  it('throws on FILENAME: invalid_name.md (underscore)', async () => {
    const queryFn = makeQueryFn(makeCreateResponse('invalid_name.md', '# Spec'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/Invalid spec filename/);
  });

  it('throws on FILENAME: setup-wizard.md (missing feature-/enhancement- prefix)', async () => {
    const queryFn = makeQueryFn(makeCreateResponse('setup-wizard.md', '# Spec'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/Invalid spec filename/);
  });

  it('throws when FILENAME: line is absent', async () => {
    const queryFn = makeQueryFn('this is not a filename line\n# Spec');
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/FILENAME/);
  });

  it('throws if queryFn throws', async () => {
    const queryFn = vi.fn().mockReturnValue((async function* () {
      throw new Error('agent crashed');
    })());
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/agent crashed/);
  });

  it('throws if no result text returned', async () => {
    const queryFn = vi.fn().mockReturnValue((async function* () {})());
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/no result/i);
  });

  it('writes the correct spec body to the path and excludes the FILENAME line', async () => {
    const queryFn = makeQueryFn(makeCreateResponse('feature-setup-wizard.md', '# My Spec\n\nSome content here.'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('# My Spec');
    expect(written).not.toContain('FILENAME:');
  });
});

describe('SpecGenerator.revise', () => {
  it('prompt leads with feedback in <<<>>>, follows with spec content in <<<>>>', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised Spec'));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    const { prompt } = call;
    expect(prompt).toContain('<<<\nthe wizard should not require');
    expect(prompt).toContain('<<<\n# Original Spec');
    const feedbackIdx = prompt.indexOf('the wizard should not require');
    const specIdx = prompt.indexOf('# Original Spec');
    expect(feedbackIdx).toBeLessThan(specIdx);
    expect(result.comment_responses).toEqual([]);
  });

  it('reads the current spec from spec_path before invoking agent', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised'));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec Content', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('# Original Spec Content');
  });

  it('overwrites spec_path in place with revised content', async () => {
    const revisedBody = '# Revised Spec\ncontent\n';
    const queryFn = makeQueryFn(makeReviseResponse(revisedBody));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const revised = readFileSync(specPath, 'utf-8');
    expect(revised).toBe('# Revised Spec\ncontent\n');
  });

  it('returns empty comment_responses when none present', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised Spec\nsome content\n'));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    expect(result.comment_responses).toEqual([]);
  });

  it('throws if queryFn throws', async () => {
    const queryFn = vi.fn().mockReturnValue((async function* () {
      throw new Error('agent crashed');
    })());
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/agent crashed/);
  });
});

describe('SpecGenerator.revise — Notion comments', () => {
  it('prompt includes [COMMENT_ID:] blocks when notion_comments is non-empty', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised\n\ncontent', [{ comment_id: 'disc-abc', response: 'Updated X' }]));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original spec', 'utf-8');

    const comments = [{ id: 'disc-abc', body: 'Phoebe: use inline flow' }];
    await sg.revise(makeFeedback(), comments, specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    const { prompt } = call;
    expect(prompt).toContain('[COMMENT_ID: disc-abc]');
    expect(prompt).toContain('Phoebe: use inline flow');
    expect(prompt).toContain('COMMENT_RESPONSES:');
  });

  it('prompt omits Notion section when notion_comments is []', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised', []));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original spec', 'utf-8');

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).not.toContain('[COMMENT_ID:');
    expect(call.prompt).not.toContain('Notion page comments');
  });

  it('spec written to disk, comment_responses returned in ReviseResult', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised\n\ncontent', [{ comment_id: 'disc-abc', response: 'Done' }]));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const result = await sg.revise(makeFeedback(), [{ id: 'disc-abc', body: 'feedback' }], specPath, tempRoot);

    expect(readFileSync(specPath, 'utf-8')).toBe('# Revised\n\ncontent');
    expect(result.comment_responses).toEqual([{ comment_id: 'disc-abc', response: 'Done' }]);
  });

  it('empty comment_responses: spec written, empty array returned', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised', []));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    expect(readFileSync(specPath, 'utf-8')).toBe('# Revised');
    expect(result.comment_responses).toEqual([]);
  });

  it('malformed COMMENT_RESPONSES JSON: throws, spec file not modified', async () => {
    const raw = 'SPEC:\n<<<\n# Revised\n>>>\n\nCOMMENT_RESPONSES:\n<<<\nthis is not json\n>>>';
    const queryFn = makeQueryFn(raw);
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow();
    expect(readFileSync(specPath, 'utf-8')).toBe('# Original');
  });

  it('missing SPEC section: throws', async () => {
    const queryFn = makeQueryFn('COMMENT_RESPONSES:\n<<<\n[]\n>>>');
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/spec/i);
  });

  it('empty SPEC section: throws', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('', []));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/spec/i);
  });

  it('missing COMMENT_RESPONSES section: throws', async () => {
    const queryFn = makeQueryFn('SPEC:\n<<<\n# Revised\n>>>');
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/comment_responses/i);
  });

  it('COMMENT_RESPONSES is not a JSON array: throws', async () => {
    const queryFn = makeQueryFn('SPEC:\n<<<\n# Revised\n>>>\n\nCOMMENT_RESPONSES:\n<<<\n"oops"\n>>>');
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow();
  });

  it('comment_responses entry missing comment_id: throws', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised', [{ response: 'done' }]));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/comment_id/i);
  });

  it('comment_responses entry missing response: throws', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised', [{ comment_id: 'disc-1' }]));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/response/i);
  });

  it('extra fields in comment_responses entries: tolerated', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised', [{ comment_id: 'x', response: 'y', extra_field: 'ignored' }]));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);
    expect(result.comment_responses).toEqual([{ comment_id: 'x', response: 'y' }]);
  });
});

describe('SpecGenerator — response parsing edge cases', () => {
  // These guard against regressions in unwrapFence / extractDelimitedSection.
  // Previously these tested extractRawOutput (OMC artifact format).
  // Now the response text arrives directly — same parsing logic, no artifact wrapper.

  it('create: spec with ASCII art (bare ``` block) is not truncated', async () => {
    const specBody = [
      '# Spec',
      '## Design',
      '```',
      '┌──────┐',
      '│  UI  │',
      '└──────┘',
      '```',
      '## Technical changes',
      'Some technical details.',
    ].join('\n');
    const queryFn = makeQueryFn(makeCreateResponse('feature-ui.md', specBody));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('## Technical changes');
    expect(written).toContain('Some technical details.');
  });

  it('create: spec wrapped in ```markdown by model is fully unwrapped', async () => {
    const innerSpec = [
      '# Spec',
      '## Design',
      '```',
      '┌──────┐',
      '│  UI  │',
      '└──────┘',
      '```',
      '## Technical changes',
      'Some technical details.',
    ].join('\n');
    // Model wraps the spec body in ```markdown...```
    const responseText = ['FILENAME: feature-ui.md', '```markdown', innerSpec, '```'].join('\n');
    const queryFn = makeQueryFn(responseText);
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('## Technical changes');
    expect(written).toContain('Some technical details.');
    expect(written).not.toContain('```markdown');
  });

  it('create: spec with code block immediately before a ## heading is not truncated', async () => {
    const specBody = [
      '## Design',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '## Technical changes',
      'Details here.',
    ].join('\n');
    const queryFn = makeQueryFn(makeCreateResponse('feature-foo.md', specBody));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('## Technical changes');
    expect(written).toContain('Details here.');
  });

  it('create: spec with multiple code blocks and ## headings throughout is fully preserved', async () => {
    const specBody = [
      '## What',
      'Description.',
      '## Design changes',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '### Layout',
      '```',
      '┌──────┐',
      '│  box │',
      '└──────┘',
      '```',
      '### Details',
      '```typescript',
      'const x = 1;',
      '```',
      '## Technical changes',
      'Technical info.',
      '## Task list',
      '- [ ] Task one',
    ].join('\n');
    const queryFn = makeQueryFn(makeCreateResponse('feature-bar.md', specBody));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('## Technical changes');
    expect(written).toContain('## Task list');
    expect(written).toContain('- [ ] Task one');
  });

  it('revise: spec with ASCII art block is not truncated', async () => {
    const revisedSpec = [
      '# Spec',
      '## Design',
      '```',
      '┌──────┐',
      '│  UI  │',
      '└──────┘',
      '```',
      '## Technical changes',
      'Technical info.',
      '## Task list',
      '- [ ] Task one',
    ].join('\n');
    const queryFn = makeQueryFn(makeReviseResponse(revisedSpec));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('## Technical changes');
    expect(written).toContain('## Task list');
    expect(written).toContain('- [ ] Task one');
  });

  it('revise: spec with code block immediately before ## heading is not truncated', async () => {
    const revisedSpec = [
      '# Spec',
      '## Design',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '## Acceptance criteria',
      '- AC one',
    ].join('\n');
    const queryFn = makeQueryFn(makeReviseResponse(revisedSpec));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('## Acceptance criteria');
    expect(written).toContain('- AC one');
  });

  it('revise: spec with multiple code blocks and ## headings throughout is fully preserved', async () => {
    const revisedSpec = [
      '# Spec',
      '## Personas',
      'Eric — power user.',
      '## Design changes',
      '```',
      '┌──────────────┐',
      '│   popover    │',
      '└──────────────┘',
      '```',
      '### User flow',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '### Popover content',
      'Details.',
      '## Technical changes',
      '```typescript',
      'interface Foo { x: string }',
      '```',
      '## Task list',
      '- [ ] Story one',
    ].join('\n');
    const queryFn = makeQueryFn(makeReviseResponse(revisedSpec));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('## Technical changes');
    expect(written).toContain('## Task list');
    expect(written).toContain('- [ ] Story one');
  });
});

describe('SpecGenerator.revise — span passthrough', () => {
  it('uses page markdown as prompt source when current_page_markdown provided with spans', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">commented text</span> here.';
    const queryFn = makeQueryFn(makeReviseResponse('# Revised\n\n<span discussion-urls="discussion://abc">commented text</span> here.'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ncommented text here.', 'utf-8');

    await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('<span discussion-urls="discussion://abc">');
    expect(call.prompt).toContain('discussion-urls');
  });

  it('adds span-preservation instructions when spans present', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    const queryFn = makeQueryFn(makeReviseResponse('# Revised\n\n<span discussion-urls="discussion://abc">text</span>'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ntext', 'utf-8');

    await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('CRITICAL');
    expect(call.prompt).toContain('span');
  });

  it('returns page_content with spans preserved', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    const revisedWithSpan = '# Revised\n\n<span discussion-urls="discussion://abc">text</span>';
    const queryFn = makeQueryFn(makeReviseResponse(revisedWithSpan));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ntext', 'utf-8');

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    expect(result.page_content).toContain('<span discussion-urls="discussion://abc">');
  });

  it('writes stripped (clean) spec to disk when spans present', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">text</span>';
    const revisedWithSpan = '# Revised\n\n<span discussion-urls="discussion://abc">text</span>';
    const queryFn = makeQueryFn(makeReviseResponse(revisedWithSpan));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ntext', 'utf-8');

    await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    const diskContent = readFileSync(specPath, 'utf-8');
    expect(diskContent).not.toContain('<span');
    expect(diskContent).toContain('# Revised');
    expect(diskContent).toContain('text');
  });

  it('appends orphaned spans when Claude drops them', async () => {
    const pageMarkdown = '# Spec\n\n<span discussion-urls="discussion://abc">commented</span> text.';
    const revisedNoSpan = '# Revised\n\ntext without the span.';
    const queryFn = makeQueryFn(makeReviseResponse(revisedNoSpan));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\ncommented text.', 'utf-8');

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    expect(result.page_content).toContain('## Orphaned comments');
    expect(result.page_content).toContain('<span discussion-urls="discussion://abc">commented</span>');
    expect(result.page_content).toContain('[dropped by Claude]');
  });

  it('does not return page_content when no spans in input', async () => {
    const pageMarkdown = '# Spec\n\nno spans here';
    const queryFn = makeQueryFn(makeReviseResponse('# Revised'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Spec\n\nno spans here', 'utf-8');

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot, pageMarkdown);

    expect(result.page_content).toBeUndefined();
  });

  it('falls back to disk spec when no current_page_markdown provided', async () => {
    const queryFn = makeQueryFn(makeReviseResponse('# Revised'));
    const sg = new AgentSDKSpecGenerator({ queryFn, logDestination: nullDest });
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Disk Spec Content', 'utf-8');

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const call = queryFn.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('# Disk Spec Content');
    expect(result.page_content).toBeUndefined();
  });
});
