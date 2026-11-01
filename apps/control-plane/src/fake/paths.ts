import { isAbsolute, join, resolve } from 'node:path';

/**
 * Centralizes every path under the fake-mode state directory so controls stay
 * contained and numeric identifiers are validated before use.
 */
export interface FakeStatePaths {
  readonly stateDir: string;
  readonly markerFile: string;
  readonly databasePath: string;
  readonly reposRoot: string;
  readonly workspacesRoot: string;
  readonly fixtureRemote: string;
  readonly hostClone: string;
  readonly issuesFile: string;
  readonly pullRequestsDir: string;
  readonly pullRequestCounterFile: string;
  readonly failuresDir: string;
  readonly countersDir: string;
  readonly launchContextDir: string;
  readonly launchCounterFile: string;
}

export const FAKE_MARKER_FILENAME = '.autocatalyst-fake-marker';

export function resolveFakeStatePaths(stateDirInput: string): FakeStatePaths {
  const stateDir = isAbsolute(stateDirInput) ? stateDirInput : resolve(stateDirInput);
  return {
    stateDir,
    markerFile: join(stateDir, FAKE_MARKER_FILENAME),
    databasePath: join(stateDir, 'control-plane.sqlite'),
    reposRoot: join(stateDir, 'repos'),
    workspacesRoot: join(stateDir, 'workspaces'),
    fixtureRemote: join(stateDir, 'fixture-remote.git'),
    hostClone: join(stateDir, 'repos', 'autocatalyst-fixtures', 'demo-app'),
    issuesFile: join(stateDir, 'issues.json'),
    pullRequestsDir: join(stateDir, 'pull-requests'),
    pullRequestCounterFile: join(stateDir, 'pull-requests', 'counter'),
    failuresDir: join(stateDir, 'failures'),
    countersDir: join(stateDir, 'counters'),
    launchContextDir: join(stateDir, 'launch-context'),
    launchCounterFile: join(stateDir, 'counters', 'launch.count')
  };
}

/** Validate a numeric identifier (issue or pull request number) before using it in a path. */
export function assertValidIdentifier(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error(`Invalid ${label}: expected a positive integer.`);
  }
  return value;
}

export function pullRequestStateFile(paths: FakeStatePaths, number: number): string {
  assertValidIdentifier(number, 'pull request number');
  return join(paths.pullRequestsDir, `${number}.state`);
}

export function pullRequestRecordFile(paths: FakeStatePaths, number: number): string {
  assertValidIdentifier(number, 'pull request number');
  return join(paths.pullRequestsDir, `${number}.json`);
}

export function failureFile(paths: FakeStatePaths, issueNumber: number): string {
  assertValidIdentifier(issueNumber, 'issue number');
  return join(paths.failuresDir, `issue-${issueNumber}.json`);
}
