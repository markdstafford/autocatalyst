import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { jsonValueSchema } from '@autocatalyst/api-contract';

import type { AgentModelMemoryStore } from './agent-model-memory.js';

const snapshotSchema = z.object({
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  state: jsonValueSchema
}).strict();

export interface ScratchModelMemoryOptions {
  readonly scratchRoot: string;
  readonly key: string;
  readonly onWarning?: (operation: 'load' | 'save') => void;
}

/** Optional continuity cache. Scratch loss and I/O errors never fail agent work. */
export function createScratchAgentModelMemoryStore(options: ScratchModelMemoryOptions): AgentModelMemoryStore {
  const digest = createHash('sha256').update(options.key).digest('hex');
  const path = join(options.scratchRoot, `model-memory-${digest}.json`);
  const warn = (operation: 'load' | 'save') => {
    try { options.onWarning?.(operation); } catch { /* Diagnostics are best effort. */ }
  };

  return {
    async load() {
      try {
        const snapshot = snapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        return { providerKind: snapshot.providerKind, adapterId: snapshot.adapterId, state: snapshot.state };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn('load');
        return null;
      }
    },
    async save(snapshot) {
      let temporaryPath: string | undefined;
      let temporaryCreated = false;
      try {
        const serialized = JSON.stringify(snapshotSchema.parse(snapshot));
        // Unique sibling + rename keeps readers from observing a partial write.
        temporaryPath = join(options.scratchRoot, `model-memory-${digest}-${randomUUID()}.tmp`);
        const file = await open(temporaryPath, 'wx', 0o600);
        temporaryCreated = true;
        try {
          await file.writeFile(serialized, 'utf8');
        } finally {
          await file.close();
        }
        await rename(temporaryPath, path);
        temporaryPath = undefined;
      } catch {
        warn('save');
      } finally {
        if (temporaryCreated && temporaryPath !== undefined) {
          try { await unlink(temporaryPath); } catch { /* Cache cleanup is best effort. */ }
        }
      }
    }
  };
}
