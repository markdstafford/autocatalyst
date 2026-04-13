import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OMCImplementer } from '../../../src/adapters/agent/implementer.js';

const nullDest = { write: () => {} };

function makeArtifactContent(rawContent: string): string {
  return `# omc artifact\n\n## Raw output\n\n\`\`\`text\n${rawContent}\n\`\`\`\n`;
}

function makeCompleteArtifact(summary: string, testingInstructions: string): string {
  return makeArtifactContent([
    'STATUS: complete',
    '',
    'SUMMARY:',
    '<<<',
    summary,
    '>>>',
    '',
    'TESTING_INSTRUCTIONS:',
    '<<<',
    testingInstructions,
    '>>>',
  ].join('\n'));
}

function makeNeedsInputArtifact(question: string): string {
  return makeArtifactContent([
    'STATUS: needs_input',
    '',
    'QUESTION:',
    '<<<',
    question,
    '>>>',
  ].join('\n'));
}

function makeFailedArtifact(error: string): string {
  return makeArtifactContent([
    'STATUS: failed',
    '',
    'ERROR:',
    '<<<',
    error,
    '>>>',
  ].join('\n'));
}

let tmpDir: string;
let specPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'impl-test-'));
  specPath = join(tmpDir, 'spec.md');
  writeFileSync(specPath, '# My Feature\n\nSpec content here.\n\n## Task list\n\n- [ ] Build it', 'utf-8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeExecFn(artifactContent: string) {
  const artifactPath = join(tmpDir, 'artifact.md');
  writeFileSync(artifactPath, artifactContent, 'utf-8');
  return vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
}

