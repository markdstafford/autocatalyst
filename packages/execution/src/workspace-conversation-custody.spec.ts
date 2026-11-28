import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPrivateConversationScope } from './internal/workspace-conversation-custody.js';
import { createNodeWorkspaceDriver } from './internal/workspace-driver.js';
import { createWorkspacePruner } from './internal/workspace-pruner.js';

describe('workspace conversation custody', () => {
  it('holds only the affected run across pruner restarts and requires proof for each writer group', async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'conversation-custody-')));
    const first = path.join(base, 'run_one');
    const second = path.join(base, 'run_two');
    await mkdir(first);
    await mkdir(second);
    try {
      const marker = { version: 1, tenant: 'tenant', runId: 'run_one', generation: 'gen',
        writerIdentity: 'host-writer-identity', descendantGroup: 'descendant-group' } as const;
      const scope = await createPrivateConversationScope(first, marker);
      const overdue = await createPrivateConversationScope(first, { ...marker, writerIdentity: 'next-writer' });
      await writeFile(path.join(scope.scope, 'local-history'), 'test');
      const driver = createNodeWorkspaceDriver();
      const prune = (targetPath: string) => ({ runId: path.basename(targetPath), mode: 'directory' as const, workspaceRoot: base, targetPath });
      const restarted = createWorkspacePruner({ driver });
      expect(await restarted.pruneWorkspacePath(prune(first))).toMatchObject({ status: 'rejected', errorCode: 'conversation_writer_unverified' });
      expect(await restarted.pruneWorkspacePath(prune(second))).toMatchObject({ status: 'deleted' });
      await expect(lstat(scope.scope)).resolves.toBeDefined();
      const partial = createWorkspacePruner({ driver, conversationWriterExited: async actual =>
        actual.writerIdentity === marker.writerIdentity && actual.descendantGroup === marker.descendantGroup });
      expect(await partial.pruneWorkspacePath(prune(first))).toMatchObject({ status: 'rejected' });
      await expect(lstat(overdue.scope)).resolves.toBeDefined();
      const verified = createWorkspacePruner({ driver, conversationWriterExited: async actual =>
        actual.generation === marker.generation && actual.descendantGroup === marker.descendantGroup &&
        [marker.writerIdentity, 'next-writer'].includes(actual.writerIdentity) });
      expect(await verified.pruneWorkspacePath(prune(first))).toMatchObject({ status: 'deleted' });
      await expect(lstat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
