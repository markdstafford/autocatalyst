import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Empty values also mask credentials when the SDK merges its parent's environment. */
export function claudeSubscriptionEnvironment(overlay: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  Object.assign(env, overlay);
  for (const key of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_(?:OAUTH|API_KEY|USE_|BASE_URL)|AWS_BEARER_TOKEN_BEDROCK)/u.test(key)) env[key] = '';
  }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) env[key] = '';
  return env;
}

/** Ask the vendor CLI for safe status; never open or copy its cached credential. */
export async function probeClaudeSubscription(env: Record<string, string>): Promise<boolean> {
  return (await readClaudeSubscription(env)) !== undefined;
}

export async function claudeSubscriptionIdentity(env: Record<string, string>): Promise<string | undefined> {
  const status = await readClaudeSubscription(env);
  const email = status?.['email'];
  const org = status?.['orgId'];
  if (typeof email !== 'string' || !email || typeof org !== 'string' || !org) return undefined;
  return createHash('sha256').update(JSON.stringify([email, org])).digest('hex');
}

async function readClaudeSubscription(env: Record<string, string>): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await promisify(execFile)('claude', ['auth', 'status'], { env, timeout: 20_000, maxBuffer: 32_768 });
    const status = JSON.parse(result.stdout) as Record<string, unknown>;
    if (status['loggedIn'] === true && status['authMethod'] === 'claude.ai' && status['apiProvider'] === 'firstParty') return status;
  } catch { /* The vendor CLI could not attest the account. */ }
  return undefined;
}