describe('OMCImplementer — OMC invocation', () => {
  it('spawns omc team 1:claude with cwd set to workspace_path', async () => {
    const execFn = makeExecFn(makeCompleteArtifact('Built it.', 'Run npm test'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await impl.implement(specPath, tmpDir);

    expect(execFn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = execFn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(cmd).toBe('omc');
    expect(args[0]).toBe('team');
    expect(args[1]).toBe('1:claude');
    expect(opts.cwd).toBe(tmpDir);
  });

  it('prompt includes the full spec content', async () => {
    const execFn = makeExecFn(makeCompleteArtifact('Built it.', 'Run npm test'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await impl.implement(specPath, tmpDir);

    const prompt = (execFn.mock.calls[0] as unknown[][])[1][2] as string;
    expect(prompt).toContain('My Feature');
    expect(prompt).toContain('Spec content here');
    expect(prompt).toContain('Task list');
  });

  it('prompt includes mm implementation handoff instructions', async () => {
    const execFn = makeExecFn(makeCompleteArtifact('Built it.', 'Run npm test'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await impl.implement(specPath, tmpDir);

    const prompt = (execFn.mock.calls[0] as unknown[][])[1][2] as string;
    expect(prompt).toMatch(/task list|implementation plan|dependency order/i);
  });

  it('prompt does not contain additional context section when not provided', async () => {
    const execFn = makeExecFn(makeCompleteArtifact('Built it.', 'Run npm test'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await impl.implement(specPath, tmpDir);

    const prompt = (execFn.mock.calls[0] as unknown[][])[1][2] as string;
    expect(prompt).not.toMatch(/additional context/i);
  });

  it('prompt includes additional context when provided', async () => {
    const execFn = makeExecFn(makeCompleteArtifact('Built it.', 'Run npm test'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await impl.implement(specPath, tmpDir, 'go with the subtype approach');

    const prompt = (execFn.mock.calls[0] as unknown[][])[1][2] as string;
    expect(prompt).toContain('go with the subtype approach');
    expect(prompt).toMatch(/additional context/i);
  });
});

describe('OMCImplementer — result parsing (complete)', () => {
  it('returns status complete with summary and testing_instructions', async () => {
    const execFn = makeExecFn(makeCompleteArtifact('Implementation done.', 'Pull branch, run npm test'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.status).toBe('complete');
    expect(result.summary).toBe('Implementation done.');
    expect(result.testing_instructions).toBe('Pull branch, run npm test');
    expect(result.question).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('captures multi-line summary correctly', async () => {
    const summary = 'Line 1\nLine 2\nLine 3';
    const execFn = makeExecFn(makeCompleteArtifact(summary, 'Run tests'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.summary).toBe(summary);
  });

  it('captures multi-line testing instructions correctly', async () => {
    const instructions = 'Pull branch spec/my-feature\nnpm install\nnpm test';
    const execFn = makeExecFn(makeCompleteArtifact('Done.', instructions));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.testing_instructions).toBe(instructions);
  });
});

describe('OMCImplementer — result parsing (needs_input)', () => {
  it('returns status needs_input with question', async () => {
    const execFn = makeExecFn(makeNeedsInputArtifact('Should I use approach A or B?'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.status).toBe('needs_input');
    expect(result.question).toBe('Should I use approach A or B?');
    expect(result.summary).toBeUndefined();
    expect(result.testing_instructions).toBeUndefined();
  });
});

describe('OMCImplementer — result parsing (failed)', () => {
  it('returns status failed with error', async () => {
    const execFn = makeExecFn(makeFailedArtifact('Could not find the config file.'));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    const result = await impl.implement(specPath, tmpDir);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Could not find the config file.');
  });
});

describe('OMCImplementer — result parsing (error cases)', () => {
  it('throws when STATUS line is missing', async () => {
    const artifact = makeArtifactContent('SUMMARY:\n<<<\nsome content\n>>>');
    const execFn = makeExecFn(artifact);
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/STATUS/i);
  });

  it('throws when STATUS value is invalid', async () => {
    const artifact = makeArtifactContent('STATUS: unknown_value\n\nSUMMARY:\n<<<\nstuff\n>>>');
    const execFn = makeExecFn(artifact);
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/STATUS|invalid/i);
  });

  it('throws when STATUS is complete but SUMMARY is missing', async () => {
    const artifact = makeArtifactContent('STATUS: complete\n\nTESTING_INSTRUCTIONS:\n<<<\nRun tests\n>>>');
    const execFn = makeExecFn(artifact);
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/SUMMARY/i);
  });

  it('throws when STATUS is complete but TESTING_INSTRUCTIONS is missing', async () => {
    const artifact = makeArtifactContent('STATUS: complete\n\nSUMMARY:\n<<<\nDone.\n>>>');
    const execFn = makeExecFn(artifact);
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/TESTING_INSTRUCTIONS/i);
  });

  it('throws when STATUS is needs_input but QUESTION is missing', async () => {
    const artifact = makeArtifactContent('STATUS: needs_input\n\nSUMMARY:\n<<<\nsome\n>>>');
    const execFn = makeExecFn(artifact);
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/QUESTION/i);
  });

  it('throws when STATUS is failed but ERROR is missing', async () => {
    const artifact = makeArtifactContent('STATUS: failed');
    const execFn = makeExecFn(artifact);
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/ERROR/i);
  });

  it('throws when SUMMARY section is empty (only whitespace)', async () => {
    const artifact = makeArtifactContent(
      'STATUS: complete\n\nSUMMARY:\n<<<\n   \n>>>\n\nTESTING_INSTRUCTIONS:\n<<<\nRun tests\n>>>'
    );
    const execFn = makeExecFn(artifact);
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/SUMMARY|empty/i);
  });

  it('throws when OMC exits non-zero', async () => {
    const execFn = vi.fn().mockRejectedValue(Object.assign(new Error('exit 1'), { stderr: 'fatal error' }));
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow();
  });

  it('throws when artifact has no ## Raw output section', async () => {
    const artifactPath = join(tmpDir, 'artifact.md');
    writeFileSync(artifactPath, '# artifact\n\nNo raw output section.', 'utf-8');
    const execFn = vi.fn().mockResolvedValue({ stdout: artifactPath + '\n', stderr: '' });
    const impl = new OMCImplementer(execFn, { logDestination: nullDest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow(/Raw output/i);
  });
});

describe('OMCImplementer — logging', () => {
  it('emits omc.team_invoked before spawn', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = makeExecFn(makeCompleteArtifact('Done.', 'Run tests'));
    const impl = new OMCImplementer(execFn, { logDestination: dest });

    await impl.implement(specPath, tmpDir);

    const invoked = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'omc.team_invoked');
    expect(invoked).toBeDefined();
    expect(typeof invoked!['has_additional_context']).toBe('boolean');
  });

  it('emits omc.team_invoked with has_additional_context: true when context provided', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = makeExecFn(makeCompleteArtifact('Done.', 'Run tests'));
    const impl = new OMCImplementer(execFn, { logDestination: dest });

    await impl.implement(specPath, tmpDir, 'use approach A');

    const invoked = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'omc.team_invoked');
    expect(invoked!['has_additional_context']).toBe(true);
  });

  it('emits omc.team_completed on success with status', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = makeExecFn(makeCompleteArtifact('Done.', 'Run tests'));
    const impl = new OMCImplementer(execFn, { logDestination: dest });

    await impl.implement(specPath, tmpDir);

    const completed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'omc.team_completed');
    expect(completed).toBeDefined();
    expect(completed!['status']).toBe('complete');
  });

  it('emits omc.team_failed on non-zero exit', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = vi.fn().mockRejectedValue(Object.assign(new Error('fail'), { stderr: 'some error' }));
    const impl = new OMCImplementer(execFn, { logDestination: dest });

    await expect(impl.implement(specPath, tmpDir)).rejects.toThrow();

    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'omc.team_failed');
    expect(failed).toBeDefined();
  });

  it('prompt content is not logged at info level or above', async () => {
    const logs: string[] = [];
    const dest = { write: (line: string) => logs.push(line) };
    const execFn = makeExecFn(makeCompleteArtifact('Done.', 'Run tests'));
    const impl = new OMCImplementer(execFn, { logDestination: dest });

    await impl.implement(specPath, tmpDir);

    const infoLogs = logs.filter(l => {
      try {
        const p = JSON.parse(l) as Record<string, unknown>;
        return p['level'] === 'info' || p['level'] === 30;
      } catch { return false; }
    });

    for (const line of infoLogs) {
      expect(line).not.toContain('Spec content here');
    }
  });
});
