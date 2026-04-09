// tests/adapters/agent/spec-generator.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OMCSpecGenerator } from '../../../src/adapters/agent/spec-generator.js';
import type { Idea, SpecFeedback } from '../../../src/types/events.js';

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
    const artifact = `# claude advisor artifact\n\n## Raw output\n\n\`\`\`text\n# Revised Spec\n\`\`\`\n`;
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), specPath, tempRoot);

    const args = execFn.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1]; // --print <prompt>
    expect(prompt).toContain('<<<\nthe wizard should not require');
    expect(prompt).toContain('<<<\n# Original Spec');
    const feedbackIdx = prompt.indexOf('the wizard should not require');
    const specIdx = prompt.indexOf('# Original Spec');
    expect(feedbackIdx).toBeLessThan(specIdx); // feedback before spec
  });

  it('reads the current spec from spec_path before invoking OMC', async () => {
    const artifact = `# claude advisor artifact\n\n## Raw output\n\n\`\`\`text\n# Revised\n\`\`\`\n`;
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec Content', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), specPath, tempRoot);

    // The current spec content should be in the prompt
    const args = execFn.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toContain('# Original Spec Content');
  });

  it('overwrites spec_path in place with revised content', async () => {
    const artifact = `# claude advisor artifact\n\n## Raw output\n\n\`\`\`text\n# Revised Spec\ncontent\n\`\`\`\n`;
    const artifactPath = writeArtifactFile(artifact);
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath, stderr: '' });

    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Original Spec', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await sg.revise(makeFeedback(), specPath, tempRoot);

    const revised = readFileSync(specPath, 'utf-8');
    expect(revised).toContain('# Revised Spec');
    expect(revised).not.toContain('# Original Spec');
  });

  it('throws if OMC exits non-zero', async () => {
    const execFn = vi.fn().mockRejectedValue(new Error('omc crashed'));
    const specPath = join(tempRoot, 'context-human', 'specs', 'feature-test.md');
    writeFileSync(specPath, '# Spec', 'utf-8');

    const sg = new OMCSpecGenerator({ execFn, logDestination: nullDest });
    await expect(sg.revise(makeFeedback(), specPath, tempRoot)).rejects.toThrow(/OMC revision failed/);
  });
});
