export function buildSandboxEnvironment(
  acTokenNames: string[],
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const acKey of acTokenNames) {
    const sandboxKey = acKey.startsWith('AC_') ? acKey.slice(3) : acKey;
    const value = env[acKey];
    if (typeof value === 'string' && value.length > 0) {
      result[sandboxKey] = value;
    }
  }
  return result;
}
