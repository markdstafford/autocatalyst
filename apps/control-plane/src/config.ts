export interface ControlPlaneAppConfig {
  readonly port: number;
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly runConcurrency: number;
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

export function readControlPlaneAppConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ControlPlaneAppConfig {
  const portValue = readFlag(argv, '--port') ?? env['CONTROL_PLANE_PORT'];
  const databasePathValue = readFlag(argv, '--database-path') ?? env['CONTROL_PLANE_DATABASE_PATH'];
  const bearerTokenValue = readFlag(argv, '--bearer-token') ?? env['CONTROL_PLANE_BEARER_TOKEN'];
  const masterSecretValue = readFlag(argv, '--master-secret') ?? env['CONTROL_PLANE_MASTER_SECRET'];
  const runConcurrencyValue = readFlag(argv, '--run-concurrency') ?? env['AUTOCATALYST_RUN_CONCURRENCY'];

  return {
    port: parsePort(portValue),
    databasePath: parseDatabasePath(databasePathValue),
    bearerToken: parseBearerToken(bearerTokenValue),
    masterSecret: parseMasterSecret(masterSecretValue),
    runConcurrency: parseRunConcurrency(runConcurrencyValue)
  };
}
