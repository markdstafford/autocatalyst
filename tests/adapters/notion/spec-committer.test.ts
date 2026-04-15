import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotionSpecCommitter } from '../../../src/adapters/notion/spec-committer.js';
import type { SpecPublisher } from '../../../src/adapters/slack/canvas-publisher.js';

const nullDest = { write: () => {} };

const SAMPLE_MARKDOWN = [
  '---',
  'created: 2026-04-01',
  'last_updated: 2026-04-01',
  'status: draft',
  'specced_by: alice',
  'issue: null',
  'superseded_by: null',
  '---',
  '',
  '# My Feature',
  '',
  'This is the spec body.',
].join('\n');

function makePublisher(markdown: string = SAMPLE_MARKDOWN): SpecPublisher {
  return {
    publish: vi.fn(),
    postMessage: vi.fn(),
    getPageMarkdown: vi.fn().mockResolvedValue(markdown),
    updatePage: vi.fn(),
  } as unknown as SpecPublisher;
}

function makeExecFn(exitCode = 0) {
  const fn = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
    if (exitCode !== 0) throw Object.assign(new Error('git failed'), { code: exitCode });
    // Simulate staged changes present by default: diff --cached --quiet exits non-zero
    if ((args as string[]).includes('diff') && (args as string[]).includes('--cached')) {
      throw Object.assign(new Error('staged changes present'), { code: 1 });
    }
    return { stdout: '', stderr: '' };
  });
  return fn;
}

describe('NotionSpecCommitter — markdown fetching', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('calls getPageMarkdown with the provided publisher_ref', async () => {
    const publisher = makePublisher();
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id-123', specPath);

    expect(publisher.getPageMarkdown).toHaveBeenCalledWith('page-id-123');
  });
});

describe('NotionSpecCommitter — comment span stripping', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('strips comment spans from output', async () => {
    const markdown = [
      '---',
      'created: 2026-04-01',
      'last_updated: 2026-04-01',
      'status: draft',
      '---',
      '',
      '# Title',
      '',
      '<span discussion-urls="discussion://abc">highlighted text</span>',
    ].join('\n');
    const publisher = makePublisher(markdown);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).not.toContain('<span');
    expect(written).toContain('highlighted text');
  });

  it('removes ## Orphaned comments section', async () => {
    const markdown = [
      '---',
      'created: 2026-04-01',
      'last_updated: 2026-04-01',
      'status: draft',
      '---',
      '',
      '# Title',
      '',
      'Body.',
      '',
      '## Orphaned comments',
      '',
      '- <span discussion-urls="discussion://x">orphan</span>',
    ].join('\n');
    const publisher = makePublisher(markdown);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).not.toContain('## Orphaned comments');
    expect(written).not.toContain('orphan');
  });
});

describe('NotionSpecCommitter — markdown prettification', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('ensures blank lines after headers', async () => {
    const markdown = [
      '---',
      'created: 2026-04-01',
      'last_updated: 2026-04-01',
      'status: draft',
      '---',
      '',
      '# Title',
      'No blank line here.',
      '## Section',
      'Also no blank line.',
    ].join('\n');
    const publisher = makePublisher(markdown);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('# Title\n\nNo blank line here.');
    expect(written).toContain('## Section\n\nAlso no blank line.');
  });
});

describe('NotionSpecCommitter — frontmatter normalization', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('sets status to approved', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('status: approved');
    expect(written).not.toContain('status: draft');
  });

  it('sets last_updated to today', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    const today = new Date().toISOString().slice(0, 10);
    expect(written).toContain(`last_updated: ${today}`);
  });

  it('preserves created date from original frontmatter', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN); // has created: 2026-04-01
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('created: 2026-04-01');
  });

  it('preserves other frontmatter fields (specced_by, issue, superseded_by)', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('specced_by: alice');
    expect(written).toContain('issue: null');
    expect(written).toContain('superseded_by: null');
  });

  it('frontmatter is enclosed in --- delimiters', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written.startsWith('---\n')).toBe(true);
    const secondDelimiter = written.indexOf('---', 3);
    expect(secondDelimiter).toBeGreaterThan(3);
  });
});

describe('NotionSpecCommitter — file writing', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes spec to the provided spec_path', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toContain('My Feature');
  });

  it('creates directory if it does not exist', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'deep', 'nested', 'path', 'feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const written = readFileSync(specPath, 'utf-8');
    expect(written).toBeTruthy();
  });
});

