export interface WorkspaceRootConfig {
  readonly reposRoot: string;
  readonly workspacesRoot: string;
}

export interface RealRunnerDispatchConfig {
  readonly enabled: boolean;
  readonly defaultProviderProfileId?: string;
}

export interface ControlPlaneAppConfig {
  readonly port: number;
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly runConcurrency: number;
  readonly workspaceRoots?: WorkspaceRootConfig;
  readonly realRunnerDispatch?: RealRunnerDispatchConfig;
}

const DEFAULT_RUN_CONCURRENCY = 2;

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function parseRequiredString(value: string | undefined, message: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    throw new Error('CONTROL_PLANE_PORT or --port is required.');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Control-plane port must be a number between 0 and 65535.');
  }
  return port;
}

function parseDatabasePath(value: string | undefined): string {
  return parseRequiredString(value, 'CONTROL_PLANE_DATABASE_PATH or --database-path is required.');
}

function parseBearerToken(value: string | undefined): string {
  return parseRequiredString(value, 'CONTROL_PLANE_BEARER_TOKEN or --bearer-token is required.');
}

function parseMasterSecret(value: string | undefined): string {
  return parseRequiredString(value, 'CONTROL_PLANE_MASTER_SECRET or --master-secret is required.');
}

function parseWorkspaceRoots(
  reposRoot: string | undefined,
  workspacesRoot: string | undefined
): WorkspaceRootConfig | undefined {
  if (reposRoot === undefined && workspacesRoot === undefined) {
    return undefined;
  }
  if (reposRoot === undefined || workspacesRoot === undefined) {
    throw new Error('Both repos root and workspaces root must be configured together.');
  }
  if (reposRoot.trim().length === 0 || workspacesRoot.trim().length === 0) {
    throw new Error('Workspace root values must be non-empty when configured.');
  }
  return { reposRoot, workspacesRoot };
}

function parseRunConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    return DEFAULT_RUN_CONCURRENCY;
  }
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Run concurrency must be a positive integer.');
  }
  return concurrency;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function parseBooleanEnv(value: string | undefined, envVarName: string): boolean {
  if (value === undefined || value.trim().length === 0) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
  throw new Error(`${envVarName} must be one of 1, true, yes, 0, false, or no.`);
}

function parseDefaultProviderProfileId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new Error('Default provider profile id must be non-empty when configured.');
  }
  return value;
}

function parseRealRunnerDispatch(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): RealRunnerDispatchConfig | undefined {
  const enabled = hasFlag(argv, '--real-dispatch') || parseBooleanEnv(env['AUTOCATALYST_REAL_DISPATCH'], 'AUTOCATALYST_REAL_DISPATCH');
  const defaultProviderProfileId = parseDefaultProviderProfileId(
    readFlag(argv, '--default-provider-profile-id') ?? env['AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID']
  );
  if (!enabled) {
    if (defaultProviderProfileId !== undefined) {
      throw new Error('Default provider profile id requires real runner dispatch to be enabled.');
    }
    return undefined;
  }
  return {
    enabled: true,
    ...(defaultProviderProfileId !== undefined ? { defaultProviderProfileId } : {})
  };
}

export function readControlPlaneAppConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ControlPlaneAppConfig {
  const portValue = readFlag(argv, '--port') ?? env['CONTROL_PLANE_PORT'];
  const databasePathValue = readFlag(argv, '--database-path') ?? env['CONTROL_PLANE_DATABASE_PATH'];
  const bearerTokenValue = readFlag(argv, '--bearer-token') ?? env['CONTROL_PLANE_BEARER_TOKEN'];
  const masterSecretValue = readFlag(argv, '--master-secret') ?? env['CONTROL_PLANE_MASTER_SECRET'];
  const runConcurrencyValue = readFlag(argv, '--run-concurrency') ?? env['AUTOCATALYST_RUN_CONCURRENCY'];
  const reposRootValue = readFlag(argv, '--repos-root') ?? env['AUTOCATALYST_REPOS_ROOT'];
  const workspacesRootValue = readFlag(argv, '--workspaces-root') ?? env['AUTOCATALYST_WORKSPACES_ROOT'];
  const workspaceRoots = parseWorkspaceRoots(reposRootValue, workspacesRootValue);
  const realRunnerDispatch = parseRealRunnerDispatch(argv, env);

  return {
    port: parsePort(portValue),
    databasePath: parseDatabasePath(databasePathValue),
    bearerToken: parseBearerToken(bearerTokenValue),
    masterSecret: parseMasterSecret(masterSecretValue),
    runConcurrency: parseRunConcurrency(runConcurrencyValue),
    ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
    ...(realRunnerDispatch !== undefined ? { realRunnerDispatch } : {})
  };
}
