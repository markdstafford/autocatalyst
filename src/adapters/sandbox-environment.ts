export interface SandboxEnvironmentSummary {
  token_count: number;
  exported_sandbox_keys: string[];
  missing_tokens: string[];
}

export function buildSandboxEnvironmentWithSummary(
  acTokenNames: string[],
  env: NodeJS.ProcessEnv = process.env,
): { environment: Record<string, string>; summary: SandboxEnvironmentSummary } {
  const result: Record<string, string> = {};
  const missingTokens: string[] = [];

  for (const acKey of acTokenNames) {
    const sandboxKey = acKey.startsWith('AC_') ? acKey.slice(3) : acKey;
    const value = env[acKey];
    if (typeof value === 'string' && value.length > 0) {
      result[sandboxKey] = value;
    } else {
      missingTokens.push(acKey);
    }
  }

  return {
    environment: result,
    summary: {
      token_count: Object.keys(result).length,
      exported_sandbox_keys: Object.keys(result),
      missing_tokens: missingTokens,
    },
  };
}

// Keep existing function unchanged for backwards compat
export function buildSandboxEnvironment(
  acTokenNames: string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return buildSandboxEnvironmentWithSummary(acTokenNames, env).environment;
}
