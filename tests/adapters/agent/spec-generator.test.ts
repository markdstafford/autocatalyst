// tests/adapters/agent/spec-generator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OMCSpecGenerator } from '../../../src/adapters/agent/spec-generator.js';
import type { Idea, SpecFeedback } from '../../../src/types/events.js';
import type { NotionCommentResponse } from '../../../src/adapters/agent/spec-generator.js';

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

function makeFeedback(overrides: Partial<SpecFeedback> = {}): SpecFeedback {
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

function makeArtifact(filenameLineContent: string, body: string): string {
  return `# claude advisor artifact\n\n## Raw output\n\n\`\`\`text\n${filenameLineContent}\n${body}\n\`\`\`\n`;
}

function makeRevisionArtifact(rawContent: string): string {
  // rawContent is placed in the ## Raw output section
  // After Task 9, revise() will parse it as JSON
  // So rawContent should be a JSON string like: JSON.stringify({ spec: "...", comment_responses: [] })
  return `# claude advisor artifact\n\n## Raw output\n\n\`\`\`text\n${rawContent}\n\`\`\`\n`;
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'sg-test-'));
  // Create workspace structure
  mkdirSync(join(tempRoot, 'context-human', 'specs'), { recursive: true });
  mkdirSync(join(tempRoot, '.omc', 'artifacts', 'ask'), { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function writeArtifactFile(content: string): string {
  const artifactPath = join(tempRoot, '.omc', 'artifacts', 'ask', 'test-artifact.md');
  writeFileSync(artifactPath, content, 'utf-8');
  return artifactPath;
}

describe('SpecGenerator.create', () => {
  it('spawns OMC with cwd set to workspace_path and returns spec path', async () => {
    const artifact = makeArtifact('FILENAME: feature-setup-wizard.md', '# My Spec\n\ncontent here');
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    expect(execFn).toHaveBeenCalledWith(
      'omc',
      expect.arrayContaining(['ask', 'claude', '--print']),
      { cwd: tempRoot },
    );
    expect(result).toBe(join(tempRoot, 'context-human', 'specs', 'feature-setup-wizard.md'));
  });

  it('correctly parses FILENAME: feature-setup-wizard.md', async () => {
    const artifact = makeArtifact('FILENAME: feature-setup-wizard.md', '# Spec content');
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('# Spec content');
  });

  it('correctly parses FILENAME: enhancement-some-thing.md', async () => {
    const artifact = makeArtifact('FILENAME: enhancement-some-thing.md', '# Enhancement');
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    expect(result).toContain('enhancement-some-thing.md');
  });

  it('throws on FILENAME: invalid_name.md (underscore)', async () => {
    const artifact = makeArtifact('FILENAME: invalid_name.md', '# Spec');
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/Invalid spec filename/);
  });

  it('throws on FILENAME: setup-wizard.md (missing feature-/enhancement- prefix)', async () => {
    const artifact = makeArtifact('FILENAME: setup-wizard.md', '# Spec');
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/Invalid spec filename/);
  });

  it('throws when FILENAME: line is absent', async () => {
    const artifact = makeArtifact('this is not a filename line', '# Spec');
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/FILENAME/);
  });

  it('throws if OMC exits non-zero', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('omc crashed'));

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await expect(sg.create(makeIdea(), tempRoot)).rejects.toThrow(/OMC failed/);
  });

  it('writes the correct spec body to the path and excludes the FILENAME line', async () => {
    const artifact = makeArtifact('FILENAME: feature-setup-wizard.md', '# My Spec\n\nSome content here.');
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.create(makeIdea(), tempRoot);

    const written = readFileSync(result, 'utf-8');
    expect(written).toContain('# My Spec');
    expect(written).not.toContain('FILENAME:');
  });
});

