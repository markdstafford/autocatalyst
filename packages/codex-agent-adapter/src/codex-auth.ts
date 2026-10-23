import { ClassifiedProviderFailureError } from '@autocatalyst/execution';

// ---------------------------------------------------------------------------
// Codex enterprise sign-in authentication
//
// The adapter runs against an operator-approved Codex / ChatGPT enterprise
// sign-in held by the Codex CLI's own on-host credential cache. The adapter
// NEVER reads, copies, logs, or persists that cached credential; it only runs a
// probe that reports a safe status and, on failure, a safe failure code.
// ---------------------------------------------------------------------------

export type CodexAuthMode = 'enterprise_sign_in';

export type CodexAuthFailureCode =
  | 'missing_sign_in'
  | 'expired_sign_in'
  | 'disallowed_plan'
  | 'account_mismatch';

export interface CodexAuthProbeInput {
  /** Secret-stripped launch environment. The probe must not read raw credentials. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface CodexAuthProbeSuccess {
  readonly status: 'authenticated';
  /** A safe, coarse account descriptor such as 'enterprise' — never an identity or token. */
  readonly accountType?: string;
}

export interface CodexAuthProbeFailure {
  readonly status: 'unauthenticated';
  readonly code: CodexAuthFailureCode;
}

export type CodexAuthProbeResult = CodexAuthProbeSuccess | CodexAuthProbeFailure;

export type CodexAuthProbe = (
  input: CodexAuthProbeInput
) => CodexAuthProbeResult | Promise<CodexAuthProbeResult>;

// Safe, constant diagnostics per failure code. These strings never contain an
// account identity, token, cached-credential path, or upstream message text.
const AUTH_FAILURE_MESSAGES: Record<CodexAuthFailureCode, string> = {
  missing_sign_in:
    'Codex enterprise sign-in is missing on the host. Complete the operator-approved Codex sign-in before running this profile.',
  expired_sign_in:
    'Codex enterprise sign-in has expired. Re-run the operator-approved Codex sign-in before running this profile.',
  disallowed_plan:
    'The signed-in Codex account plan is not allowed for this profile.',
  account_mismatch:
    'The signed-in Codex account does not match the approved enterprise identity for this profile.'
};

export function codexAuthFailureMessage(code: CodexAuthFailureCode): string {
  return AUTH_FAILURE_MESSAGES[code];
}

/**
 * Thrown when enterprise sign-in is missing, expired, disallowed, or mismatched.
 *
 * Extends {@link ClassifiedProviderFailureError} so it surfaces the canonical
 * public failure reason `provider_auth_failed` while carrying a safe
 * `authFailureCode` for actionable diagnostics. It never carries raw credentials,
 * cached-token paths, or upstream secret text.
 */
export class CodexAuthenticationError extends ClassifiedProviderFailureError {
  readonly authFailureCode: CodexAuthFailureCode;
  readonly authMode: CodexAuthMode;

  constructor(code: CodexAuthFailureCode, providerKind: string) {
    super('provider_auth_failed', { providerKind });
    this.name = 'CodexAuthenticationError';
    this.message = AUTH_FAILURE_MESSAGES[code];
    this.authFailureCode = code;
    this.authMode = 'enterprise_sign_in';
  }
}

export function isCodexAuthenticationError(value: unknown): value is CodexAuthenticationError {
  return value instanceof CodexAuthenticationError;
}
