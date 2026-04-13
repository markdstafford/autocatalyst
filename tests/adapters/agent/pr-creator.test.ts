import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GHPRCreator } from '../../../src/adapters/agent/pr-creator.js';

const nullDest = { write: () => {} };

let tmpDir: string;
let specPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pr-creator-'));
  mkdirSync(join(tmpDir, 'context-human', 'specs'), { recursive: true });
  specPath = join(tmpDir, 'context-human', 'specs', 'feature-my-feature.md');
  writeFileSync(specPath, '# My Feature\n\nThis is the spec.', 'utf-8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeExecFn(pushResult = { stdout: '', stderr: '' }, prResult = { stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' }) {
  return vi.fn()
    .mockResolvedValueOnce(pushResult)   // git push
    .mockResolvedValueOnce(prResult);    // gh pr create
}

describe('GHPRCreator — subprocess invocation', () => {
  it('calls git push origin <branch> with cwd set to workspace_path', async () => {
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'spec/my-feature', specPath);

    const pushCall = execFn.mock.calls[0] as [string, string[], { cwd: string }];
    expect(pushCall[0]).toBe('git');
    expect(pushCall[1]).toContain('push');
    expect(pushCall[1]).toContain('origin');
    expect(pushCall[1]).toContain('spec/my-feature');
    expect(pushCall[2].cwd).toBe(tmpDir);
  });

  it('calls gh pr create after successful push', async () => {
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'spec/my-feature', specPath);

    expect(execFn).toHaveBeenCalledTimes(2);
    const prCall = execFn.mock.calls[1] as [string, string[], { cwd: string }];
    expect(prCall[0]).toBe('gh');
    expect(prCall[1]).toContain('pr');
    expect(prCall[1]).toContain('create');
  });

  it('uses conventional commit title feat: <spec_title_lowercased>', async () => {
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'spec/my-feature', specPath);

    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const titleIdx = prArgs.indexOf('--title');
    expect(titleIdx).toBeGreaterThan(-1);
    const title = prArgs[titleIdx + 1];
    expect(title).toBe('feat: my feature');
  });

  it('gh pr create uses --body with content', async () => {
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'spec/my-feature', specPath);

    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const bodyIdx = prArgs.indexOf('--body');
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(typeof prArgs[bodyIdx + 1]).toBe('string');
    expect((prArgs[bodyIdx + 1] as string).length).toBeGreaterThan(0);
  });

  it('gh pr create runs with cwd set to workspace_path', async () => {
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'spec/my-feature', specPath);

    const prCall = execFn.mock.calls[1] as [string, string[], { cwd: string }];
    expect(prCall[2].cwd).toBe(tmpDir);
  });
});

describe('GHPRCreator — title sanitization', () => {
  it('"CLI Setup Wizard" → feat: cli setup wizard', async () => {
    writeFileSync(specPath, '# CLI Setup Wizard\n\nSpec body.', 'utf-8');
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'branch', specPath);

    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const title = prArgs[prArgs.indexOf('--title') + 1];
    expect(title).toBe('feat: cli setup wizard');
  });

  it('"Add CSV export (v2)" → feat: add csv export (v2)', async () => {
    writeFileSync(specPath, '# Add CSV export (v2)\n\nSpec body.', 'utf-8');
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'branch', specPath);

    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const title = prArgs[prArgs.indexOf('--title') + 1];
    expect(title).toBe('feat: add csv export (v2)');
  });

  it('leading/trailing whitespace in title is trimmed before lowercasing', async () => {
    writeFileSync(specPath, '#   My Feature   \n\nSpec body.', 'utf-8');
    const execFn = makeExecFn();
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await creator.createPR(tmpDir, 'branch', specPath);

    const prArgs = (execFn.mock.calls[1] as [string, string[], unknown])[1];
    const title = prArgs[prArgs.indexOf('--title') + 1];
    expect(title).toBe('feat: my feature');
  });
});

describe('GHPRCreator — return value', () => {
  it('returns trimmed PR URL from gh pr create stdout', async () => {
    const execFn = makeExecFn(
      { stdout: '', stderr: '' },
      { stdout: 'https://github.com/org/repo/pull/42\n', stderr: '' },
    );
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    const result = await creator.createPR(tmpDir, 'spec/my-feature', specPath);
    expect(result).toBe('https://github.com/org/repo/pull/42');
  });
});

describe('GHPRCreator — error handling', () => {
  it('throws when git push fails; gh pr create is not called', async () => {
    const execFn = vi.fn().mockRejectedValue(Object.assign(new Error('push failed'), { stderr: 'rejected' }));
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await expect(creator.createPR(tmpDir, 'branch', specPath)).rejects.toThrow(/push/i);
    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('throws when gh pr create fails', async () => {
    const execFn = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('gh failed'), { stderr: 'already exists' }));
    const creator = new GHPRCreator(execFn, { logDestination: nullDest });

    await expect(creator.createPR(tmpDir, 'branch', specPath)).rejects.toThrow();
  });
});

describe('GHPRCreator — logging', () => {
  it('emits pr.created on success with pr_url, branch, and spec_title', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = makeExecFn(
      { stdout: '', stderr: '' },
      { stdout: 'https://github.com/org/repo/pull/99\n', stderr: '' },
    );
    const creator = new GHPRCreator(execFn, { logDestination: dest });

    await creator.createPR(tmpDir, 'spec/my-feature', specPath);

    const created = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'pr.created');
    expect(created).toBeDefined();
    expect(created!['pr_url']).toBe('https://github.com/org/repo/pull/99');
    expect(created!['branch']).toBe('spec/my-feature');
    expect(typeof created!['spec_title']).toBe('string');
  });

  it('emits pr.creation_failed on push failure', async () => {
    const logs: unknown[] = [];
    const dest = { write: (line: string) => logs.push(JSON.parse(line)) };
    const execFn = vi.fn().mockRejectedValue(new Error('push failed'));
    const creator = new GHPRCreator(execFn, { logDestination: dest });

    await expect(creator.createPR(tmpDir, 'branch', specPath)).rejects.toThrow();

    const failed = (logs as Array<Record<string, unknown>>).find(l => l['event'] === 'pr.creation_failed');
    expect(failed).toBeDefined();
    expect(failed!['step']).toBe('push');
  });
});
