import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

interface ParsedArgs {
  repoPath: string;
  help: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
  if (args.includes('--help') || args.includes('-h')) {
    return { repoPath: '', help: true };
  }

  const repoIndex = args.indexOf('--repo');
  if (repoIndex === -1 || repoIndex + 1 >= args.length) {
    throw new Error('Missing required argument: --repo <path>');
  }

  const rawPath = args[repoIndex + 1];
  const repoPath = resolve(rawPath);

  if (!existsSync(repoPath)) {
    throw new Error(`--repo path does not exist: ${repoPath}`);
  }

  if (!statSync(repoPath).isDirectory()) {
    throw new Error(`--repo path is not a directory: ${repoPath}`);
  }

  return { repoPath, help: false };
}

export function printUsage(): void {
  console.log(`Usage: autocatalyst --repo <path>

Options:
  --repo <path>   Path to the target repository (required)
  --help          Show this help message
`);
}
