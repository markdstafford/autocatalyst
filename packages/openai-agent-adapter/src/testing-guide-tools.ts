import { constants } from 'node:fs';
import { glob, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { tool } from '@openai/agents';
import { z } from 'zod/v4';

const MAX_FILES = 200;
const MAX_FILE_BYTES = 64 * 1024;

function visiblePath(path: string): boolean {
  return !isAbsolute(path) && path.split(/[\\/]/u).every(part =>
    part !== '..' && part !== '.git' && part !== 'node_modules');
}

export function createTestingGuideTools(repoRoot?: string): ReturnType<typeof tool>[] {
  const root = repoRoot ? realpath(repoRoot).catch(() => undefined) : Promise.resolve(undefined);
  const list = async (pattern: string): Promise<string[]> => {
    const cwd = await root;
    if (!cwd || !visiblePath(pattern)) return [];
    const paths: string[] = [];
    for await (const path of glob(pattern, { cwd, exclude: path => !visiblePath(path) })) {
      if (!visiblePath(path)) continue;
      const file = join(cwd, path);
      if (await realpath(file).catch(() => undefined) !== file) continue;
      if ((await lstat(file).catch(() => undefined))?.isFile()) paths.push(path);
      if (paths.length >= MAX_FILES) break;
    }
    return paths;
  };
  const read = async (path: string): Promise<string | undefined> => {
    const cwd = await root;
    if (!cwd || !visiblePath(path)) return undefined;
    const file = join(cwd, path);
    if (!file.startsWith(cwd + sep) || await realpath(file).catch(() => undefined) !== file) return undefined;
    if (!(await lstat(file).catch(() => undefined))?.isFile()) return undefined;
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
    if (!handle) return undefined;
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const bytes = Buffer.alloc(MAX_FILE_BYTES);
      const { bytesRead } = await handle.read(bytes);
      return bytes.subarray(0, bytesRead).toString('utf8');
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  };

  return [
    tool({
      name: 'Read', description: 'Read the first 64 KiB of a repository-relative file.',
      parameters: z.object({ path: z.string().min(1).max(500) }),
      execute: async ({ path }) => await read(path) ?? 'File unavailable.'
    }),
    tool({
      name: 'Glob', description: 'List up to 200 repository files matching a relative glob.',
      parameters: z.object({ pattern: z.string().min(1).max(500) }),
      execute: async ({ pattern }) => list(pattern)
    }),
    tool({
      name: 'Grep', description: 'Find literal text in the first 64 KiB of files matching a repository-relative glob.',
      parameters: z.object({ pattern: z.string().min(1).max(500), text: z.string().min(1).max(500) }),
      execute: async ({ pattern, text }) => {
        const matches: string[] = [];
        for (const path of await list(pattern)) if ((await read(path))?.includes(text)) matches.push(path);
        return matches;
      }
    })
  ];
}
