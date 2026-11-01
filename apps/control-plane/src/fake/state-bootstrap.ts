import { execFile } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { FAKE_FIXTURE_ISSUES } from './fixtures.js';
import { FAKE_PULL_REQUEST_START_NUMBER } from './constants.js';
import { resolveFakeStatePaths, type FakeStatePaths } from './paths.js';

const execFileAsync = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-c', 'user.name=Autocatalyst Fake', '-c', 'user.email=fake@autocatalyst.local', ...args],
    { cwd }
  );
}

async function ensureFixtureRepository(paths: FakeStatePaths): Promise<void> {
  if (await pathExists(paths.fixtureRemote)) {
    return;
  }

  // Bare remote with a single commit on main.
  await mkdir(paths.fixtureRemote, { recursive: true });
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', paths.fixtureRemote]);

  // Host clone used by the workspace provisioner.
  await mkdir(paths.hostClone, { recursive: true });
  await execFileAsync('git', ['clone', paths.fixtureRemote, paths.hostClone]);
  await writeFile(
    `${paths.hostClone}/README.md`,
    '# Autocatalyst fixture app\n\nDeterministic fixture repository for fake mode.\n',
    'utf-8'
  );
  await runGit(paths.hostClone, ['checkout', '-B', 'main']);
  await runGit(paths.hostClone, ['add', '--', 'README.md']);
  await runGit(paths.hostClone, ['commit', '-m', 'chore: seed fixture repository']);
  await runGit(paths.hostClone, ['push', '-u', 'origin', 'main']);
  // Point origin/HEAD at main so the provisioner resolves the default branch.
  await runGit(paths.hostClone, ['remote', 'set-head', 'origin', 'main']);
}

/**
 * Create the fixture repository, fixture issues file, pull-request counter,
 * marker file, and required state subdirectories — only when absent. Restarting
 * preserves every existing file and counter.
 */
export async function ensureFakeState(stateDir: string): Promise<FakeStatePaths> {
  const paths = resolveFakeStatePaths(stateDir);

  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.reposRoot, { recursive: true });
  await mkdir(paths.workspacesRoot, { recursive: true });
  await mkdir(paths.pullRequestsDir, { recursive: true });
  await mkdir(paths.failuresDir, { recursive: true });
  await mkdir(paths.countersDir, { recursive: true });
  await mkdir(paths.launchContextDir, { recursive: true });

  // Marker file enables safe deletion by the serve-fake wrapper.
  if (!(await pathExists(paths.markerFile))) {
    await writeFile(paths.markerFile, 'autocatalyst-fake-mode\n', 'utf-8');
  }

  if (!(await pathExists(paths.issuesFile))) {
    await writeFile(paths.issuesFile, `${JSON.stringify(FAKE_FIXTURE_ISSUES, null, 2)}\n`, 'utf-8');
  }

  if (!(await pathExists(paths.pullRequestCounterFile))) {
    await writeFile(paths.pullRequestCounterFile, `${FAKE_PULL_REQUEST_START_NUMBER}\n`, 'utf-8');
  }

  if (!(await pathExists(paths.launchCounterFile))) {
    await writeFile(paths.launchCounterFile, '0\n', 'utf-8');
  }

  await ensureFixtureRepository(paths);

  return paths;
}
