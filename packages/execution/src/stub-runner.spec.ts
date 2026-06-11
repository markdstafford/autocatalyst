import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { StubRunner } from './stub-runner.js';
import { assertPathWithinWorkspaceRoots } from './internal/workspace-root-guard.js';
import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import type { ExecutionContext } from '@autocatalyst/api-contract';

function makeEnvironment(partial?: Partial<MaterializedExecutionEnvironment>): MaterializedExecutionEnvironment {
  const context: ExecutionContext = {
    run: { id: 'run_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
    task: { prompt: 'Implement feature', inputs: {} },
    workspaceIntent: { shape: 'none' },
    secretBindings: [],
    toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
    skills: { requested: [], resolved: [] },
    capabilityRequirements: {
      shell: { kind: 'bash', required: false },
      paths: { canonicalWorkspacePaths: true },
      lsp: { requested: false }
    }
  };
  return {
    context,
    workspace: { shape: 'none', workspaceRoots: [] },
    environment: { variables: {}, secretVariableNames: [] },
    toolPolicy: { allowedTools: ['bash'], workspaceRoots: [] },
    skills: { requested: [], resolved: [] },
    capabilities: {
      shell: { kind: 'bash', available: false },
      paths: {},
      lsp: { requested: false, available: false }
    },
    ...partial
  };
}

describe('StubRunner', () => {
  it('emits events in the correct order', async () => {
    const runner = new StubRunner();
    const env = makeEnvironment();
    const events = [];
    for await (const event of runner.run({ environment: env })) {
      events.push(event.type);
    }
    expect(events).toEqual(['runner_progress', 'runner_assistant_turn', 'runner_step_checkpoint', 'runner_terminal_result']);
  });

  it('has exactly one terminal result', async () => {
    const runner = new StubRunner();
    const env = makeEnvironment();
    const terminals = [];
    for await (const event of runner.run({ environment: env })) {
      if (event.type === 'runner_terminal_result') terminals.push(event);
    }
    expect(terminals).toHaveLength(1);
  });

  it('defaults terminal directive to advance', async () => {
    const runner = new StubRunner();
    const env = makeEnvironment();
    const events = [];
    for await (const event of runner.run({ environment: env })) {
      events.push(event);
    }
    const terminal = events.find(e => e.type === 'runner_terminal_result');
    expect(terminal?.type === 'runner_terminal_result' && terminal.result.directive).toBe('advance');
  });

  it('supports needs_input terminal override', async () => {
    const runner = new StubRunner({ terminalResult: { directive: 'needs_input', question: 'What file?' } });
    const env = makeEnvironment();
    const events = [];
    for await (const event of runner.run({ environment: env })) {
      events.push(event);
    }
    const terminal = events.find(e => e.type === 'runner_terminal_result');
    expect(terminal?.type === 'runner_terminal_result' && terminal.result.directive).toBe('needs_input');
    if (terminal?.type === 'runner_terminal_result' && terminal.result.directive === 'needs_input') {
      expect(terminal.result.question).toBe('What file?');
    }
  });

  it('supports fail terminal override', async () => {
    const runner = new StubRunner({ terminalResult: { directive: 'fail', reason: 'Test failure.' } });
    const env = makeEnvironment();
    const events = [];
    for await (const event of runner.run({ environment: env })) {
      events.push(event);
    }
    const terminal = events.find(e => e.type === 'runner_terminal_result');
    expect(terminal?.type === 'runner_terminal_result' && terminal.result.directive).toBe('fail');
  });

  it('close() resolves to { status: closed }', async () => {
    const runner = new StubRunner();
    await expect(runner.close()).resolves.toEqual({ status: 'closed' });
  });

  it('includes workspace shape and capability facts in checkpoint', async () => {
    const runner = new StubRunner();
    const env = makeEnvironment({
      workspace: { shape: 'two_roots', repoRoot: '/tmp/repo', scratchRoot: '/tmp/scratch', branchName: 'main', workspaceRoots: ['/tmp/repo', '/tmp/scratch'] },
      capabilities: { shell: { kind: 'bash', available: true }, paths: { repoRoot: '/tmp/repo', scratchRoot: '/tmp/scratch' }, lsp: { requested: true, available: false } }
    });
    const events = [];
    for await (const event of runner.run({ environment: env })) {
      events.push(event);
    }
    const checkpoint = events.find(e => e.type === 'runner_step_checkpoint');
    expect(checkpoint?.type === 'runner_step_checkpoint' && checkpoint.checkpoint.data['workspaceShape']).toBe('two_roots');
    expect(checkpoint?.type === 'runner_step_checkpoint' && checkpoint.checkpoint.data['workspaceRootCount']).toBe(2);
    expect(checkpoint?.type === 'runner_step_checkpoint' && checkpoint.checkpoint.data['shellAvailable']).toBe(true);
    expect(checkpoint?.type === 'runner_step_checkpoint' && checkpoint.checkpoint.data['lspAvailable']).toBe(false);
  });

  it('does not require provider credentials or network access', async () => {
    const runner = new StubRunner();
    const env = makeEnvironment();
    // Just running the stub should not throw or require any external resources
    const events = [];
    for await (const event of runner.run({ environment: env })) {
      events.push(event);
    }
    expect(events).toHaveLength(4);
  });

  it('event IDs come from injected generator', async () => {
    let counter = 0;
    const runner = new StubRunner({ eventIdGenerator: () => `test_evt_${++counter}` });
    const env = makeEnvironment();
    const ids = [];
    for await (const event of runner.run({ environment: env })) {
      ids.push(event.id);
    }
    expect(ids).toEqual(['test_evt_1', 'test_evt_2', 'test_evt_3', 'test_evt_4']);
  });
});

describe('StubRunner — resultFile and correction responses', () => {
  it('writes JSON result file under scratch root when configured', async () => {
    const scratchRoot = await mkdtemp(path.join(tmpdir(), 'stub-rf-'));
    try {
      const runner = new StubRunner({
        resultFile: { relativePath: 'nested/result.json', value: { a: 1, b: 'x' } }
      });
      const env = makeEnvironment({
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      });
      const events = [];
      for await (const event of runner.run({ environment: env })) {
        events.push(event);
      }
      expect(events).toHaveLength(4);
      const written = await readFile(path.join(scratchRoot, 'nested/result.json'), 'utf8');
      expect(JSON.parse(written)).toEqual({ a: 1, b: 'x' });
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });

  it('skips writing result file when no scratch root is materialized', async () => {
    const runner = new StubRunner({
      resultFile: { relativePath: 'r.json', value: { a: 1 } }
    });
    const env = makeEnvironment();
    const events = [];
    for await (const event of runner.run({ environment: env })) {
      events.push(event);
    }
    expect(events).toHaveLength(4);
  });

  it('getCorrectionRequester returns scripted responses in order', async () => {
    const runner = new StubRunner({
      correctionResponses: [{ ok: 1 }, { ok: 2 }]
    });
    const requester = runner.getCorrectionRequester();
    const baseRequest = {
      runId: 'run_1',
      step: 'implement',
      schemaId: 'schema',
      attempt: 1,
      maxAttempts: 2,
      issues: [],
      safeCandidatePreview: null
    };
    await expect(requester.requestCorrection(baseRequest)).resolves.toEqual({ ok: 1 });
    await expect(requester.requestCorrection({ ...baseRequest, attempt: 2 })).resolves.toEqual({ ok: 2 });
  });

  it('rejects write when a symlinked directory inside scratchRoot points outside it', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'stub-symlink-'));
    try {
      const scratchRoot = path.join(base, 'scratch');
      const outsideDir = path.join(base, 'outside');
      await mkdir(scratchRoot);
      await mkdir(outsideDir);
      // Create a symlink inside scratchRoot that points to a directory outside it.
      await symlink(outsideDir, path.join(scratchRoot, 'symlink'));

      const runner = new StubRunner({
        resultFile: { relativePath: 'symlink/result.json', value: { escaped: true } }
      });
      const env = makeEnvironment({
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      });

      const consume = async (): Promise<void> => {
        for await (const _ of runner.run({ environment: env })) { /* consume */ }
      };
      await expect(consume()).rejects.toThrow(/escapes scratch root/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects write when symlink points outside and a non-existent sub-directory follows it', async () => {
    // Regression: `link/new/result.json` where `link` → outside and `new/` does not yet exist.
    // The old code fell back to the lexical parent on ENOENT, bypassing symlink detection.
    const base = await mkdtemp(path.join(tmpdir(), 'stub-symlink-enoent-'));
    try {
      const scratchRoot = path.join(base, 'scratch');
      const outsideDir = path.join(base, 'outside');
      await mkdir(scratchRoot);
      await mkdir(outsideDir);
      // Symlink inside scratchRoot → outside directory; `new/` sub-directory does NOT exist yet.
      await symlink(outsideDir, path.join(scratchRoot, 'symlink'));

      const runner = new StubRunner({
        resultFile: { relativePath: 'symlink/new/result.json', value: { escaped: true } }
      });
      const env = makeEnvironment({
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      });

      const consume = async (): Promise<void> => {
        for await (const _ of runner.run({ environment: env })) { /* consume */ }
      };
      await expect(consume()).rejects.toThrow(/escapes scratch root/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rejects write when the result file itself is a symlink pointing outside scratchRoot', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'stub-file-symlink-'));
    try {
      const scratchRoot = path.join(base, 'scratch');
      await mkdir(scratchRoot);
      // Create a real file outside scratchRoot that the symlink will target.
      const outsideFile = path.join(base, 'secret.json');
      const { writeFile: writeFileLocal } = await import('node:fs/promises');
      await writeFileLocal(outsideFile, JSON.stringify({ secret: true }), 'utf8');
      // Place a symlink at the result-file path inside scratchRoot pointing to the outside file.
      await symlink(outsideFile, path.join(scratchRoot, 'result.json'));

      const runner = new StubRunner({
        resultFile: { relativePath: 'result.json', value: { injected: true } }
      });
      const env = makeEnvironment({
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      });

      const consume = async (): Promise<void> => {
        for await (const _ of runner.run({ environment: env })) { /* consume */ }
      };
      await expect(consume()).rejects.toThrow(/escapes scratch root/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('throws when scripted correction responses are exhausted', async () => {
    const runner = new StubRunner({ correctionResponses: [] });
    const requester = runner.getCorrectionRequester();
    await expect(
      requester.requestCorrection({
        runId: 'run_1',
        step: 'implement',
        schemaId: 'schema',
        attempt: 1,
        maxAttempts: 1,
        issues: [],
        safeCandidatePreview: null
      })
    ).rejects.toThrow(/exhausted/);
  });

  it('fails safely with a sanitized error when a write ancestor is not a directory', async () => {
    // Regression: a regular file sits where a directory component is expected
    // (`afile/result.json`). The write must reject without surfacing a raw, path-bearing
    // filesystem error.
    const base = await mkdtemp(path.join(tmpdir(), 'stub-enotdir-'));
    try {
      const scratchRoot = path.join(base, 'scratch');
      await mkdir(scratchRoot);
      const { writeFile: writeFileLocal } = await import('node:fs/promises');
      await writeFileLocal(path.join(scratchRoot, 'afile'), 'not a directory', 'utf8');

      const runner = new StubRunner({
        resultFile: { relativePath: 'afile/result.json', value: { a: 1 } }
      });
      const env = makeEnvironment({
        workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      });

      let caught: unknown;
      try {
        for await (const _ of runner.run({ environment: env })) { /* consume */ }
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).not.toContain(base);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('assertPathWithinWorkspaceRoots', () => {
  it('passes for a path inside a workspace root', () => {
    expect(() => assertPathWithinWorkspaceRoots('/tmp/work/root/file.txt', ['/tmp/work/root'])).not.toThrow();
  });

  it('throws for a path outside all workspace roots', () => {
    expect(() => assertPathWithinWorkspaceRoots('/etc/passwd', ['/tmp/work/root'])).toThrow();
  });

  it('throws with sanitized error message', () => {
    expect(() => assertPathWithinWorkspaceRoots('/etc/passwd', ['/tmp/work/root'])).toThrow('Path is outside materialized workspace roots.');
  });

  it('passes for a path inside one of multiple roots', () => {
    expect(() => assertPathWithinWorkspaceRoots('/tmp/scratch/file.txt', ['/tmp/repo', '/tmp/scratch'])).not.toThrow();
  });

  it('uses generic message and does not include candidate path for path outside all roots', () => {
    try {
      assertPathWithinWorkspaceRoots('/etc/sensitive', ['/tmp/workspace']);
      expect.fail('Should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('Path is outside materialized workspace roots.');
      expect((error as Error).message).not.toContain('/etc/sensitive');
    }
  });

  it('throws for any path when workspace roots are empty', () => {
    expect(() => assertPathWithinWorkspaceRoots('/tmp/anything', [])).toThrow();
  });

});
