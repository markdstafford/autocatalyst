import type { Conversation, Message, Project, Run, Topic } from '@autocatalyst/api-contract';

export type SpecAuthorSupportedWorkKind = 'feature' | 'enhancement';
export type SpecAuthorExpectedKind = 'feature_spec' | 'enhancement_spec';

export type SpecAuthorContextErrorCode =
  | 'unsupported_step'
  | 'unsupported_work_kind'
  | 'missing_run_identifier'
  | 'missing_request_context'
  | 'unsafe_diagnostic_key';

export class SpecAuthorContextError extends Error {
  readonly code: SpecAuthorContextErrorCode;
  readonly safeDetails?: Readonly<Record<string, unknown>>;

  constructor(code: SpecAuthorContextErrorCode, message: string, safeDetails?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'SpecAuthorContextError';
    this.code = code;
    if (safeDetails !== undefined) this.safeDetails = safeDetails;
  }
}

export interface SpecAuthorRequestContext {
  readonly text: string;
  readonly classification: SpecAuthorSupportedWorkKind;
}

export interface SpecAuthorLinkedIssueContext {
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly labels?: readonly string[];
}

export interface SpecAuthorPromptInput {
  readonly run: Run;
  readonly project?: Project;
  readonly conversation?: Conversation;
  readonly topic?: Topic;
  readonly messages?: readonly Message[];
  readonly request: SpecAuthorRequestContext;
  readonly linkedIssue?: SpecAuthorLinkedIssueContext;
  /** GitHub username or service identity to stamp as specced_by. Defaults to 'autocatalyst'. */
  readonly specAuthorIdentity?: string;
}

export interface SpecAuthorOutputContractInput {
  readonly schemaId: 'autocatalyst.spec_author.v1';
  readonly resultFile: 'step-result.json';
  readonly expectedKind: SpecAuthorExpectedKind;
  readonly expectedPathPrefix: string;
  readonly expectedRelativePathPattern: string;
  readonly requiredResultFields: readonly ['kind', 'slug', 'relativePath', 'frontmatter', 'body'];
  readonly slug: {
    readonly pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$';
    readonly pathRule: 'relativePath must equal context-human/specs/<feature|enhancement>-<slug>.md';
  };
  readonly frontmatter: {
    readonly status: 'draft';
    readonly required: readonly ['created', 'last_updated', 'status'];
    readonly trustedSpeccedBy: string;
    readonly issue: { readonly requiredWhenPresentOnRun: true; readonly type: 'positive integer' };
  };
  readonly body: { readonly minLength: 1; readonly description: 'Markdown spec body, not a path or prose summary' };
}

export interface SpecAuthorTaskInputs {
  readonly schemaId: 'autocatalyst.spec_author.v1';
  readonly resultFile: 'step-result.json';
  readonly run: {
    readonly id: string;
    readonly tenant: string;
    readonly workKind: SpecAuthorSupportedWorkKind;
    readonly currentStep: 'spec.author';
    readonly issueNumber?: number;
  };
  readonly project?: {
    readonly id: string;
    readonly tenant: string;
    readonly displayName: string;
    readonly repository: { readonly provider: string; readonly owner: string; readonly name: string; readonly url?: string };
  };
  readonly conversation?: {
    readonly id: string;
    readonly topicId?: string;
    readonly topicTitle?: string;
    readonly messages: ReadonlyArray<{
      readonly id: string;
      readonly direction: Message['direction'];
      readonly body: string;
      readonly createdAt: string;
      readonly intent?: string;
    }>;
  };
  readonly request: {
    readonly text: string;
    readonly classification: SpecAuthorSupportedWorkKind;
    readonly linkedIssue?: SpecAuthorLinkedIssueContext;
  };
  readonly outputContract: SpecAuthorOutputContractInput;
  readonly bodyContract: {
    readonly required: true;
    readonly requiresCompleteTopLevelTaskList: true;
    readonly taskListPlaceholderAllowed: false;
    readonly taskListRequirements: readonly string[];
  };
  readonly runtimeOwnership: {
    readonly currentBranchOnly: true;
    readonly prohibitBranchCreation: true;
    readonly prohibitBranchSwitching: true;
    readonly prohibitWorktreeCreation: true;
    readonly prohibitPush: true;
    readonly prohibitMerge: true;
    readonly prohibitPullRequest: true;
  };
  readonly planningScope: {
    readonly stages: readonly ['requirements', 'design', 'tech_spec'];
    readonly taskList: 'include hierarchical stories/tasks with descriptions, acceptance criteria, and dependencies';
    readonly stopPoint: 'stop after writing step-result.json; the run pauses at spec.human_review before implementation';
  };
}

export interface SpecAuthorContext {
  readonly prompt: string;
  readonly taskInputs: SpecAuthorTaskInputs;
}

