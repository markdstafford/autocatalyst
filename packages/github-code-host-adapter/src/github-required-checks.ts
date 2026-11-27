import type { RequiredCheckEvidence } from '@autocatalyst/core';

const maxPages = 20;
const maxEvidence = 20;

// Query the exact commit, not the branch rollup. Requiredness comes from the PR-scoped resolver.
const query = `query($owner: String!, $name: String!, $oid: GitObjectID!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit {
      oid
      statusCheckRollup { contexts(first: 100, after: $after) {
        totalCount
        pageInfo { endCursor hasNextPage }
        nodes {
          __typename
          ... on CheckRun {
            id name status conclusion startedAt completedAt isRequired(pullRequestNumber: $number)
            checkSuite { id app { id } workflowRun { id } }
          }
          ... on StatusContext { id context state createdAt isRequired(pullRequestNumber: $number) }
        }
      } }
    } }
  }
}`;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('ci_response_invalid');
  return value as ObjectValue;
}

function boundedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /\p{C}/u.test(value)) throw new Error('ci_field_invalid');
  return value;
}

function safeName(value: string): string {
  // Names are display text only. Drop token-shaped strings and unsafe/absolute-path-like names.
  return /(?:gh[pousr]_|github_pat_|sk-|AKIA)[a-z\d_-]{8,}|(?:^|\s)\/[^\s]|[A-Z]:\\/iu.test(value)
    ? '(redacted check name)' : value.slice(0, 160);
}

interface Check {
  id: string;
  name: string;
  required: boolean;
  key: string;
  time: number;
  incompleteGrouping?: string;
  value: string;
  kind: 'check_run' | 'legacy_status';
}