describe('SpecGenerator.revise', () => {
  it('prompt leads with feedback in <<<>>>, follows with spec content in <<<>>>', async () => {
    const artifact = makeRevisionArtifact(JSON.stringify({ spec: '# Revised Spec', comment_responses: [] }));
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const args = execFn.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1]; // --print <prompt>
    expect(prompt).toContain('<<<\nthe wizard should not require');
    expect(prompt).toContain('<<<\n# Original Spec');
    const feedbackIdx = prompt.indexOf('the wizard should not require');
    const specIdx = prompt.indexOf('# Original Spec');
    expect(feedbackIdx).toBeLessThan(specIdx); // feedback before spec
    expect(result).toEqual([]);
  });

  it('reads the current spec from spec_path before invoking OMC', async () => {
    const artifact = makeRevisionArtifact(JSON.stringify({ spec: '# Revised', comment_responses: [] }));
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec Content', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    // The current spec content should be in the prompt
    const args = execFn.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toContain('# Original Spec Content');
    expect(result).toEqual([]);
  });

  it('overwrites spec_path in place with revised content', async () => {
    const revisedBody = '# Revised Spec\ncontent\n';
    const artifact = makeRevisionArtifact(JSON.stringify({ spec: revisedBody, comment_responses: [] }));
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const revised = readFileSync(specPath, 'utf-8');
    expect(revised).toBe('# Revised Spec\ncontent\n');
    expect(result).toEqual([]);
  });

  it('returns [] when comment_responses is empty in JSON output', async () => {
    const artifact = makeRevisionArtifact(JSON.stringify({ spec: '# Revised Spec\nsome content\n', comment_responses: [] }));
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const revised = readFileSync(specPath, 'utf-8');
    expect(revised).not.toContain('comment_responses');
    expect(revised).toContain('# Revised Spec');
    expect(result).toEqual([]);
  });

  it('throws if OMC exits non-zero', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('omc crashed'));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/OMC revision failed/);
  });
});

describe('SpecGenerator.revise — Notion comments', () => {
  it('prompt includes [COMMENT_ID:] blocks when notion_comments is non-empty', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({
      spec: '# Revised\n\ncontent',
      comment_responses: [{ comment_id: 'disc-abc', response: 'Updated X' }],
    }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original spec', 'utf-8');

    const comments = [{ id: 'disc-abc', body: 'Phoebe: use inline flow' }];
    await sg.revise(makeFeedback(), comments, specPath, tempRoot);

    const [, args] = execFn.mock.calls[0] as [string, string[]];
    const prompt = args[args.length - 1]; // the last arg to omc is the prompt
    expect(prompt).toContain('[COMMENT_ID: disc-abc]');
    expect(prompt).toContain('Phoebe: use inline flow');
    expect(prompt).toContain('comment_responses');
  });

  it('prompt omits Notion section when notion_comments is []', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({
      spec: '# Revised',
      comment_responses: [],
    }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original spec', 'utf-8');

    await sg.revise(makeFeedback(), [], specPath, tempRoot);

    const [, args] = execFn.mock.calls[0] as [string, string[]];
    const prompt = args[args.length - 1];
    expect(prompt).not.toContain('[COMMENT_ID:');
    expect(prompt).not.toContain('Notion page comments');
  });

  it('valid JSON: spec written to disk, NotionCommentResponse[] returned', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({
      spec: '# Revised\n\ncontent',
      comment_responses: [{ comment_id: 'disc-abc', response: 'Done' }],
    }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const result = await sg.revise(makeFeedback(), [{ id: 'disc-abc', body: 'feedback' }], specPath, tempRoot);

    expect(readFileSync(specPath, 'utf-8')).toBe('# Revised\n\ncontent');
    expect(result).toEqual([{ comment_id: 'disc-abc', response: 'Done' }]);
  });

  it('valid JSON with empty comment_responses: spec written, [] returned', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ spec: '# Revised', comment_responses: [] }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    const result = await sg.revise(makeFeedback(), [], specPath, tempRoot);

    expect(readFileSync(specPath, 'utf-8')).toBe('# Revised');
    expect(result).toEqual([]);
  });

  it('malformed JSON: throws, spec file not modified', async () => {
    const revisionArtifactContent = makeRevisionArtifact('this is not json');
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow();
    expect(readFileSync(specPath, 'utf-8')).toBe('# Original');
  });

  it('missing spec field: throws', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ comment_responses: [] }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/spec/i);
  });

  it('empty spec field: throws', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ spec: '', comment_responses: [] }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/spec/i);
  });

  it('missing comment_responses field: throws', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ spec: '# Revised' }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/comment_responses/i);
  });

  it('comment_responses is not an array: throws', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ spec: '# Revised', comment_responses: 'oops' }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow();
  });

  it('comment_responses entry missing comment_id: throws', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ spec: '# Revised', comment_responses: [{ response: 'done' }] }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/comment_id/i);
  });

  it('comment_responses entry missing response: throws', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ spec: '# Revised', comment_responses: [{ comment_id: 'disc-1' }] }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).rejects.toThrow(/response/i);
  });

  it('extra unknown fields in JSON: tolerated', async () => {
    const revisionArtifactContent = makeRevisionArtifact(JSON.stringify({ spec: '# Revised', comment_responses: [], extra_field: 'ignored' }));
    const artifactPath = writeArtifactFile(revisionArtifactContent);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-wizard.md');
    writeFileSync(specPath, '# Original', 'utf-8');

    await expect(sg.revise(makeFeedback(), [], specPath, tempRoot)).resolves.toEqual([]);
  });
});
