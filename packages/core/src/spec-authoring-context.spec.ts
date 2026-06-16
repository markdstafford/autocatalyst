import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Project, Run, Topic } from '@autocatalyst/api-contract';

import {
  SpecAuthorContextError,
  assertSupportedSpecAuthorWorkKind,
  buildSpecAuthorContext,
  buildSpecAuthorPrompt,
  buildSpecAuthorTaskInputs,
  toSafeDetails
} from './spec-authoring-context.js';

const owner = { kind: 'human' as const, id: 'user_1', tenantId: 'tenant_dev' };

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_feature_12345678',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_dev',
    workKind: 'feature',
    currentStep: 'spec.author',
    terminal: false,
    trackedIssue: { number: 46, title: 'Author a real conformant spec', state: 'open', url: 'https://github.com/acme/widgets/issues/46' },
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
    ...overrides
  } as Run;
}

const project: Project = {
  id: 'project_1',
  owner,
  tenant: 'tenant_dev',
  displayName: 'Widget Service',
  repoUrl: 'https://github.com/acme/widgets.git',
  hostRepository: { provider: 'github', owner: 'acme', name: 'widgets', url: 'https://github.com/acme/widgets' },
  workspaceRootOverride: null,
  issueTrackerSetting: null,
  codeHostSetting: null,
  credentialRefs: [],
  createdAt: '2026-06-13T00:00:00.000Z',
  updatedAt: '2026-06-13T00:00:00.000Z'
};

const topic: Topic = {
  id: 'topic_1',
  conversationId: 'conversation_1',
  owner,
  tenant: 'tenant_dev',
  title: 'Author real conformant spec',
  kind: 'main',
  createdAt: '2026-06-13T00:00:00.000Z',
  updatedAt: '2026-06-13T00:00:00.000Z'
};

const conversation: Conversation = {
  id: 'conversation_1',
  projectId: 'project_1',
  owner,
  tenant: 'tenant_dev',
  identity: 'conversation-1',
  activeTopicId: 'topic_1',
  createdAt: '2026-06-13T00:00:00.000Z',
  updatedAt: '2026-06-13T00:00:00.000Z'
};

const messages: readonly Message[] = [
  {
    id: 'message_2',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_dev',
    author: owner,
    direction: 'inbound',
    body: 'Please make spec.author create a real draft spec.',
    intent: 'create',
    createdAt: '2026-06-13T00:00:02.000Z'
  },
  {
    id: 'message_1',
    topicId: 'topic_1',
    owner,
    tenant: 'tenant_dev',
    author: owner,
    direction: 'inbound',
    body: 'The current prompt is placeholder text.',
    createdAt: '2026-06-13T00:00:01.000Z'
  }
];

const baseInput = {
  run: makeRun(),
  project,
  conversation,
  topic,
  messages,
  request: {
    text: 'Build a real spec authoring prompt and task-input contract.',
    classification: 'feature' as const
  },
  linkedIssue: {
    number: 46,
    title: 'Author a real conformant spec',
    body: 'Replace placeholder spec.author dispatch.',
    labels: ['feature']
  }
};