const UNSAFE_DIAGNOSTIC_KEY_PATTERN = /prompt|body|response|secret|token|credential|authorization|header/iu;

export function toSafeDetails(details: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  for (const key of Object.keys(details)) {
    if (UNSAFE_DIAGNOSTIC_KEY_PATTERN.test(key)) {
      throw new SpecAuthorContextError('unsafe_diagnostic_key', 'Unsafe diagnostic key for spec authoring context.', { key });
    }
  }
  return { ...details };
}

export function assertSupportedSpecAuthorWorkKind(workKind: string): asserts workKind is SpecAuthorSupportedWorkKind {
  if (workKind === 'feature' || workKind === 'enhancement') return;
  throw new SpecAuthorContextError(
    'unsupported_work_kind',
    'spec.author supports only feature and enhancement workflows.',
    toSafeDetails({ workKind })
  );
}

function validateInput(input: SpecAuthorPromptInput): SpecAuthorSupportedWorkKind {
  const runId = input.run.id.trim();
  if (runId.length === 0) {
    throw new SpecAuthorContextError('missing_run_identifier', 'spec.author requires a non-empty run id.');
  }
  if (input.run.currentStep !== 'spec.author') {
    throw new SpecAuthorContextError(
      'unsupported_step',
      'Spec authoring context can only be built for spec.author.',
      toSafeDetails({ runId: input.run.id, currentStep: input.run.currentStep })
    );
  }
  assertSupportedSpecAuthorWorkKind(input.run.workKind);
  if (input.request.classification !== input.run.workKind) {
    throw new SpecAuthorContextError(
      'unsupported_work_kind',
      'Request classification must match run work kind: expected classification to equal work kind.',
      toSafeDetails({ runId: input.run.id, workKind: input.run.workKind, classification: input.request.classification })
    );
  }
  if (input.request.text.trim().length === 0) {
    throw new SpecAuthorContextError('missing_request_context', 'spec.author requires non-empty request context.', toSafeDetails({ runId: input.run.id }));
  }
  // Cast is necessary: Run.workKind is typed as string (z.string().min(1)); the assertion
  // above narrows the local type but TypeScript does not narrow property re-reads.
  return input.run.workKind as SpecAuthorSupportedWorkKind;
}

function expectedKindFor(workKind: SpecAuthorSupportedWorkKind): SpecAuthorExpectedKind {
  return workKind === 'feature' ? 'feature_spec' : 'enhancement_spec';
}

function expectedPrefixFor(workKind: SpecAuthorSupportedWorkKind): 'feature' | 'enhancement' {
  return workKind === 'feature' ? 'feature' : 'enhancement';
}

function outputContractFor(workKind: SpecAuthorSupportedWorkKind, specAuthorIdentity?: string): SpecAuthorOutputContractInput {
  const prefix = expectedPrefixFor(workKind);
  return {
    schemaId: 'autocatalyst.spec_author.v1',
    resultFile: 'step-result.json',
    expectedKind: expectedKindFor(workKind),
    expectedPathPrefix: `context-human/specs/${prefix}-`,
    expectedRelativePathPattern: `context-human/specs/${prefix}-<slug>.md`,
    requiredResultFields: ['kind', 'slug', 'relativePath', 'frontmatter', 'body'],
    slug: {
      pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
      pathRule: 'relativePath must equal context-human/specs/<feature|enhancement>-<slug>.md'
    },
    frontmatter: {
      status: 'draft',
      required: ['created', 'last_updated', 'status'],
      trustedSpeccedBy: specAuthorIdentity ?? 'autocatalyst',
      issue: { requiredWhenPresentOnRun: true, type: 'positive integer' }
    },
    body: { minLength: 1, description: 'Markdown spec body, not a path or prose summary' }
  };
}

