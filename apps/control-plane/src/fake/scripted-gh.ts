import { readFile, writeFile } from 'node:fs/promises';

import { GhExecError, type GhExecInput, type GhExecResult } from '@autocatalyst/github-issue-tracker-adapter';
import type { ExecuteGhFunction } from '@autocatalyst/github-code-host-adapter';

import type { FakeFixtureIssue } from './fixtures.js';
import { FAKE_FIXTURE_ISSUES } from './fixtures.js';
import {
  assertValidIdentifier,
  pullRequestRecordFile,
  pullRequestStateFile,
  type FakeStatePaths
} from './paths.js';

type ExecuteGhFn = (input: GhExecInput) => Promise<GhExecResult>;

function ok(stdout: string): GhExecResult {
  return { stdout, truncated: false };
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

async function loadIssues(paths: FakeStatePaths): Promise<readonly FakeFixtureIssue[]> {
  try {
    return JSON.parse(await readFile(paths.issuesFile, 'utf-8')) as FakeFixtureIssue[];
  } catch {
    return FAKE_FIXTURE_ISSUES;
  }
}

/**
 * Scripted `executeGh` for the GitHub issue tracker. Serves fixture issues from
 * the state directory. Only `gh issue view` is exercised by the tracker.
 */
export function createScriptedIssueTrackerExecuteGh(paths: FakeStatePaths): ExecuteGhFn {
  return async ({ args }) => {
    if (args[0] === 'issue' && args[1] === 'view') {
      const issueNumber = Number(args[2]);
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        throw new GhExecError('gh_error', 'Invalid issue number in scripted gh invocation.');
      }
      const repo = readFlagValue(args, '--repo') ?? 'autocatalyst-fixtures/demo-app';
      const issues = await loadIssues(paths);
      const issue = issues.find((candidate) => candidate.number === issueNumber);
      if (issue === undefined) {
        throw new GhExecError('gh_resource_not_found', `Fixture issue ${issueNumber} not found.`);
      }
      return ok(
        JSON.stringify({
          number: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels.map((name) => ({ name })),
          state: issue.state,
          url: `https://github.com/${repo}/issues/${issue.number}`
        })
      );
    }
    throw new GhExecError('gh_error', `Unsupported scripted gh issue command: ${args.join(' ')}`);
  };
}

interface PullRequestRecord {
  readonly number: number;
  readonly branch: string;
  readonly url: string;
}

async function readPullRequestRecord(paths: FakeStatePaths, number: number): Promise<PullRequestRecord | null> {
  try {
    return JSON.parse(await readFile(pullRequestRecordFile(paths, number), 'utf-8')) as PullRequestRecord;
  } catch {
    return null;
  }
}

async function readPullRequestState(paths: FakeStatePaths, number: number): Promise<string> {
  try {
    const raw = (await readFile(pullRequestStateFile(paths, number), 'utf-8')).trim().toLowerCase();
    if (raw === 'open' || raw === 'merged' || raw === 'closed') {
      return raw;
    }
    return 'open';
  } catch {
    return 'open';
  }
}

async function allocatePullRequestNumber(paths: FakeStatePaths): Promise<number> {
  let current = 101;
  try {
    const raw = (await readFile(paths.pullRequestCounterFile, 'utf-8')).trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 101) {
      current = parsed;
    }
  } catch {
    current = 101;
  }
  assertValidIdentifier(current, 'pull request number');
  await writeFile(paths.pullRequestCounterFile, `${current + 1}\n`, 'utf-8');
  return current;
}

function pullRequestJson(record: PullRequestRecord, state: string): string {
  const upper = state.toUpperCase();
  return JSON.stringify({
    number: record.number,
    url: record.url,
    state: upper,
    headRefName: record.branch,
    mergedAt: state === 'merged' ? '2026-01-01T00:00:00Z' : null
  });
}

async function listPullRequestRecords(paths: FakeStatePaths): Promise<PullRequestRecord[]> {
  const records: PullRequestRecord[] = [];
  // Scan forward from 101 until a gap; the counter bounds how many exist.
  let current = 101;
  try {
    const raw = (await readFile(paths.pullRequestCounterFile, 'utf-8')).trim();
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 101) {
      current = parsed;
    }
  } catch {
    current = 101;
  }
  for (let number = 101; number < current; number += 1) {
    const record = await readPullRequestRecord(paths, number);
    if (record !== null) {
      records.push(record);
    }
  }
  return records;
}

/**
 * Scripted `executeGh` for the GitHub code host. Allocates increasing PR numbers
 * from 101 and reads/writes pull-request state files so tests can flip state with
 * a plain file write and no HTTP route.
 */
export function createScriptedCodeHostExecuteGh(paths: FakeStatePaths): ExecuteGhFunction {
  return async ({ args }) => {
    if (args[0] !== 'pr') {
      throw new GhExecError('gh_error', `Unsupported scripted gh command: ${args.join(' ')}`);
    }
    const repo = readFlagValue(args, '--repo') ?? 'autocatalyst-fixtures/demo-app';

    if (args[1] === 'create') {
      const branch = readFlagValue(args, '--head') ?? 'unknown-branch';
      const number = await allocatePullRequestNumber(paths);
      const url = `https://github.com/${repo}/pull/${number}`;
      const record: PullRequestRecord = { number, branch, url };
      await writeFile(pullRequestRecordFile(paths, number), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
      await writeFile(pullRequestStateFile(paths, number), 'open\n', 'utf-8');
      // gh pr create prints the PR URL on stdout.
      return ok(url);
    }

    if (args[1] === 'view') {
      const number = Number(args[2]);
      assertValidIdentifier(number, 'pull request number');
      const record = await readPullRequestRecord(paths, number);
      if (record === null) {
        throw new GhExecError('gh_resource_not_found', `Fixture pull request ${number} not found.`);
      }
      const state = await readPullRequestState(paths, number);
      return ok(pullRequestJson(record, state));
    }

    if (args[1] === 'list') {
      const headBranch = readFlagValue(args, '--head');
      const records = await listPullRequestRecords(paths);
      const filtered = headBranch !== undefined ? records.filter((record) => record.branch === headBranch) : records;
      const withState = await Promise.all(
        filtered.map(async (record) => {
          const state = (await readPullRequestState(paths, record.number)).toUpperCase();
          return {
            number: record.number,
            url: record.url,
            state,
            headRefName: record.branch,
            mergedAt: state === 'MERGED' ? '2026-01-01T00:00:00Z' : null
          };
        })
      );
      return ok(JSON.stringify(withState));
    }

    if (args[1] === 'merge') {
      const number = Number(args[2]);
      assertValidIdentifier(number, 'pull request number');
      await writeFile(pullRequestStateFile(paths, number), 'merged\n', 'utf-8');
      return ok('');
    }

    if (args[1] === 'edit') {
      return ok('');
    }

    throw new GhExecError('gh_error', `Unsupported scripted gh pr command: ${args.join(' ')}`);
  };
}