describe('spec-authoring context builders', () => {
  it('builds a feature prompt with planning, ownership, task list, and result-contract instructions', () => {
    const prompt = buildSpecAuthorPrompt(baseInput);
    expect(prompt).not.toContain('Complete the spec.author step.');
    expect(prompt).toContain('mm:planning');
    expect(prompt).toContain('feature');
    expect(prompt).toContain('current branch');
    expect(prompt).toContain('do not create branches');
    expect(prompt).toContain('do not create worktrees');
    expect(prompt).toContain('do not push');
    expect(prompt).toContain('do not merge');
    expect(prompt).toContain('do not open PRs');
    expect(prompt).toContain('requirements');
    expect(prompt).toContain('design spec');
    expect(prompt).toContain('tech spec');
    expect(prompt).toContain('## Task list');
    expect(prompt).toContain('step-result.json');
    expect(prompt).toContain('kind');
    expect(prompt).toContain('slug');
    expect(prompt).toContain('relativePath');
    expect(prompt).toContain('frontmatter');
    expect(prompt).toContain('body');
    expect(prompt).toContain('The system will stamp `frontmatter.specced_by`');
    expect(prompt).toContain('Do not invent `specced_by`');
    expect(prompt).not.toContain('Frontmatter must include `created`, `last_updated`, `status: "draft"`, and `specced_by`');
  });

  it('builds feature task inputs with schema id, exact file rules, issue guidance, and chronological messages', () => {
    const inputs = buildSpecAuthorTaskInputs(baseInput);
    expect(inputs.outputContract.schemaId).toBe('autocatalyst.spec_author.v1');
    expect(inputs.outputContract.resultFile).toBe('step-result.json');
    expect(inputs.outputContract.expectedKind).toBe('feature_spec');
    expect(inputs.outputContract.expectedPathPrefix).toBe('context-human/specs/feature-');
    expect(inputs.outputContract.expectedRelativePathPattern).toBe('context-human/specs/feature-<slug>.md');
    expect(inputs.outputContract.frontmatter.status).toBe('draft');
    expect(inputs.outputContract.frontmatter.required).toEqual(['created', 'last_updated', 'status']);
    expect(inputs.outputContract.frontmatter.trustedSpeccedBy).toBe('autocatalyst');
    expect(inputs.outputContract.frontmatter.issue).toEqual({ requiredWhenPresentOnRun: true, type: 'positive integer' });
    expect(inputs.run.issueNumber).toBe(46);
    expect(inputs.conversation?.messages.map((m) => m.id)).toEqual(['message_1', 'message_2']);
    expect(inputs.request.text).toContain('real spec authoring prompt');
  });

  it('stamps trustedSpeccedBy from specAuthorIdentity when provided', () => {
    const inputs = buildSpecAuthorTaskInputs({ ...baseInput, specAuthorIdentity: 'markdstafford' });
    expect(inputs.outputContract.frontmatter.trustedSpeccedBy).toBe('markdstafford');
  });

  it('includes the specAuthorIdentity value in the prompt text', () => {
    const prompt = buildSpecAuthorPrompt({ ...baseInput, specAuthorIdentity: 'markdstafford' });
    expect(prompt).toContain('stamp `frontmatter.specced_by` as `markdstafford`');
  });

  it('defaults trustedSpeccedBy to autocatalyst when specAuthorIdentity is omitted', () => {
    const inputs = buildSpecAuthorTaskInputs(baseInput);
    expect(inputs.outputContract.frontmatter.trustedSpeccedBy).toBe('autocatalyst');
    const prompt = buildSpecAuthorPrompt(baseInput);
    expect(prompt).toContain('stamp `frontmatter.specced_by` as `autocatalyst`');
  });

  it('builds enhancement-specific kind and path rules', () => {
    const inputs = buildSpecAuthorTaskInputs({
      ...baseInput,
      run: makeRun({ workKind: 'enhancement', trackedIssue: undefined }),
      request: { text: 'Improve existing spec authoring.', classification: 'enhancement' as const },
      linkedIssue: undefined
    });
    expect(inputs.outputContract.expectedKind).toBe('enhancement_spec');
    expect(inputs.outputContract.expectedPathPrefix).toBe('context-human/specs/enhancement-');
    expect(inputs.outputContract.expectedRelativePathPattern).toBe('context-human/specs/enhancement-<slug>.md');
    expect(inputs.run.issueNumber).toBeUndefined();
  });

  it('uses one validation path for prompt, task inputs, and combined context', () => {
    const combined = buildSpecAuthorContext(baseInput);
    expect(combined.prompt).toBe(buildSpecAuthorPrompt(baseInput));
    expect(combined.taskInputs).toEqual(buildSpecAuthorTaskInputs(baseInput));
  });

  it('rejects unsupported work kinds', () => {
    expect(() => assertSupportedSpecAuthorWorkKind('bug')).toThrow(SpecAuthorContextError);
    expect(() => buildSpecAuthorContext({ ...baseInput, run: makeRun({ workKind: 'bug' }) })).toThrow(SpecAuthorContextError);
  });

  it('rejects unsafe diagnostic keys', () => {
    expect(() => toSafeDetails({ runId: 'run_1', prompt: 'raw prompt' })).toThrow(SpecAuthorContextError);
    expect(toSafeDetails({ runId: 'run_1', workKind: 'feature', messageCount: 2 })).toEqual({
      runId: 'run_1',
      workKind: 'feature',
      messageCount: 2
    });
  });

  it('includes bodyContract in task inputs with correct completeness requirements', () => {
    const inputs = buildSpecAuthorTaskInputs(baseInput);
    expect(inputs.bodyContract.required).toBe(true);
    expect(inputs.bodyContract.requiresCompleteTopLevelTaskList).toBe(true);
    expect(inputs.bodyContract.taskListPlaceholderAllowed).toBe(false);
  });
});