function sortMessages(messages: readonly Message[] | undefined): readonly Message[] {
  return [...(messages ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function buildSpecAuthorPrompt(input: SpecAuthorPromptInput): string {
  const workKind = validateInput(input);
  const contract = outputContractFor(workKind, input.specAuthorIdentity);
  const issueLine = input.linkedIssue !== undefined
    ? `Linked issue: #${input.linkedIssue.number}${input.linkedIssue.title !== undefined ? ` — ${input.linkedIssue.title}` : ''}`
    : 'Linked issue: none supplied.';
  const messageLines = sortMessages(input.messages).map(
    (m) => `- [${m.createdAt}] ${m.direction}${m.intent !== undefined ? `/${m.intent}` : ''}: ${m.body}`
  );

  return [
    `You are authoring the ${workKind} spec for Autocatalyst run ${input.run.id}.`,
    '',
    'Required runtime skill: use the materialized `mm:planning` skill. Do not substitute a different planning method.',
    '',
    'Runtime ownership rules:',
    '- Stay on the current branch only.',
    '- do not create branches and do not switch branches.',
    '- do not create worktrees.',
    '- do not push, do not merge, and do not open PRs.',
    '- Do not begin implementation; the run pauses at `spec.human_review` after this authoring step.',
    '',
    'Planning scope:',
    '- Author requirements, design spec, and tech spec sections before task decomposition.',
    '- Include a top-level `## Task list` with hierarchical stories/tasks, descriptions, acceptance criteria, and dependencies.',
    '- Treat the task list as planning output only; it does not authorize implementation.',
    '',
    'Output contract:',
    `- Write scratch result file: ${contract.resultFile}.`,
    `- Use kind: ${contract.expectedKind}.`,
    `- Use relativePath pattern: ${contract.expectedRelativePathPattern}.`,
    '- The JSON result must contain exactly the schema fields `kind`, `slug`, `relativePath`, `frontmatter`, and `body`.',
    '- Frontmatter must include `created`, `last_updated`, and `status: "draft"`; include integer `issue` when the run has a linked issue.',
    `- The system will stamp \`frontmatter.specced_by\` as \`${contract.frontmatter.trustedSpeccedBy}\` before validation and commit.`,
    '- Do not invent `specced_by`, and do not include model, skill, run, or prose identity strings for that field.',
    '- `body` must contain the non-empty Markdown spec body, not only a file path or prose summary.',
    '',
    'Run context:',
    `- Work kind: ${workKind}.`,
    `- Topic: ${input.topic?.title ?? 'not supplied'}.`,
    `- Project: ${input.project?.displayName ?? 'not supplied'}.`,
    issueLine,
    '',
    'Request context:',
    input.request.text,
    '',
    'Conversation messages, chronological:',
    ...(messageLines.length > 0 ? messageLines : ['- none supplied']),
    '',
    'Return no alternate result shape.'
  ].join('\n');
}

export function buildSpecAuthorTaskInputs(input: SpecAuthorPromptInput): SpecAuthorTaskInputs {
  const workKind = validateInput(input);
  const issueNumber = input.run.trackedIssue?.number ?? input.linkedIssue?.number;
  const sorted = sortMessages(input.messages);
  return {
    schemaId: 'autocatalyst.spec_author.v1',
    resultFile: 'step-result.json',
    run: {
      id: input.run.id,
      tenant: input.run.tenant,
      workKind,
      currentStep: 'spec.author',
      ...(issueNumber !== undefined ? { issueNumber } : {})
    },
    ...(input.project !== undefined ? {
      project: {
        id: input.project.id,
        tenant: input.project.tenant,
        displayName: input.project.displayName,
        repository: {
          provider: input.project.hostRepository.provider,
          owner: input.project.hostRepository.owner,
          name: input.project.hostRepository.name,
          ...(input.project.hostRepository.url !== undefined ? { url: input.project.hostRepository.url } : {})
        }
      }
    } : {}),
    ...(input.conversation !== undefined || input.topic !== undefined || sorted.length > 0 ? {
      conversation: {
        // 'unknown' is a safe sentinel when topic/messages exist but no conversation id is available
        id: input.conversation?.id ?? 'unknown',
        ...(input.topic !== undefined ? { topicId: input.topic.id, topicTitle: input.topic.title } : {}),
        messages: sorted.map((m) => ({
          id: m.id,
          direction: m.direction,
          body: m.body,
          createdAt: m.createdAt,
          ...(m.intent !== undefined ? { intent: m.intent } : {})
        }))
      }
    } : {}),
    request: {
      text: input.request.text,
      classification: workKind,
      ...(input.linkedIssue !== undefined ? { linkedIssue: input.linkedIssue } : {})
    },
    outputContract: outputContractFor(workKind, input.specAuthorIdentity),
    bodyContract: {
      required: true,
      requiresCompleteTopLevelTaskList: true,
      taskListPlaceholderAllowed: false,
      taskListRequirements: [
        'top-level ## Task list heading',
        'hierarchical stories and tasks',
        'descriptions',
        'acceptance criteria',
        'dependencies'
      ]
    },
    runtimeOwnership: {
      currentBranchOnly: true,
      prohibitBranchCreation: true,
      prohibitBranchSwitching: true,
      prohibitWorktreeCreation: true,
      prohibitPush: true,
      prohibitMerge: true,
      prohibitPullRequest: true
    },
    planningScope: {
      stages: ['requirements', 'design', 'tech_spec'],
      taskList: 'include hierarchical stories/tasks with descriptions, acceptance criteria, and dependencies',
      stopPoint: 'stop after writing step-result.json; the run pauses at spec.human_review before implementation'
    }
  };
}

export function buildSpecAuthorContext(input: SpecAuthorPromptInput): SpecAuthorContext {
  validateInput(input);
  return {
    prompt: buildSpecAuthorPrompt(input),
    taskInputs: buildSpecAuthorTaskInputs(input)
  };
}
