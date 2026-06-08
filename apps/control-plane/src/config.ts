export interface ControlPlaneAppConfig {
  readonly port: number;
  readonly databasePath: string;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    throw new Error('CONTROL_PLANE_PORT or --port is required.');
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Control-plane port must be a number between 1 and 65535.');
  }

  return port;
}

function parseDatabasePath(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error('CONTROL_PLANE_DATABASE_PATH or --database-path is required.');
  }

  return value;
}

export function readControlPlaneAppConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ControlPlaneAppConfig {
  const portValue = readFlag(argv, '--port') ?? env['CONTROL_PLANE_PORT'];
  const databasePathValue = readFlag(argv, '--database-path') ?? env['CONTROL_PLANE_DATABASE_PATH'];

  return {
    port: parsePort(portValue),
    databasePath: parseDatabasePath(databasePathValue)
  };
}