const checkStatuses = new Set(['COMPLETED', 'IN_PROGRESS', 'QUEUED', 'PENDING', 'REQUESTED', 'WAITING', 'STALE']);
const conclusions = new Set(['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'NEUTRAL', 'SKIPPED', 'STALE', 'STARTUP_FAILURE', 'SUCCESS', 'TIMED_OUT']);
const statusStates = new Set(['SUCCESS', 'PENDING', 'EXPECTED', 'FAILURE', 'ERROR']);

function parseCheck(raw: unknown): Check {
  const node = object(raw);
  const id = boundedString(node['id']);
  if (!/^[a-zA-Z0-9_+=/-]{1,180}$/u.test(id)) throw new Error('ci_id_invalid');
  const required = node['isRequired'];
  if (typeof required !== 'boolean') throw new Error('ci_requiredness_unavailable');
  if (node['__typename'] === 'StatusContext') {
    const name = boundedString(node['context']);
    const time = Date.parse(boundedString(node['createdAt']));
    const value = boundedString(node['state']);
    if (!Number.isFinite(time) || !statusStates.has(value)) throw new Error('ci_status_invalid');
    return { id, name, required, value, time, key: JSON.stringify(['legacy_status', name]), kind: 'legacy_status' };
  }
  if (node['__typename'] !== 'CheckRun') throw new Error('ci_result_unsupported');
  const name = boundedString(node['name']);
  const status = boundedString(node['status']);
  if (!checkStatuses.has(status)) throw new Error('ci_status_invalid');
  const suite = object(node['checkSuite']);
  const app = boundedString(object(suite['app'])['id']);
  const workflowRun = suite['workflowRun'];
  // Actions keeps the same workflow-run identity across rerun attempts, but
  // separate runs of the same workflow can report different checks on one SHA.
  const run = workflowRun == null ? null : boundedString(object(workflowRun)['id']);
  const scope = run === null ? ['suite', boundedString(suite['id'])] : ['workflow_run', run];
  const when = node['startedAt'] ?? node['completedAt'];
  const time = when == null ? Infinity : Date.parse(boundedString(when));
  const value = status === 'COMPLETED' ? boundedString(node['conclusion']) : 'PENDING';
  if (Number.isNaN(time) || (status === 'COMPLETED' && (!Number.isFinite(time) || !conclusions.has(value)))) throw new Error('ci_status_invalid');
  return {
    id, name, required, value, time, key: JSON.stringify(['check_run', app, scope, name]), kind: 'check_run',
    ...(run === null ? { incompleteGrouping: JSON.stringify([app, name]) } : {})
  };
}

export async function readGitHubRequiredChecks(input: {
  owner: string; name: string; oid: string; number: number;
  read: (args: readonly string[]) => Promise<string>;
}): Promise<{ failures: readonly RequiredCheckEvidence[]; requiredPending: boolean }> {
  const effective = new Map<string, Check>();
  const seen = new Set<string>();
  const uncertainScopes = new Map<string, string>();
  const cursors = new Set<string>();
  let after: string | undefined;
  let count: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const output: unknown = JSON.parse(await input.read([
      'api', 'graphql', '-f', `query=${query}`,
      '-f', `owner=${input.owner}`, '-f', `name=${input.name}`,
      '-f', `oid=${input.oid}`, '-F', `number=${input.number}`,
      ...(after !== undefined ? ['-f', `after=${after}`] : [])
    ]));
    const response = object(output);
    if (response['errors'] !== undefined) throw new Error('ci_response_partial');
    const commit = object(object(object(response['data'])['repository'])['object']);
    if (commit['oid'] !== input.oid) throw new Error('ci_head_changed');
    if (commit['statusCheckRollup'] === null && page === 0) return { failures: [], requiredPending: false };
    const contexts = object(object(commit['statusCheckRollup'])['contexts']);
    const total = contexts['totalCount'];
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total > maxPages * 100 ||
        (count !== undefined && count !== total)) throw new Error('ci_response_partial');
    count = total;
    const nodes = contexts['nodes'];
    if (!Array.isArray(nodes) || nodes.length > 100) throw new Error('ci_response_partial');
    for (const raw of nodes) {
      const check = parseCheck(raw);
      if (seen.has(check.id)) throw new Error('ci_page_changed');
      seen.add(check.id);
      if (check.incompleteGrouping !== undefined && check.required) {
        const known = uncertainScopes.get(check.incompleteGrouping);
        if (known !== undefined && known !== check.key) throw new Error('ci_rerun_ambiguous');
        uncertainScopes.set(check.incompleteGrouping, check.key);
      }
      const current = effective.get(check.key);
      if (current !== undefined && (current.required !== check.required ||
          (current.time === check.time && current.value !== check.value))) throw new Error('ci_rerun_ambiguous');
      if (current === undefined || current.time < check.time) effective.set(check.key, check);
    }
    const info = object(contexts['pageInfo']);
    if (info['hasNextPage'] === false) {
      if (seen.size !== count) throw new Error('ci_response_partial');
      const failures: RequiredCheckEvidence[] = [];
      for (const check of effective.values()) {
        const conclusion = check.value.toLowerCase();
        if (!check.required) continue;
        if (check.kind === 'check_run' && (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required')) {
          failures.push({ kind: 'check_run', id: check.id, name: safeName(check.name), conclusion });
        } else if (check.kind === 'legacy_status' && (conclusion === 'failure' || conclusion === 'error')) {
          failures.push({ kind: 'legacy_status', id: check.id, name: safeName(check.name), conclusion });
        }
      }
      return {
        failures: failures.sort((a, b) => a.id.localeCompare(b.id)).slice(0, maxEvidence),
        requiredPending: [...effective.values()].some(check => check.required && (check.value === 'PENDING' || check.value === 'EXPECTED'))
      };
    }
    if (info['hasNextPage'] !== true || nodes.length === 0 || seen.size >= count) throw new Error('ci_response_partial');
    after = boundedString(info['endCursor']);
    if (cursors.has(after)) throw new Error('ci_response_partial');
    cursors.add(after);
  }
  throw new Error('ci_response_partial');
}
