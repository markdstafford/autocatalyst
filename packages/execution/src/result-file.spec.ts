import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MaterializedExecutionEnvironment } from './materialized-environment.js';
import { readScratchStepResultFile } from './result-file.js';

const stubContext: MaterializedExecutionEnvironment['context'] = {
  run: { id: 'run_1', workKind: 'implement', currentStep: 'implement', tenant: 'tenant_1' },
  task: { prompt: 'stub', inputs: {} },
  workspaceIntent: { shape: 'none' },
  secretBindings: [],
  toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
  skills: { requested: [] },
  capabilityRequirements: {
    shell: { kind: 'bash', required: false },
    paths: { canonicalWorkspacePaths: false },
    lsp: { requested: false }
  }
};

function environmentWithScratch(scratchRoot: string, repoRoot?: string): MaterializedExecutionEnvironment {
  return {
    context: stubContext,
    workspace: repoRoot === undefined
      ? { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] }
      : { shape: 'two_roots', repoRoot, scratchRoot, branchName: 'run/run_1', workspaceRoots: [repoRoot, scratchRoot] },
    environment: { variables: {}, secretVariableNames: [] },
    toolPolicy: { allowedTools: [], workspaceRoots: [scratchRoot] },
    skills: { requested: [] },
    capabilities: {
      shell: { kind: 'bash', available: false },
      paths: { scratchRoot, ...(repoRoot === undefined ? {} : { repoRoot }) },
      lsp: { requested: false, available: false }
    }
  };
}

describe('readScratchStepResultFile', () => {
  it('reads JSON files inside scratchRoot', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'result-file-'));
    await writeFile(path.join(root, 'result.json'), JSON.stringify({ ok: true }), 'utf8');

    await expect(readScratchStepResultFile({ environment: environmentWithScratch(root), resultFile: 'result.json' }))
      .resolves.toEqual({ status: 'read', value: { ok: true }, relativePath: 'result.json' });
  });

  it('returns missing failure for absent result file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'result-file-'));

    const result = await readScratchStepResultFile({ environment: environmentWithScratch(root), resultFile: 'missing.json' });
    expect(result).toMatchObject({ status: 'failed', code: 'result_file_missing' });
  });

  it('returns invalid JSON failure for malformed content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'result-file-'));
    await writeFile(path.join(root, 'bad.json'), '{', 'utf8');

    const invalid = await readScratchStepResultFile({ environment: environmentWithScratch(root), resultFile: 'bad.json' });
    expect(invalid).toMatchObject({ status: 'failed', code: 'result_json_invalid' });
    expect(JSON.stringify(invalid)).not.toContain(root);
  });

  it('rejects paths that escape scratchRoot via ../traversal', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'result-file-'));
    const scratchRoot = path.join(base, 'scratch');
    await mkdir(scratchRoot);
    // Create a file in the parent dir (outside scratchRoot)
    await writeFile(path.join(base, 'outside.json'), JSON.stringify({ escaped: true }), 'utf8');

    const result = await readScratchStepResultFile({
      environment: environmentWithScratch(scratchRoot),
      resultFile: '../outside.json'
    });

    expect(result).toMatchObject({ status: 'failed', code: 'result_path_outside_scratch_root' });
    expect(JSON.stringify(result)).not.toContain(base);
  });

  it('rejects traversal into sibling repo roots', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'result-file-'));
    const scratchRoot = path.join(base, 'scratch');
    const repoRoot = path.join(base, 'repo');
    await mkdir(scratchRoot);
    await mkdir(repoRoot);
    await writeFile(path.join(repoRoot, 'result.json'), JSON.stringify({ escaped: true }), 'utf8');

    const result = await readScratchStepResultFile({
      environment: environmentWithScratch(scratchRoot, repoRoot),
      resultFile: '../repo/result.json'
    });

    expect(result).toMatchObject({ status: 'failed', code: 'result_path_outside_scratch_root' });
    expect(JSON.stringify(result)).not.toContain(base);
  });

  it('reports workspace shape none as missing result file', async () => {
    const noneEnvironment: MaterializedExecutionEnvironment = {
      context: stubContext,
      workspace: { shape: 'none', workspaceRoots: [] },
      environment: { variables: {}, secretVariableNames: [] },
      toolPolicy: { allowedTools: [], workspaceRoots: [] },
      skills: { requested: [] },
      capabilities: {
        shell: { kind: 'bash', available: false },
        paths: {},
        lsp: { requested: false, available: false }
      }
    };

    await expect(readScratchStepResultFile({ environment: noneEnvironment, resultFile: 'result.json' }))
      .resolves.toMatchObject({ status: 'failed', code: 'result_file_missing' });
  });
});
