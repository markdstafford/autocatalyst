import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ParsedArgs {
  command: 'run' | 'init';
  repoPath: string;
  help: boolean;
}

export function parseArgs(args: string[]): ParsedArgs {
  // Detect 'init' as first positional argument
  if (args[0] === 'init') {
    const remaining = args.slice(1);

    if (remaining.includes('--help') || remaining.includes('-h')) {
      return { command: 'init', repoPath: '', help: true };
    }

    const repoIndex = remaining.indexOf('--repo');
    const repoPath =
      repoIndex !== -1 && repoIndex + 1 < remaining.length
        ? remaining[repoIndex + 1]
        : '';

    return { command: 'init', repoPath, help: false };
  }

  // --help / -h (run command)
  if (args.includes('--help') || args.includes('-h')) {
    return { command: 'run', repoPath: '', help: true };
  }

  // run command — --repo is required and validated
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

  return { command: 'run', repoPath, help: false };
}

export function printUsage(): void {
  console.log(`Usage:
  autocatalyst --repo <path>           Start the service for a repository
  autocatalyst init [--repo <path>]    Initialize and validate configuration

Options:
  --repo <path>   Path to the target repository
  --help          Show this help message
`);
}
