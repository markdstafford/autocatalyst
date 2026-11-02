/**
 * Shared run/project builders for the run list tests.
 *
 * These construct valid `Run` and `Project` shapes with sensible defaults so each
 * spec overrides only the fields it exercises. Kept out of `.spec` files so the
 * factory is reused across the table, hook, selection, and routing tests.
 */
import type { Project, Run, RunStatus, RunWaitingOn } from '@autocatalyst/api-contract';

export interface MakeRunOverrides {
  readonly id?: string;
  readonly status?: RunStatus;
  readonly waitingOn?: RunWaitingOn;
  readonly workKind?: string;
  readonly projectId?: string;
  readonly createdAt?: string;
  readonly terminal?: boolean;
  readonly withIssue?: boolean;
  readonly issueNumber?: number;
  readonly issueTitle?: string;
}

// A valid non-model principal (human) whose tenantId matches the run/project tenant,
// so the fixtures parse through the strict wire schema as well as the component layer.
const OWNER = { kind: 'human', id: 'operator-1', tenantId: 'tenant_dev' } as const;

/** Build a valid `Run`. A tracked issue is included unless `withIssue` is false. */
export function makeRun(overrides: MakeRunOverrides = {}): Run {
  const id = overrides.id ?? 'run-1';
  const status = overrides.status ?? 'in_progress';
  const withIssue = overrides.withIssue ?? true;
  const run: Run = {
    id,
    topicId: `topic-${id}`,
    owner: OWNER,
    tenant: 'tenant_dev',
    workKind: overrides.workKind ?? 'feature',
    currentStep: 'spec.human_review',
    waitingOn: overrides.waitingOn ?? 'human',
    status,
    terminal: overrides.terminal ?? status !== 'in_progress',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    ...(withIssue
      ? {
          trackedIssue: {
            number: overrides.issueNumber ?? 101,
            title: overrides.issueTitle ?? 'Add the run list',
            body: '',
            labels: [],
            state: 'open' as const,
            url: 'https://example.test/issues/101'
          }
        }
      : {})
  };
  return run;
}

export interface MakeProjectOverrides {
  readonly id?: string;
  readonly displayName?: string;
}

/** Build a valid `Project`. */
export function makeProject(overrides: MakeProjectOverrides = {}): Project {
  const id = overrides.id ?? 'project-1';
  return {
    id,
    owner: OWNER,
    tenant: 'tenant_dev',
    displayName: overrides.displayName ?? 'Fixture app',
    repoUrl: 'https://github.com/autocatalyst-fixtures/demo-app',
    hostRepository: { provider: 'github', owner: 'autocatalyst-fixtures', name: 'demo-app' },
    workspaceRootOverride: null,
    issueTrackerSetting: null,
    codeHostSetting: null,
    credentialRefs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}
