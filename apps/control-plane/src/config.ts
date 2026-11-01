import { isAbsolute, join, resolve } from 'node:path';

export interface WorkspaceRootConfig {
  readonly reposRoot: string;
  readonly workspacesRoot: string;
}

export interface FakeModeConfig {
  readonly enabled: true;
  /** Absolute path to the fake-mode state directory. */
  readonly stateDir: string;
}

export interface RealRunnerDispatchConfig {
  readonly enabled: boolean;
  readonly defaultProviderProfileId?: string;
}

export interface PullRequestReconciliationTickerConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly tenant: string;
}

export interface ControlPlaneAppConfig {
  readonly port: number;
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly runConcurrency: number;
  readonly workspaceRoots?: WorkspaceRootConfig;
  readonly realRunnerDispatch?: RealRunnerDispatchConfig;
  /** GitHub username to stamp as specced_by on spec.author results. Read from GITHUB_LOGIN env var. */
  readonly specAuthorIdentity?: string;
  readonly pullRequestReconciliationTicker?: PullRequestReconciliationTickerConfig;
  /** Present and enabled only when the control plane runs in deterministic fake mode. */
  readonly fakeMode?: FakeModeConfig;
}

const DEFAULT_RUN_CONCURRENCY = 2;

// Fake-mode defaults. Applied only when fake mode is enabled and the usual setting is absent.
const FAKE_MODE_DEFAULT_PORT = '4010';
const FAKE_MODE_DEFAULT_BEARER_TOKEN = 'fake-mode-token';
const FAKE_MODE_DEFAULT_MASTER_SECRET = 'fake-mode-master-secret';
const FAKE_MODE_DEFAULT_STATE_DIR = '.autocatalyst-fake';

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

function parsePullRequestReconciliationTicker(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): PullRequestReconciliationTickerConfig | undefined {
  const enabled = hasFlag(argv, '--pr-reconcile-ticker') || parseBooleanEnv(env['AUTOCATALYST_PR_RECONCILE_TICKER'], 'AUTOCATALYST_PR_RECONCILE_TICKER');
  if (!enabled) return undefined;

  const intervalRaw = readFlag(argv, '--pr-reconcile-interval-ms') ?? env['AUTOCATALYST_PR_RECONCILE_INTERVAL_MS'];
  if (intervalRaw === undefined || intervalRaw.trim().length === 0) {
    throw new Error('AUTOCATALYST_PR_RECONCILE_INTERVAL_MS or --pr-reconcile-interval-ms is required when the PR reconciliation ticker is enabled.');
  }
  const intervalMs = Number(intervalRaw);
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error('AUTOCATALYST_PR_RECONCILE_INTERVAL_MS must be a positive integer.');
  }

  const tenant = readFlag(argv, '--pr-reconcile-tenant') ?? env['AUTOCATALYST_PR_RECONCILE_TENANT'];
  if (tenant === undefined || tenant.trim().length === 0) {
    throw new Error('AUTOCATALYST_PR_RECONCILE_TENANT or --pr-reconcile-tenant is required when the PR reconciliation ticker is enabled.');
  }

  return { enabled: true, intervalMs, tenant };
}

/**
 * Resolve fake-mode settings. Fake mode is enabled by `--fake-mode` or
 * `AUTOCATALYST_FAKE_MODE`. The state directory comes from `--fake-state-dir`,
 * `AUTOCATALYST_FAKE_STATE_DIR`, or `.autocatalyst-fake/` at the current working
 * directory. Fake mode owns dispatch and provider adapter selection, so any
 * explicit real-dispatch or provider-profile configuration is rejected.
 */
function parseFakeMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): FakeModeConfig | undefined {
  const enabled = hasFlag(argv, '--fake-mode') || parseBooleanEnv(env['AUTOCATALYST_FAKE_MODE'], 'AUTOCATALYST_FAKE_MODE');
  if (!enabled) {
    return undefined;
  }

  const realDispatchRequested =
    hasFlag(argv, '--real-dispatch') || parseBooleanEnv(env['AUTOCATALYST_REAL_DISPATCH'], 'AUTOCATALYST_REAL_DISPATCH');
  if (realDispatchRequested) {
    throw new Error(
      'Fake mode owns dispatch and provider adapter selection; remove --real-dispatch / AUTOCATALYST_REAL_DISPATCH.'
    );
  }
  const defaultProviderProfileId = readFlag(argv, '--default-provider-profile-id') ?? env['AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID'];
  if (defaultProviderProfileId !== undefined) {
    throw new Error(
      'Fake mode owns dispatch and provider adapter selection; remove --default-provider-profile-id / AUTOCATALYST_DEFAULT_PROVIDER_PROFILE_ID.'
    );
  }

  const stateDirRaw = readFlag(argv, '--fake-state-dir') ?? env['AUTOCATALYST_FAKE_STATE_DIR'] ?? FAKE_MODE_DEFAULT_STATE_DIR;
  if (stateDirRaw.trim().length === 0) {
    throw new Error('Fake state directory must be non-empty when configured.');
  }
  const stateDir = isAbsolute(stateDirRaw) ? stateDirRaw : resolve(stateDirRaw);
  return { enabled: true, stateDir };
}

export function readControlPlaneAppConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): ControlPlaneAppConfig {
  const fakeMode = parseFakeMode(argv, env);
  const fakeEnabled = fakeMode !== undefined;

  const portValue = readFlag(argv, '--port') ?? env['CONTROL_PLANE_PORT'] ?? (fakeEnabled ? FAKE_MODE_DEFAULT_PORT : undefined);
  const databasePathValue =
    readFlag(argv, '--database-path') ?? env['CONTROL_PLANE_DATABASE_PATH'] ?? (fakeMode !== undefined ? join(fakeMode.stateDir, 'control-plane.sqlite') : undefined);
  const bearerTokenValue = readFlag(argv, '--bearer-token') ?? env['CONTROL_PLANE_BEARER_TOKEN'] ?? (fakeEnabled ? FAKE_MODE_DEFAULT_BEARER_TOKEN : undefined);
  const masterSecretValue = readFlag(argv, '--master-secret') ?? env['CONTROL_PLANE_MASTER_SECRET'] ?? (fakeEnabled ? FAKE_MODE_DEFAULT_MASTER_SECRET : undefined);
  const runConcurrencyValue = readFlag(argv, '--run-concurrency') ?? env['AUTOCATALYST_RUN_CONCURRENCY'];
  const reposRootValue =
    readFlag(argv, '--repos-root') ?? env['AUTOCATALYST_REPOS_ROOT'] ?? (fakeMode !== undefined ? join(fakeMode.stateDir, 'repos') : undefined);
  const workspacesRootValue =
    readFlag(argv, '--workspaces-root') ?? env['AUTOCATALYST_WORKSPACES_ROOT'] ?? (fakeMode !== undefined ? join(fakeMode.stateDir, 'workspaces') : undefined);
  const workspaceRoots = parseWorkspaceRoots(reposRootValue, workspacesRootValue);
  const realRunnerDispatch = parseRealRunnerDispatch(argv, env);
  const specAuthorIdentity = env['GITHUB_LOGIN']?.trim() || undefined;
  const pullRequestReconciliationTicker = parsePullRequestReconciliationTicker(argv, env);

  return {
    port: parsePort(portValue),
    databasePath: parseDatabasePath(databasePathValue),
    bearerToken: parseBearerToken(bearerTokenValue),
    masterSecret: parseMasterSecret(masterSecretValue),
    runConcurrency: parseRunConcurrency(runConcurrencyValue),
    ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
    ...(realRunnerDispatch !== undefined ? { realRunnerDispatch } : {}),
    ...(specAuthorIdentity !== undefined ? { specAuthorIdentity } : {}),
    ...(pullRequestReconciliationTicker !== undefined ? { pullRequestReconciliationTicker } : {}),
    ...(fakeMode !== undefined ? { fakeMode } : {})
  };
}
