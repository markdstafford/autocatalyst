/**
 * Shared run/project builders for the run list tests.
 *
 * These construct valid `Run` and `Project` shapes with sensible defaults so each
 * spec overrides only the fields it exercises. Kept out of `.spec` files so the
 * factory is reused across the table, hook, selection, and routing tests.
 */
import type {
  Project,
  PullRequest,
  PullRequestState,
  Run,
  RunStateTransitionEvent,
  RunStateTransitionKind,
  RunStatus,
  RunWaitingOn,
  Session,
  SessionOutcome
} from '@autocatalyst/api-contract';

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

export interface MakeSessionOverrides {
  readonly id?: string;
  readonly runId?: string;
  readonly sequence?: number;
  readonly durationMs?: number | null;
  readonly outcome?: SessionOutcome;
  readonly tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Integer nano-dollars, or null/undefined for an unpriced session. */
  readonly usd?: number | null;
}

const MODEL_IDENTITY = { provider: 'anthropic', model: 'claude-opus-4' } as const;

/** Build a valid durable `Session`. Cost tokens mirror session tokens (schema refinement). */
export function makeSession(overrides: MakeSessionOverrides = {}): Session {
  const tokens = overrides.tokens ?? { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 };
  const durationMs = overrides.durationMs === undefined ? 1000 : overrides.durationMs;
  const hasUsd = 'usd' in overrides;
  const session: Session = {
    id: overrides.id ?? 'session-1',
    runId: overrides.runId ?? 'run-1',
    sequence: overrides.sequence ?? 1,
    phase: null,
    step: 'spec.author',
    role: 'implementer',
    round: 0,
    model: MODEL_IDENTITY,
    inferenceSettings: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: durationMs === null ? null : '2026-01-01T00:00:01.000Z',
    durationMs,
    tokens,
    usageAvailable: true,
    assistantTurnCount: 1,
    toolCallCount: 0,
    outcome: overrides.outcome ?? 'succeeded',
    cost: {
      model: MODEL_IDENTITY,
      ...(hasUsd ? { usd: overrides.usd as number | null } : { usd: 0 }),
      tokens
    }
  };
  return session;
}

export interface MakePullRequestOverrides {
  readonly runId?: string;
  readonly number?: number;
  readonly state?: PullRequestState;
  readonly url?: string;
}

/** Build a valid `PullRequest`. */
export function makePullRequest(overrides: MakePullRequestOverrides = {}): PullRequest {
  const number = overrides.number ?? 101;
  return {
    id: `pr-${number}`,
    runId: overrides.runId ?? 'run-1',
    owner: OWNER,
    tenant: 'tenant_dev',
    provider: 'github',
    number,
    url: overrides.url ?? `https://github.com/autocatalyst-fixtures/demo-app/pull/${number}`,
    state: overrides.state ?? 'open',
    branch: `autocatalyst/run-${number}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

export interface MakeTransitionEventOverrides {
  readonly id?: string;
  readonly run?: Run;
  readonly directive?: RunStateTransitionKind;
  readonly fromStep?: string;
  readonly toStep?: string;
}

/**
 * Build a valid `run_state_transition` event. Mirrors the control plane: the event's
 * embedded run is the orchestrator's raw run WITHOUT the API-read-only `status` and
 * `projectId` fields, so tests that assert the client rereads the run (rather than
 * copying from the frame) start from a frame that genuinely lacks those fields.
 */
export function makeTransitionEvent(overrides: MakeTransitionEventOverrides = {}): RunStateTransitionEvent {
  const baseRun = overrides.run ?? makeRun();
  // Strip the derived read-only fields the orchestrator does not emit on events.
  const { status: _status, projectId: _projectId, ...rawRun } = baseRun;
  void _status;
  void _projectId;
  const id = overrides.id ?? 'evt-1';
  const toStep = overrides.toStep ?? rawRun.currentStep;
  return {
    id,
    type: 'run_state_transition',
    runId: rawRun.id,
    transition: {
      directive: overrides.directive ?? 'advance',
      ...(overrides.fromStep !== undefined ? { fromStep: overrides.fromStep } : {}),
      toStep
    },
    run: rawRun as Run,
    runStep: {
      id: `step-${id}`,
      runId: rawRun.id,
      phase: null,
      step: toStep,
      role: 'implementer',
      startedAt: '2026-01-01T00:00:05.000Z',
      endedAt: null,
      durationMs: null,
      occurrence: { index: 0, attempt: 1 },
      checkpointResult: null
    },
    tenant: rawRun.tenant,
    createdAt: '2026-01-01T00:00:05.000Z'
  };
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
