import { describe, expect, it, vi } from 'vitest';
import type { Conversation, Feedback, Message, Project, Run, Topic } from '@autocatalyst/api-contract';
import type { DomainRepositories } from '@autocatalyst/core';

import {
  loadSpecAuthorPromptInput,
  SpecAuthoringContextLoadError,
  type IssueContextReader,
  type LoadSpecAuthorPromptInputRequest
} from './spec-authoring-context-loader.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const owner = { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_dev' };

const run: Run = {
  id: 'run_1',
  topicId: 'topic_1',
  owner,
  tenant: 'tenant_dev',
  workKind: 'feature',
  currentStep: 'spec.author',
  terminal: false,
  trackedIssue: {
    number: 46,
    title: 'Add real spec authoring',
    state: 'open',
    url: 'https://github.com/example/repo/issues/46'
  },
  createdAt: '2026-06-13T00:00:00.000Z',
  updatedAt: '2026-06-13T00:00:00.000Z'
};

const topic: Topic = {
  id: 'topic_1',
  conversationId: 'conv_1',
  owner,
  tenant: 'tenant_dev',
  title: 'Author a real conformant spec',
  kind: 'main',
  createdAt: '2026-06-13T00:00:00.000Z',
  updatedAt: '2026-06-13T00:00:00.000Z'
};

const conversation: Conversation = {
  id: 'conv_1',
  projectId: 'project_1',
  owner,
  tenant: 'tenant_dev',
  identity: 'conv_identity_1',
  activeTopicId: 'topic_1',
  createdAt: '2026-06-13T00:00:00.000Z',
  updatedAt: '2026-06-13T00:00:00.000Z'
};

const project: Project = {
  id: 'project_1',
  owner,
  tenant: 'tenant_dev',
  displayName: 'Autocatalyst',
  repoUrl: 'https://github.com/example/autocatalyst',
  hostRepository: {
    provider: 'github',
    owner: 'example',
    name: 'autocatalyst',
    url: 'https://github.com/example/autocatalyst'
  },
  workspaceRootOverride: null,
  issueTrackerSetting: null,
  codeHostSetting: null,
  credentialRefs: [],
  createdAt: '2026-06-13T00:00:00.000Z',
  updatedAt: '2026-06-13T00:00:00.000Z'
};

const inboundMessage: Message = {
  id: 'msg_1',
  topicId: 'topic_1',
  owner,
  tenant: 'tenant_dev',
  author: owner,
  direction: 'inbound',
  body: 'Please author a real conformant spec for this feature.',
  createdAt: '2026-06-13T00:01:00.000Z'
};

// ---------------------------------------------------------------------------
// Repository mock factory
// ---------------------------------------------------------------------------

function makeRepos(overrides: Partial<{
  run: Run | null;
  topic: Topic | null;
  conversation: Conversation | null;
  project: Project | null;
  messages: readonly Message[];
  feedback: readonly Feedback[];
}>): DomainRepositories {
  const {
    run: runResult = run,
    topic: topicResult = topic,
    conversation: conversationResult = conversation,
    project: projectResult = project,
    messages: messagesResult = [inboundMessage],
    feedback: feedbackResult = []
  } = overrides;

  return {
    runs: {
      findById: vi.fn().mockResolvedValue(runResult)
    } as unknown as DomainRepositories['runs'],
    topics: {
      findById: vi.fn().mockResolvedValue(topicResult)
    } as unknown as DomainRepositories['topics'],
    conversations: {
      findById: vi.fn().mockResolvedValue(conversationResult)
    } as unknown as DomainRepositories['conversations'],
    projects: {
      findById: vi.fn().mockResolvedValue(projectResult)
    } as unknown as DomainRepositories['projects'],
    messages: {
      listByTopic: vi.fn().mockResolvedValue(messagesResult)
    } as unknown as DomainRepositories['messages'],
    artifacts: {} as unknown as DomainRepositories['artifacts'],
    feedback: {
      listByRun: vi.fn().mockResolvedValue(feedbackResult)
    } as unknown as DomainRepositories['feedback'],
    publications: {} as unknown as DomainRepositories['publications'],
    pullRequests: {} as unknown as DomainRepositories['pullRequests'],
    runSteps: {} as unknown as DomainRepositories['runSteps'],
    sessions: {} as unknown as DomainRepositories['sessions'],
    testResults: {} as unknown as DomainRepositories['testResults'],
    runWorkspaceMetadata: {} as unknown as DomainRepositories['runWorkspaceMetadata']
  };
}

