import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GhExecErrorCode =
  | 'gh_not_found'
  | 'gh_auth_failed'
  | 'gh_resource_not_found'
  | 'gh_provider_unavailable'
  | 'gh_timeout'
  | 'gh_error';

export interface GhExecInput {
  readonly args: readonly string[];
  readonly token: string;
  readonly executablePath?: string;
  readonly timeoutMs?: number;
}

export interface GhExecResult {
  readonly stdout: string;
  readonly truncated: boolean;
}

const MAX_STDOUT_BYTES = 1_048_576; // 1 MB

export class GhExecError extends Error {
  readonly code: GhExecErrorCode;
  readonly safeDetails?: Record<string, unknown>;

  constructor(code: GhExecErrorCode, message: string, safeDetails?: Record<string, unknown>) {
    super(message);
    this.name = 'GhExecError';
    this.code = code;
    if (safeDetails !== undefined) {
      this.safeDetails = safeDetails;
    }
  }
}

export async function executeGh(input: GhExecInput): Promise<GhExecResult> {
  const { args, token, executablePath = 'gh', timeoutMs = 30_000 } = input;

  try {
    const { stdout } = await execFileAsync(executablePath, [...args], {
      env: { ...process.env, GH_TOKEN: token },
      timeout: timeoutMs,
      maxBuffer: MAX_STDOUT_BYTES + 1,
      shell: false
    });

    const truncated = Buffer.byteLength(stdout) > MAX_STDOUT_BYTES;
    return {
      stdout: truncated ? stdout.slice(0, MAX_STDOUT_BYTES) : stdout,
      truncated
    };
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException & {
      killed?: boolean;
      code?: string | number;
      stderr?: string;
    };

    // Check for timeout
    if (nodeError.killed === true || nodeError.code === 'ETIMEDOUT') {
      throw new GhExecError('gh_timeout', 'gh command timed out.');
    }

    // Check for missing executable
    if (nodeError.code === 'ENOENT') {
      throw new GhExecError('gh_not_found', 'gh executable not found.');
    }

    // For non-zero exits, check stderr for known patterns (but don't include raw stderr in error)
    const rawStderr = nodeError.stderr ?? '';

    // Auth failure patterns
    if (
      rawStderr.includes('authentication') ||
      rawStderr.includes('401') ||
      rawStderr.includes('credentials')
    ) {
      throw new GhExecError('gh_auth_failed', 'gh authentication failed.');
    }

    // Not found patterns
    if (
      rawStderr.includes('not found') ||
      rawStderr.includes('404') ||
      rawStderr.includes('Could not resolve')
    ) {
      throw new GhExecError('gh_resource_not_found', 'gh resource not found.');
    }

    // Default non-zero exit
    throw new GhExecError('gh_error', 'gh command failed with non-zero exit.');
  }
}