describe('NotionSpecCommitter — git operations', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('calls git add with the spec path', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const calls = execFn.mock.calls;
    const addCall = calls.find((c: unknown[]) => c[0] === 'git' && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    expect((addCall![1] as string[]).join(' ')).toContain('feature-my-feature.md');
  });

  it('calls git commit with conventional message including spec title', async () => {
    const publisher = makePublisher(SAMPLE_MARKDOWN); // # My Feature
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const calls = execFn.mock.calls;
    const commitCall = calls.find((c: unknown[]) => c[0] === 'git' && (c[1] as string[]).includes('commit'));
    expect(commitCall).toBeDefined();
    const commitArgs = (commitCall![1] as string[]).join(' ');
    expect(commitArgs).toContain('docs: commit approved spec');
    expect(commitArgs).toContain('My Feature');
  });

  it('git add is called before git commit', async () => {
    const order: string[] = [];
    const execFn = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      if ((args as string[]).includes('add')) order.push('add');
      if ((args as string[]).includes('commit')) order.push('commit');
      // Simulate staged changes so commit is not skipped
      if ((args as string[]).includes('diff') && (args as string[]).includes('--cached')) {
        throw Object.assign(new Error('staged'), { code: 1 });
      }
      return { stdout: '', stderr: '' };
    });
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    expect(order.indexOf('add')).toBeLessThan(order.indexOf('commit'));
  });

  it('git commands run with cwd set to workspace_path', async () => {
    const execFn = makeExecFn();
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    for (const call of execFn.mock.calls as unknown[][]) {
      if (call[0] === 'git') {
        expect((call[2] as { cwd?: string }).cwd).toBe(tmpDir);
      }
    }
  });

  it('skips git commit when nothing is staged (spec already committed)', async () => {
    const execFn = vi.fn().mockImplementation(async (_cmd: string, args: string[]) => {
      // diff --cached --quiet exits 0: no staged changes
      if ((args as string[]).includes('diff') && (args as string[]).includes('--cached')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-id', specPath);

    const commitCall = (execFn.mock.calls as unknown[][]).find(
      c => c[0] === 'git' && (c[1] as string[]).includes('commit'),
    );
    expect(commitCall).toBeUndefined();
  });
});

describe('NotionSpecCommitter — error handling', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('throws when getPageMarkdown rejects; no file written', async () => {
    const publisher = makePublisher();
    (publisher.getPageMarkdown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('notion error'));
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature.md');
    await expect(committer.commit(tmpDir, 'page-id', specPath)).rejects.toThrow();

    // File should not have been written
    expect(() => readFileSync(specPath, 'utf-8')).toThrow();
    expect(execFn).not.toHaveBeenCalled();
  });

  it('throws when fetched markdown is empty', async () => {
    const publisher = makePublisher('');
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature.md');
    await expect(committer.commit(tmpDir, 'page-id', specPath)).rejects.toThrow(/empty|no content/i);
  });

  it('throws when markdown has no YAML frontmatter', async () => {
    const publisher = makePublisher('# Title\n\nBody without frontmatter.');
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature.md');
    await expect(committer.commit(tmpDir, 'page-id', specPath)).rejects.toThrow(/frontmatter/i);
  });

  it('throws when git add fails', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('git add failed'));
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await expect(committer.commit(tmpDir, 'page-id', specPath)).rejects.toThrow();
  });

  it('throws when git commit fails', async () => {
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add succeeds
      .mockRejectedValueOnce(Object.assign(new Error('staged'), { code: 1 })) // diff --cached --quiet: staged changes present
      .mockRejectedValueOnce(new Error('git commit failed')); // git commit fails
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: nullDest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await expect(committer.commit(tmpDir, 'page-id', specPath)).rejects.toThrow();
  });
});

describe('NotionSpecCommitter — logging', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'spec-committer-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('emits spec.committed on success with publisher_ref, spec_path, workspace_path', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const publisher = makePublisher(SAMPLE_MARKDOWN);
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: dest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
    await committer.commit(tmpDir, 'page-abc', specPath);

    const committed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'spec.committed');
    expect(committed).toBeDefined();
    expect(committed!['publisher_ref']).toBe('page-abc');
    expect(committed!['spec_path']).toBe(specPath);
    expect(committed!['workspace_path']).toBe(tmpDir);
  });

  it('emits spec.commit_failed on error', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const publisher = makePublisher();
    (publisher.getPageMarkdown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('notion error'));
    const execFn = makeExecFn();
    const committer = new NotionSpecCommitter(publisher, execFn, { logDestination: dest });

    const specPath = join(tmpDir, 'context-human', 'specs', 'feature.md');
    await expect(committer.commit(tmpDir, 'page-id', specPath)).rejects.toThrow();

    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'spec.commit_failed');
    expect(failed).toBeDefined();
    expect(typeof failed!['error']).toBe('string');
  });
});