function makeRequest(overrides?: Partial<LoadSpecAuthorPromptInputRequest>): LoadSpecAuthorPromptInputRequest {
  return {
    runId: 'run_1',
    tenantId: 'tenant_dev',
    repositories: makeRepos({}),
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests: tenant validation
// ---------------------------------------------------------------------------

describe('loadSpecAuthorPromptInput — tenant validation', () => {
  it('throws tenant_required when tenantId is undefined and repositories do not enforce tenant isolation', async () => {
    const request = makeRequest({ tenantId: undefined, repositoriesEnforceTenantIsolation: false });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      name: 'SpecAuthoringContextLoadError',
      code: 'tenant_required'
    });
  });

  it('succeeds when tenantId is undefined but repositoriesEnforceTenantIsolation is true', async () => {
    const request = makeRequest({ tenantId: undefined, repositoriesEnforceTenantIsolation: true });
    const result = await loadSpecAuthorPromptInput(request);
    expect(result.run.id).toBe('run_1');
  });

  it('throws tenant_mismatch when run tenant differs from tenantId', async () => {
    const runWrongTenant: Run = { ...run, tenant: 'tenant_other', owner: { ...owner, tenantId: 'tenant_other' } };
    const request = makeRequest({
      tenantId: 'tenant_dev',
      repositories: makeRepos({ run: runWrongTenant })
    });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'tenant_mismatch'
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: entity not found
// ---------------------------------------------------------------------------

describe('loadSpecAuthorPromptInput — entity not found', () => {
  it('throws run_not_found when run is null', async () => {
    const request = makeRequest({ repositories: makeRepos({ run: null }) });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'run_not_found'
    });
  });

  it('throws topic_not_found when topic is null', async () => {
    const request = makeRequest({ repositories: makeRepos({ topic: null }) });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'topic_not_found'
    });
  });

  it('throws conversation_not_found when conversation is null', async () => {
    const request = makeRequest({ repositories: makeRepos({ conversation: null }) });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'conversation_not_found'
    });
  });

  it('throws project_not_found when project is null', async () => {
    const request = makeRequest({ repositories: makeRepos({ project: null }) });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'project_not_found'
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: step and work kind validation
// ---------------------------------------------------------------------------

describe('loadSpecAuthorPromptInput — step and work kind validation', () => {
  it('throws unsupported_step when run.currentStep is not spec.author', async () => {
    const wrongStepRun: Run = { ...run, currentStep: 'spec.human_review' };
    const request = makeRequest({ repositories: makeRepos({ run: wrongStepRun }) });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'unsupported_step'
    });
  });

  it('throws unsupported_work_kind when workKind is not feature or enhancement', async () => {
    const wrongKindRun: Run = { ...run, workKind: 'bug' };
    const request = makeRequest({ repositories: makeRepos({ run: wrongKindRun }) });
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'unsupported_work_kind'
    });
  });

  it('accepts enhancement as a supported work kind', async () => {
    const enhancementRun: Run = { ...run, workKind: 'enhancement' };
    const request = makeRequest({ repositories: makeRepos({ run: enhancementRun }) });
    const result = await loadSpecAuthorPromptInput(request);
    expect(result.request.classification).toBe('enhancement');
  });
});

// ---------------------------------------------------------------------------
// Tests: missing request context
// ---------------------------------------------------------------------------

describe('loadSpecAuthorPromptInput — missing_request_context', () => {
  it('throws missing_request_context when no inbound messages and topic title is empty-ish', async () => {
    const emptyTitleTopic: Topic = { ...topic, title: '   ' };
    const request = makeRequest({
      repositories: makeRepos({ topic: emptyTitleTopic, messages: [] })
    });
    // Topic title is whitespace-only and no messages => no request text
    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'missing_request_context'
    });
  });

  it('succeeds when there are no messages but topic title provides context', async () => {
    const request = makeRequest({ repositories: makeRepos({ messages: [] }) });
    const result = await loadSpecAuthorPromptInput(request);
    // topic.title is non-empty so request text comes from that
    expect(result.request.text).toContain('Author a real conformant spec');
  });
});

// ---------------------------------------------------------------------------
// Tests: happy path
// ---------------------------------------------------------------------------

describe('loadSpecAuthorPromptInput — happy path', () => {
  it('returns a SpecAuthorPromptInput with run, project, conversation, topic, messages, and request', async () => {
    const request = makeRequest();
    const result = await loadSpecAuthorPromptInput(request);

    expect(result.run).toEqual(run);
    expect(result.project).toEqual(project);
    expect(result.conversation).toEqual(conversation);
    expect(result.topic).toEqual(topic);
    expect(result.messages).toHaveLength(1);
    expect(result.request.classification).toBe('feature');
    expect(result.request.text.length).toBeGreaterThan(0);
  });

  it('includes topic title and inbound message body in request text', async () => {
    const request = makeRequest();
    const result = await loadSpecAuthorPromptInput(request);

    expect(result.request.text).toContain(topic.title);
    expect(result.request.text).toContain(inboundMessage.body);
  });

  it('excludes outbound messages from request text', async () => {
    const outbound: Message = {
      ...inboundMessage,
      id: 'msg_2',
      direction: 'outbound',
      body: 'This is the AI response that should not appear in request text.'
    };
    const request = makeRequest({ repositories: makeRepos({ messages: [inboundMessage, outbound] }) });
    const result = await loadSpecAuthorPromptInput(request);

    expect(result.request.text).not.toContain(outbound.body);
  });

  it('sorts messages by createdAt ascending', async () => {
    const earlier: Message = { ...inboundMessage, id: 'msg_early', createdAt: '2026-06-13T00:00:30.000Z', body: 'Earlier message' };
    const later: Message = { ...inboundMessage, id: 'msg_late', createdAt: '2026-06-13T00:02:00.000Z', body: 'Later message' };
    const request = makeRequest({ repositories: makeRepos({ messages: [later, earlier] }) });
    const result = await loadSpecAuthorPromptInput(request);

    const earlierIdx = result.request.text.indexOf('Earlier message');
    const laterIdx = result.request.text.indexOf('Later message');
    expect(earlierIdx).toBeLessThan(laterIdx);
  });

  it('sets linkedIssue.number from trackedIssue when no issue reader is provided', async () => {
    const request = makeRequest({ issues: undefined });
    const result = await loadSpecAuthorPromptInput(request);

    expect(result.linkedIssue).toEqual({ number: 46 });
  });

  it('returns no linkedIssue when run has no trackedIssue', async () => {
    const runNoIssue: Run = { ...run, trackedIssue: undefined };
    const request = makeRequest({ repositories: makeRepos({ run: runNoIssue }) });
    const result = await loadSpecAuthorPromptInput(request);

    expect(result.linkedIssue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: issue context reader
// ---------------------------------------------------------------------------

describe('loadSpecAuthorPromptInput — issue context reader', () => {
  it('enriches linkedIssue with title, body, and labels from the reader', async () => {
    const issues: IssueContextReader = {
      read: vi.fn().mockResolvedValue({
        number: 46,
        title: 'Rich issue title',
        body: 'Detailed issue body',
        labels: ['feature', 'spec']
      })
    };
    const request = makeRequest({ issues });
    const result = await loadSpecAuthorPromptInput(request);

    expect(result.linkedIssue).toEqual({
      number: 46,
      title: 'Rich issue title',
      body: 'Detailed issue body',
      labels: ['feature', 'spec']
    });
  });

  it('uses trackedIssue.number as fallback when reader omits number', async () => {
    const issues: IssueContextReader = {
      read: vi.fn().mockResolvedValue({
        title: 'Issue title without number'
      })
    };
    const request = makeRequest({ issues });
    const result = await loadSpecAuthorPromptInput(request);

    expect(result.linkedIssue?.number).toBe(46);
  });

  it('throws issue_read_failed when the reader throws', async () => {
    const issues: IssueContextReader = {
      read: vi.fn().mockRejectedValue(new Error('GitHub API unavailable'))
    };
    const request = makeRequest({ issues });

    await expect(loadSpecAuthorPromptInput(request)).rejects.toMatchObject({
      code: 'issue_read_failed'
    });
  });

  it('does not call the issue reader when run has no trackedIssue', async () => {
    const runNoIssue: Run = { ...run, trackedIssue: undefined };
    const issues: IssueContextReader = { read: vi.fn() };
    const request = makeRequest({
      repositories: makeRepos({ run: runNoIssue }),
      issues
    });
    await loadSpecAuthorPromptInput(request);

    expect(issues.read).not.toHaveBeenCalled();
  });

  it('does not call the issue reader when tenantId is undefined (even with repositoriesEnforceTenantIsolation)', async () => {
    const issues: IssueContextReader = { read: vi.fn() };
    const request = makeRequest({
      tenantId: undefined,
      repositoriesEnforceTenantIsolation: true,
      issues
    });
    await loadSpecAuthorPromptInput(request);

    // Reader is only called when tenantId is defined
    expect(issues.read).not.toHaveBeenCalled();
  });

  it('passes correct arguments to the issue reader', async () => {
    const readFn = vi.fn().mockResolvedValue({ title: 'Issue' });
    const issues: IssueContextReader = { read: readFn };
    const request = makeRequest({ issues });
    await loadSpecAuthorPromptInput(request);

    expect(readFn).toHaveBeenCalledWith({
      tenantId: 'tenant_dev',
      run,
      project,
      issueNumber: 46
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: SpecAuthoringContextLoadError shape
// ---------------------------------------------------------------------------

describe('SpecAuthoringContextLoadError', () => {
  it('has the correct name and code', () => {
    const error = new SpecAuthoringContextLoadError('run_not_found', 'Run not found.');
    expect(error.name).toBe('SpecAuthoringContextLoadError');
    expect(error.code).toBe('run_not_found');
    expect(error.message).toBe('Run not found.');
    expect(error.safeDetails).toBeUndefined();
  });

  it('stores safeDetails when provided', () => {
    const details = { runId: 'run_1' } as const;
    const error = new SpecAuthoringContextLoadError('run_not_found', 'Run not found.', details);
    expect(error.safeDetails).toEqual({ runId: 'run_1' });
  });

  it('is an instance of Error', () => {
    const error = new SpecAuthoringContextLoadError('run_not_found', 'Run not found.');
    expect(error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Tests: revision feedback delivery (spec.human_review --revise--> spec.author)
// ---------------------------------------------------------------------------

describe('loadSpecAuthorPromptInput — revision feedback', () => {
  function feedbackRecord(overrides: Partial<Feedback>): Feedback {
    return {
      id: 'fb_1',
      runId: 'run_1',
      owner,
      tenant: 'tenant_dev',
      target: 'artifact',
      status: 'open',
      title: 'Tighten the error taxonomy',
      body: 'Enumerate every error code in the spec.',
      thread: [{ id: 't_1', author: owner, body: 'Enumerate every error code in the spec.', createdAt: '2026-06-13T00:02:00.000Z' }],
      createdAt: '2026-06-13T00:02:00.000Z',
      updatedAt: '2026-06-13T00:02:00.000Z',
      ...overrides
    } as Feedback;
  }

  it('delivers open human artifact feedback as revisionFeedback', async () => {
    const request = makeRequest({
      repositories: makeRepos({ feedback: [feedbackRecord({})] })
    });
    const result = await loadSpecAuthorPromptInput(request);
    expect(result.revisionFeedback).toEqual([
      { title: 'Tighten the error taxonomy', body: 'Enumerate every error code in the spec.' }
    ]);
  });

  it('excludes non-open, non-human, and non-artifact feedback', async () => {
    const modelPrincipal = { kind: 'model' as const, id: 'reviewer', tenantId: 'tenant_dev' };
    const request = makeRequest({
      repositories: makeRepos({
        feedback: [
          feedbackRecord({ id: 'fb_addressed', status: 'addressed' }),
          feedbackRecord({ id: 'fb_impl_target', target: 'implementation' }),
          feedbackRecord({
            id: 'fb_model_author',
            thread: [{ id: 't', author: modelPrincipal, body: 'x', createdAt: '2026-06-13T00:02:00.000Z' }]
          })
        ]
      })
    });
    const result = await loadSpecAuthorPromptInput(request);
    expect(result.revisionFeedback).toBeUndefined();
  });

  it('omits revisionFeedback entirely when there is no open feedback', async () => {
    const request = makeRequest({ repositories: makeRepos({ feedback: [] }) });
    const result = await loadSpecAuthorPromptInput(request);
    expect(result.revisionFeedback).toBeUndefined();
  });
});
