import { randomUUID } from 'node:crypto';
import { mkdir, readFile as _readFile, unlink } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../logger.js';
import type {
  AgentRunContentBlock,
  AgentRunEvent,
  AgentRunner,
  AgentRoutingPolicy,
  ArtifactAuthoringAgent,
  ArtifactComment,
  ArtifactCommentResponse,
  ArtifactCreateResult,
  ArtifactRevisionResult,
  ImplementationAgent,
  ImplementationResult,
  ImplementationReviewFinding,
  ImplementationReviewResult,
  ImplementationStatus,
  IssueTriageAgent,
  IssueTriageItem,
  IssueTriageResult,
  QuestionAnsweringAgent,
} from '../../types/ai.js';
import type { Request, ThreadMessage } from '../../types/events.js';
import type { FilingResult, FiledIssue, IssueFiler } from '../../types/issue-filing.js';
import type { IssueManager } from '../../types/issue-tracker.js';
import { artifactKindForIntent } from '../../types/artifact.js';
import type { ArtifactCommentAnchorCodec } from '../../types/publisher.js';

type ReadFileFn = (path: string, encoding: 'utf-8') => Promise<string>;

interface AgentServiceOptions {
  logDestination?: pino.DestinationStream;
  readFile?: ReadFileFn;
  commentAnchorCodec?: ArtifactCommentAnchorCodec;
}

export class AgentRunnerArtifactAuthoringAgent implements ArtifactAuthoringAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;
  private readonly commentAnchorCodec: ArtifactCommentAnchorCodec | undefined;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('artifact-authoring-agent', { destination: options?.logDestination });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
    this.commentAnchorCodec = options?.commentAnchorCodec;
  }

  async create(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
    intent: 'idea' | 'bug' | 'chore' = 'idea',
  ): Promise<ArtifactCreateResult> {
    const createResultPath = join(workspace_path, '.autocatalyst', 'spec-create-result.json');
    const artifactDir = (intent === 'bug' || intent === 'chore')
      ? join(workspace_path, '.autocatalyst', 'triage')
      : join(workspace_path, 'context-human', 'specs');
    const route = {
      task: 'artifact.create' as const,
      stage: 'new_thread' as const,
      intent,
      artifact_kind: artifactKindForIntent(intent),
    };
    const prompt = buildArtifactCreatePrompt(request, artifactDir, createResultPath, intent);

    this.logger.debug({ event: 'artifact.agent_invoked', request_id: request.id }, 'Invoking agent for artifact creation');

    try {
      await ensureResultDir(createResultPath);
      await drainAgentRunner(
        this.runner.run({
          route,
          profile: this.routingPolicy.resolve(route),
          working_directory: workspace_path,
          prompt,
        }),
        onProgress,
        this.logger,
        'artifact_generation',
      );
    } catch (err) {
      this.logger.error(
        { event: 'artifact.agent_failed', request_id: request.id, error: String(err) },
        'Agent exited with error during artifact creation',
      );
      throw new Error(`Artifact creation failed: ${String(err)}`);
    }

    const content = await readRequiredFile(this.readFileFn, createResultPath, 'Artifact creation');
    const result = parseArtifactCreateResult(content, createResultPath);
    this.logger.info(
      { event: 'artifact.generated', request_id: request.id, artifact_path: result.artifact_path, existing_issue: result.existing_issue },
      'Artifact generated',
    );
    return result;
  }

  async revise(
    feedback: ThreadMessage,
    artifact_comments: ArtifactComment[],
    artifact_path: string,
    workspace_path: string,
    current_page_markdown?: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<ArtifactRevisionResult> {
    const reviseResultPath = join(workspace_path, '.autocatalyst', 'spec-revise-result.json');
    const originalAnchors = current_page_markdown && this.commentAnchorCodec
      ? this.commentAnchorCodec.extract(current_page_markdown)
      : [];
    const hasAnchors = originalAnchors.length > 0;
    const currentArtifact = hasAnchors ? current_page_markdown! : readFileSync(artifact_path, 'utf-8');
    const route = {
      task: 'artifact.revise' as const,
      stage: 'reviewing_spec' as const,
      intent: 'feedback' as const,
    };
    const prompt = buildArtifactRevisePrompt(
      feedback,
      artifact_comments,
      artifact_path,
      reviseResultPath,
      currentArtifact,
      hasAnchors ? this.commentAnchorCodec?.promptInstructions(originalAnchors) ?? [] : [],
    );

    this.logger.debug(
      { event: 'artifact_revision.input', request_id: feedback.request_id, publisher_comment_count: artifact_comments.length },
      'Revise called with publisher comments',
    );

    try {
      await ensureResultDir(reviseResultPath);
      await drainAgentRunner(
        this.runner.run({
          route,
          profile: this.routingPolicy.resolve(route),
          working_directory: workspace_path,
          prompt,
        }),
        onProgress,
        this.logger,
        'artifact_generation',
      );
    } catch (err) {
      this.logger.error(
        { event: 'artifact.agent_failed', request_id: feedback.request_id, error: String(err) },
        'Agent exited with error during artifact revision',
      );
      throw new Error(`Artifact revision failed: ${String(err)}`);
    }

    const content = await readRequiredFile(this.readFileFn, reviseResultPath, 'Artifact revision');
    const commentResponses = parseCommentResponses(content, reviseResultPath);

    if (hasAnchors && this.commentAnchorCodec) {
      const agentArtifact = readFileSync(artifact_path, 'utf-8');
      const pageContent = this.commentAnchorCodec.preserve(agentArtifact, originalAnchors);
      writeFileSync(artifact_path, this.commentAnchorCodec.strip(pageContent), 'utf-8');
      return { comment_responses: commentResponses, page_content: pageContent };
    }

    return { comment_responses: commentResponses };
  }
}

export class AgentRunnerImplementationAgent implements ImplementationAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('implementation-agent', { destination: options?.logDestination });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async implement(
    artifact_path: string,
    working_directory: string,
    additional_context?: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<ImplementationResult> {
    const resultFilePath = join(working_directory, '.autocatalyst', 'impl-result.json');
    const prompt = buildImplementationPrompt(artifact_path, resultFilePath, additional_context);
    const route = { task: 'implementation.run' as const };

    this.logger.debug(
      { event: 'impl.agent_invoked', working_directory, has_additional_context: Boolean(additional_context) },
      'Invoking agent for implementation',
    );

    try {
      await ensureResultDir(resultFilePath);
      await drainAgentRunner(
        this.runner.run({
          route,
          profile: this.routingPolicy.resolve(route),
          working_directory,
          prompt,
        }),
        onProgress,
        this.logger,
        'implementation',
      );
    } catch (err) {
      this.logger.error({ event: 'impl.agent_failed', error: String(err) }, 'Agent exited with error during implementation');
      throw new Error(`Implementation failed: ${String(err)}`);
    }

    const content = await readRequiredFile(this.readFileFn, resultFilePath, 'Implementation');
    const result = parseImplementationResult(content, resultFilePath);
    this.logger.debug({ event: 'impl.agent_completed', status: result.status }, 'Agent implementation completed');
    return result;
  }
}

export class AgentRunnerQuestionAnsweringAgent implements QuestionAnsweringAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    private readonly repo_path: string,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('question-answering-agent', { destination: options?.logDestination });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async answer(question: string): Promise<string> {
    const resultPath = join(this.repo_path, '.autocatalyst', `question-${randomUUID()}.json`);
    const prompt = buildQuestionPrompt(question, resultPath);
    const route = { task: 'question.answer' as const };

    this.logger.debug({ event: 'question.answering', question_length: question.length }, 'Answering question via agent');

    try {
      await ensureResultDir(resultPath);
      await drainAgentRunner(
        this.runner.run({
          route,
          profile: this.routingPolicy.resolve(route),
          working_directory: this.repo_path,
          prompt,
        }),
        undefined,
        this.logger,
        'question_answering',
      );
    } catch (err) {
      this.logger.error({ event: 'question.agent_failed', error: String(err) }, 'Agent exited with error during question answering');
      throw new Error(`Agent question answering failed: ${String(err)}`);
    }

    const content = await readRequiredFile(this.readFileFn, resultPath, 'Question answering');
    unlink(resultPath).catch(() => {});
    const answer = parseQuestionAnswer(content);
    this.logger.info({ event: 'question.answered', response_length: answer.length }, 'Question answered');
    return answer;
  }
}

export class AgentRunnerIssueTriageAgent implements IssueTriageAgent {
  private readonly logger: pino.Logger;
  private readonly readFileFn: ReadFileFn;

  constructor(
    private readonly runner: AgentRunner,
    private readonly routingPolicy: AgentRoutingPolicy,
    options?: AgentServiceOptions,
  ) {
    this.logger = createLogger('issue-triage-agent', { destination: options?.logDestination });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async triage(
    request: Request,
    working_directory: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<IssueTriageResult> {
    const resultPath = join(working_directory, '.autocatalyst', 'enrichment-result.json');
    const prompt = buildIssueTriagePrompt(request, resultPath);
    const route = { task: 'issue.triage' as const };

    this.logger.debug({ event: 'filing.agent_invoked', request_id: request.id }, 'Invoking agent for issue triage');

    try {
      await ensureResultDir(resultPath);
      await drainAgentRunner(
        this.runner.run({
          route,
          profile: this.routingPolicy.resolve(route),
          working_directory,
          prompt,
        }),
        onProgress,
        this.logger,
        'issue_triage',
      );
    } catch (err) {
      this.logger.error(
        { event: 'filing.agent_failed', request_id: request.id, error: String(err) },
        'Agent exited with error during issue triage',
      );
      throw new Error(`Issue triage failed: ${String(err)}`);
    }

    return readAndValidateIssueTriageResult(this.readFileFn, resultPath);
  }
}

export class IssueFilingService implements IssueFiler {
  constructor(
    private readonly issueManager: Pick<IssueManager, 'create'>,
    private readonly issueTriageAgent: IssueTriageAgent,
  ) {}

  async file(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<FilingResult> {
    const triageResult = await this.issueTriageAgent.triage(request, workspace_path, onProgress);
    if (triageResult.status === 'failed') {
      return {
        status: 'failed',
        summary: '',
        filed_issues: [],
        error: triageResult.error ?? 'Issue triage agent reported failure',
      };
    }

    const filed_issues: FiledIssue[] = [];
    for (const item of triageResult.items) {
      if (item.duplicate_of) {
        filed_issues.push({
          number: item.duplicate_of.number,
          title: item.duplicate_of.title,
          action: 'duplicate',
        });
      } else {
        const created = await this.issueManager.create(
          workspace_path,
          item.proposed_title,
          item.proposed_body,
          item.proposed_labels,
        );
        filed_issues.push({ number: created.number, title: item.proposed_title, action: 'filed' });
      }
    }

    return { status: 'complete', summary: buildIssueFilingSummary(filed_issues), filed_issues };
  }
}

export async function drainAgentRunner(
  events: AsyncIterable<AgentRunEvent>,
  onProgress: ((message: string) => Promise<void> | void) | undefined,
  logger: Pick<pino.Logger, 'info' | 'warn'>,
  phase: string,
): Promise<void> {
  for await (const event of events) {
    const content = assistantContent(event);
    if (!onProgress || !content) continue;
    const relayMessage = parseRelayMessage(content);
    if (!relayMessage) continue;
    try {
      await onProgress(relayMessage);
      logger.info({ event: 'progress_update', phase, message: relayMessage }, 'Progress update posted');
    } catch (err) {
      logger.warn({ event: 'progress_failed', phase, error: String(err) }, 'Failed to post progress update');
    }
  }
}

function assistantContent(event: AgentRunEvent): AgentRunContentBlock[] | undefined {
  if (event.type !== 'assistant') return undefined;
  const content = (event as { content?: unknown }).content;
  return Array.isArray(content) ? content as AgentRunContentBlock[] : undefined;
}

export function parseRelayMessage(content: AgentRunContentBlock[]): string | null {
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      for (const line of block.text.split('\n')) {
        const match = line.match(/^\[Relay\]\s+(.+)$/);
        if (match) return match[1].trim();
      }
    }
  }
  return null;
}

async function readRequiredFile(readFileFn: ReadFileFn, path: string, label: string): Promise<string> {
  try {
    return await readFileFn(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label}: result file not found at "${path}" after agent completed`);
    }
    throw err;
  }
}

async function ensureResultDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

function parseArtifactCreateResult(content: string, path: string): ArtifactCreateResult {
  const obj = parseJsonObject(content, `Artifact creation: result file at "${path}"`);
  const artifactPath = typeof obj['artifact_path'] === 'string'
    ? obj['artifact_path']
    : typeof obj['spec_path'] === 'string'
      ? obj['spec_path']
      : undefined;
  if (!artifactPath) {
    throw new Error(`Artifact creation: result file missing "artifact_path" string`);
  }
  return {
    artifact_path: artifactPath,
    existing_issue: typeof obj['existing_issue'] === 'number' ? obj['existing_issue'] : undefined,
  };
}

function parseCommentResponses(content: string, path: string): ArtifactCommentResponse[] {
  const obj = parseJsonObject(content, `Artifact revision: result file at "${path}"`);
  const raw = obj['comment_responses'];
  if (!Array.isArray(raw)) {
    throw new Error(`Artifact revision: result file missing "comment_responses" array`);
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Artifact revision: comment_responses[${index}] is not an object`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry['comment_id'] !== 'string') {
      throw new Error(`Artifact revision: comment_responses[${index}] missing string "comment_id"`);
    }
    if (typeof entry['response'] !== 'string') {
      throw new Error(`Artifact revision: comment_responses[${index}] missing string "response"`);
    }
    return { comment_id: entry['comment_id'], response: entry['response'] };
  });
}

const STATUS_SYNONYMS: Record<string, ImplementationStatus> = {
  done: 'complete',
  finished: 'complete',
  success: 'complete',
  successful: 'complete',
  succeeded: 'complete',
  ok: 'complete',
  okay: 'complete',
  passed: 'complete',
  resolved: 'complete',
  accomplished: 'complete',
  completed: 'complete',
  error: 'failed',
  failure: 'failed',
  err: 'failed',
  crashed: 'failed',
  broken: 'failed',
  unsuccessful: 'failed',
  aborted: 'failed',
  terminated: 'failed',
  exception: 'failed',
  waiting: 'needs_input',
  pending: 'needs_input',
  blocked: 'needs_input',
  needs_information: 'needs_input',
  needs_clarification: 'needs_input',
  requires_input: 'needs_input',
  input_needed: 'needs_input',
  awaiting: 'needs_input',
  paused: 'needs_input',
  stalled: 'needs_input',
  incomplete: 'needs_input',
};

function parseImplementationResult(content: string, path: string): ImplementationResult {
  const obj = parseJsonObject(content, `Implementation: result file at "${path}"`);
  const rawStatus = obj['status'];
  const status = typeof rawStatus === 'string'
    ? (STATUS_SYNONYMS[rawStatus] ?? rawStatus)
    : rawStatus;
  if (status !== 'complete' && status !== 'needs_input' && status !== 'failed') {
    throw new Error(`Implementation: invalid STATUS value "${String(rawStatus)}" in result file`);
  }

  // Parse optional review_summary
  let review_summary: ImplementationResult['review_summary'];
  const rawReviewSummary = obj['review_summary'];
  if (rawReviewSummary !== undefined && rawReviewSummary !== null) {
    if (typeof rawReviewSummary !== 'object') {
      throw new Error(`Implementation: review_summary must be an object`);
    }
    const rs = rawReviewSummary as Record<string, unknown>;
    review_summary = {
      changes: Array.isArray(rs['changes']) ? (rs['changes'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
      confirm: Array.isArray(rs['confirm']) ? (rs['confirm'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    };
  }

  // Parse optional testing_steps
  let testing_steps: string[] | undefined;
  const rawSteps = obj['testing_steps'];
  if (Array.isArray(rawSteps)) {
    testing_steps = (rawSteps as unknown[]).filter((s): s is string => typeof s === 'string');
  }

  // Parse optional resolved_feedback_items
  let resolved_feedback_items: Array<{ id: string; resolution_comment: string }> | undefined;
  const rawResolved = obj['resolved_feedback_items'];
  if (Array.isArray(rawResolved)) {
    resolved_feedback_items = (rawResolved as unknown[]).map((item, index) => {
      if (typeof item !== 'object' || item === null) {
        throw new Error(`Implementation: resolved_feedback_items[${index}] is not an object`);
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry['id'] !== 'string') {
        throw new Error(`Implementation: resolved_feedback_items[${index}] missing string "id"`);
      }
      if (typeof entry['resolution_comment'] !== 'string') {
        throw new Error(`Implementation: resolved_feedback_items[${index}] missing string "resolution_comment"`);
      }
      return { id: entry['id'], resolution_comment: entry['resolution_comment'] };
    });
  }

  // Parse optional review_responses
  let review_responses: ImplementationResult['review_responses'];
  const rawReviewResponses = obj['review_responses'];
  if (Array.isArray(rawReviewResponses)) {
    review_responses = (rawReviewResponses as unknown[]).flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const entry = item as Record<string, unknown>;
      if (typeof entry['id'] !== 'string' || typeof entry['disposition'] !== 'string' || typeof entry['response'] !== 'string') return [];
      return [{ id: entry['id'], disposition: entry['disposition'] as 'fixed' | 'declined' | 'needs_input', response: entry['response'] }];
    });
  }

  return {
    status,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : undefined,
    testing_instructions: typeof obj['testing_instructions'] === 'string' ? obj['testing_instructions'] : undefined,
    review_summary,
    testing_steps,
    resolved_feedback_items,
    review_responses,
    requires_human_retest: obj['requires_human_retest'] === true,
    question: typeof obj['question'] === 'string' ? obj['question'] : undefined,
    error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
  };
}

function parseQuestionAnswer(content: string): string {
  const obj = parseJsonObject(content, 'Question answering: result file');
  if (typeof obj['answer'] !== 'string') {
    throw new Error(`Question answering: result file missing "answer" string`);
  }
  return obj['answer'];
}

export async function readAndValidateIssueTriageResult(readFileFn: ReadFileFn, filePath: string): Promise<IssueTriageResult> {
  const content = await readRequiredFile(readFileFn, filePath, 'Issue filing');
  const obj = parseJsonObject(content, `Issue filing: enrichment result at "${filePath}"`);

  if (obj['status'] !== 'complete' && obj['status'] !== 'failed') {
    throw new Error(`Issue filing: enrichment result at "${filePath}" has invalid status: "${String(obj['status'])}"`);
  }
  if (!Array.isArray(obj['items'])) {
    throw new Error(`Issue filing: enrichment result at "${filePath}" missing "items" array`);
  }

  const items: IssueTriageItem[] = obj['items'].map((raw, index) => parseIssueTriageItem(raw, index));
  return {
    status: obj['status'],
    items,
    error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
  };
}

function parseIssueTriageItem(raw: unknown, index: number): IssueTriageItem {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Issue filing: enrichment result items[${index}] is not an object`);
  }
  const item = raw as Record<string, unknown>;

  if (item['duplicate_of'] !== null && item['duplicate_of'] !== undefined) {
    const dup = item['duplicate_of'];
    if (
      typeof dup !== 'object'
      || dup === null
      || typeof (dup as Record<string, unknown>)['number'] !== 'number'
      || typeof (dup as Record<string, unknown>)['title'] !== 'string'
    ) {
      throw new Error(`Issue filing: enrichment result items[${index}].duplicate_of must be null or { number: number, title: string }`);
    }
    return {
      proposed_title: '',
      proposed_body: '',
      proposed_labels: [],
      duplicate_of: {
        number: (dup as Record<string, unknown>)['number'] as number,
        title: (dup as Record<string, unknown>)['title'] as string,
      },
    };
  }

  if (typeof item['proposed_title'] !== 'string' || !item['proposed_title']) {
    throw new Error(`Issue filing: enrichment result items[${index}].proposed_title must be a non-empty string when duplicate_of is null`);
  }
  if (typeof item['proposed_body'] !== 'string' || !item['proposed_body']) {
    throw new Error(`Issue filing: enrichment result items[${index}].proposed_body must be a non-empty string when duplicate_of is null`);
  }
  if (!Array.isArray(item['proposed_labels'])) {
    throw new Error(`Issue filing: enrichment result items[${index}].proposed_labels must be an array when duplicate_of is null`);
  }

  return {
    proposed_title: item['proposed_title'],
    proposed_body: item['proposed_body'],
    proposed_labels: item['proposed_labels'] as string[],
    duplicate_of: null,
  };
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${String(err)}`);
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error(`${label} is not a JSON object`);
  }
  return data as Record<string, unknown>;
}

export function buildIssueFilingSummary(filedIssues: FiledIssue[]): string {
  const newIssues = filedIssues.filter(i => i.action === 'filed');
  const duplicates = filedIssues.filter(i => i.action === 'duplicate');
  const parts: string[] = [];

  if (newIssues.length > 0) {
    const list = newIssues.map(i => `#${i.number} ${i.title}`).join(', ');
    parts.push(`Filed ${newIssues.length} new issue${newIssues.length === 1 ? '' : 's'}: ${list}`);
  }

  if (duplicates.length > 0) {
    const list = duplicates.map(i => `#${i.number} ${i.title}`).join(', ');
    parts.push(`Found ${duplicates.length} existing issue${duplicates.length === 1 ? '' : 's'}: ${list}`);
  }

  return parts.length > 0 ? parts.join(' - ') : 'No issues filed (empty list).';
}

const CHECKPOINT_INSTRUCTIONS = `At any point during your work, if you have something worth reporting to the human watching -
a phase transition, your current focus, something interesting you found, or a meaningful
milestone - emit it on its own line using this exact format:

[Relay] <your message here>

The goal is to keep a human informed at intervals they'd find interesting. You decide what's
worth reporting and when.`;

const BRANCH_OWNERSHIP_POLICY = `\
Autocatalyst owns git branch and PR management for this run.
The workspace is already checked out on the correct run branch.
Do not create branches, switch branches, or create worktrees.
Do not push, merge, or open PRs — Autocatalyst handles those steps.
If a skill includes branch setup, worktree creation, push, merge, or PR steps, skip those parts and follow the rest of the skill normally.
All files and commits must stay on the current branch.`;

const MM_PLANNING_BRANCH_OVERRIDE = `\
When using mm:planning, treat its Branch setup section as already complete.
Do not run git checkout -b feat/..., enhancement/..., or fix/....`;

function buildArtifactCreatePrompt(
  request: Request,
  artifactDir: string,
  createResultPath: string,
  intent: 'idea' | 'bug' | 'chore',
): string {
  if (intent === 'bug') {
    return [
      `You are producing a bug triage document for the following report:`,
      ``,
      request.content,
      ``,
      BRANCH_OWNERSHIP_POLICY,
      ``,
      `Use the \`mm:issue-triage\` skill to perform a thorough investigation of this bug.`,
      `Examine relevant source files, recent commits, and related issue-tracker records to understand the`,
      `root cause before forming conclusions. The investigation must be thorough - do not`,
      `skip the codebase inspection step.`,
      ``,
      `When the triage document is complete:`,
      `- Write the triage file to: ${artifactDir}`,
      `  Use "triage-bug-<slug>.md" as the filename.`,
      `- Write the result to: ${createResultPath}`,
      `  Content must be: { "artifact_path": "<absolute path to the triage file you wrote>", "existing_issue": <issue number if this work appears to be captured in an existing issue, otherwise omit the field> }`,
      ``,
      `Do not signal completion until both files have been written.`,
      ``,
      CHECKPOINT_INSTRUCTIONS,
    ].join('\n');
  }

  if (intent === 'chore') {
    return [
      `You are producing a chore plan for the following maintenance request:`,
      ``,
      request.content,
      ``,
      BRANCH_OWNERSHIP_POLICY,
      ``,
      `Use the \`mm:issue-triage\` skill to investigate the current state of the relevant`,
      `code and understand why this work is needed now. Use thorough investigation.`,
      ``,
      `When the chore plan is complete:`,
      `- Write the plan file to: ${artifactDir}`,
      `  Use "triage-chore-<slug>.md" as the filename.`,
      `- Write the result to: ${createResultPath}`,
      `  Content must be: { "artifact_path": "<absolute path to the plan file you wrote>", "existing_issue": <issue number if this work appears to be captured in an existing issue, otherwise omit the field> }`,
      ``,
      `Do not signal completion until both files have been written.`,
      ``,
      CHECKPOINT_INSTRUCTIONS,
    ].join('\n');
  }

  return [
    `Use the \`mm:planning\` skill to create a complete product spec for the following request.`,
    ``,
    BRANCH_OWNERSHIP_POLICY,
    ``,
    MM_PLANNING_BRANCH_OVERRIDE,
    ``,
    `Request:`,
    `<<<`,
    request.content,
    `>>>`,
    ``,
    `When the spec is complete:`,
    `- Write the spec file to: ${artifactDir}`,
    `  Use "feature-<slug>.md" for new standalone functionality, "enhancement-<slug>.md" for improvements.`,
    `- Write the result to: ${createResultPath}`,
    `  Content must be: { "artifact_path": "<absolute path to the spec file you wrote>" }`,
    ``,
    `Do not signal completion until both files have been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

function buildArtifactRevisePrompt(
  feedback: ThreadMessage,
  artifact_comments: ArtifactComment[],
  artifact_path: string,
  reviseResultPath: string,
  currentArtifact: string,
  anchorInstructions: string[],
): string {
  const commentSection = artifact_comments.length > 0
    ? [
        ``,
        `Published artifact comments:`,
        `<<<`,
        ...artifact_comments.map(c => `[COMMENT_ID: ${c.id}]\n${c.body}`),
        `>>>`,
      ].join('\n')
    : '';
  const commentResponsesShape = artifact_comments.length > 0
    ? `[{ "comment_id": "<id from [COMMENT_ID:] tag>", "response": "<1-2 sentences explaining how addressed>" }, ...]`
    : `[]`;
  const noCommentNote = artifact_comments.length === 0
    ? [``, `Use an empty array for comment_responses since there are no publisher comments.`]
    : [];
  const anchorInstructionLines = anchorInstructions.length > 0 ? [``, ...anchorInstructions] : [];

  return [
    `Revise the artifact below based on the following feedback.`,
    ``,
    BRANCH_OWNERSHIP_POLICY,
    ``,
    `Write the revised artifact to: ${artifact_path}`,
    `Write the result to: ${reviseResultPath}`,
    `Content must be:`,
    `{`,
    `  "comment_responses": ${commentResponsesShape}`,
    `}`,
    ...noCommentNote,
    `Do not signal completion until the result file has been written.`,
    ...anchorInstructionLines,
    ``,
    `Channel message:`,
    `<<<`,
    feedback.content,
    `>>>`,
    commentSection,
    ``,
    `Current artifact:`,
    `<<<`,
    currentArtifact,
    `>>>`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

function buildImplementationPrompt(artifact_path: string, result_file_path: string, additionalContext?: string): string {
  const lines: string[] = [];
  lines.push(BRANCH_OWNERSHIP_POLICY);
  lines.push('');
  const hasFeedbackContext = Boolean(additionalContext) && additionalContext!.includes('[FEEDBACK_ID:');

  if (additionalContext) {
    lines.push('The working directory already contains partial implementation from a previous attempt.');
    lines.push('Skip Step 1 (the plan exists) - go directly to Step 2.');
    lines.push('');
    if (hasFeedbackContext) {
      lines.push('Implementation feedback from the testing guide (address each item):');
    } else {
      lines.push('Additional context from the human:');
    }
    lines.push('<<<');
    lines.push(additionalContext);
    lines.push('>>>');
    lines.push('');
    if (hasFeedbackContext) {
      lines.push('For each [FEEDBACK_ID: ...] item you address, include it in resolved_feedback_items');
      lines.push('using the exact ID string as provided — do not modify or guess IDs.');
      lines.push('Only include an item in resolved_feedback_items when you actually fixed that specific issue.');
      lines.push('');
    }
  }

  lines.push(`Read the approved artifact at: ${artifact_path}`);
  lines.push('');

  if (!additionalContext) {
    lines.push('Step 1 - Create an implementation plan');
    lines.push('Use the `superpowers:writing-plans` skill.');
    lines.push('');
    lines.push('Use the artifact as the authoritative baseline, especially its task list.');
    lines.push('');
    lines.push('Step 2 - Execute the plan in subagent mode');
  } else {
    lines.push('Step 2 - Execute the plan in subagent mode');
  }

  lines.push('Use the `superpowers:subagent-driven-development` skill.');
  lines.push('');
  lines.push('Step 3 - Commit all remaining source changes');
  lines.push('Run `git status`. Stage and commit only source files that belong in the repository.');
  lines.push('Never use `git add --force` or `git add -f`.');
  lines.push('Never stage files under `.autocatalyst/` — that directory is gitignored and contains');
  lines.push('internal pipeline state, not repository artifacts.');
  lines.push('');
  lines.push(`Step 4 - Write the result to: ${result_file_path}`);
  lines.push('Create the directory if it does not exist. The JSON must have this structure:');
  lines.push('{');
  lines.push('  "status": "complete" | "needs_input" | "failed",');
  lines.push('  "summary": "short fallback summary",');
  lines.push('  "review_summary": {');
  lines.push('    "changes": ["2-5 bullets describing what changed (user-visible or reviewer-relevant)"],');
  lines.push('    "confirm": ["2-5 bullets describing what the human should verify"]');
  lines.push('  },');
  lines.push('  "testing_instructions": "legacy fallback — use testing_steps instead",');
  lines.push('  "testing_steps": ["cd /path/to/workspace", "npm install", "concrete step 3"],');
  lines.push('  "resolved_feedback_items": [');
  lines.push('    { "id": "<exact FEEDBACK_ID value>", "resolution_comment": "1-2 sentences: what changed" }');
  lines.push('  ],');
  lines.push('  "question": "only when needs_input",');
  lines.push('  "error": "only when failed"');
  lines.push('}');
  lines.push('');
  lines.push('Rules:');
  lines.push('- review_summary.changes and review_summary.confirm must each contain 2-5 bullets when status is "complete".');
  lines.push('- testing_steps must start with a `cd ` step when a workspace path is available.');
  lines.push('- resolved_feedback_items: include [] on initial implementation; on feedback runs, only include items you actually fixed.');
  lines.push('- Use IDs exactly as provided — do not modify or guess IDs.');
  lines.push('- Use only the exact canonical status values: "complete", "needs_input", or "failed".');
  lines.push('- Do not signal completion until the result file has been written.');
  lines.push('');
  lines.push(CHECKPOINT_INSTRUCTIONS);

  return lines.join('\n');
}

function buildQuestionPrompt(question: string, resultPath: string): string {
  return [
    `You are Autocatalyst, an AI-powered product engineering assistant.`,
    ``,
    `Answer the following question. You have access to shell tools - use them as needed.`,
    ``,
    `Question:`,
    question,
    ``,
    `When you have your answer, write it to: ${resultPath}`,
    `Content must be: { "answer": "<your answer as a single string>" }`,
    ``,
    `Keep the answer concise - it will be posted directly to the user.`,
    `Do not signal completion until the result file has been written.`,
  ].join('\n');
}

export function buildIssueTriagePrompt(request: Request, resultPath: string): string {
  return [
    `You are enriching a list of items to be filed in the issue tracker.`,
    ``,
    `Use the \`mm:issue-triage\` skill in feedback intake mode to:`,
    `1. Identify each distinct issue in the list below`,
    `2. Investigate each item against the codebase (thorough mode)`,
    `3. For each item:`,
    `   - If a duplicate issue already exists: record it with duplicate_of set to the existing issue's number and title; omit proposed_title/body/labels`,
    `   - If no duplicate exists: generate a rich title, descriptive body, and appropriate label suggestions; record it with duplicate_of: null`,
    ``,
    `Do NOT create issues. Record enrichment data only - issue creation will be handled separately.`,
    ``,
    `List of items:`,
    `>>>`,
    request.content,
    `>>>`,
    ``,
    `When enrichment is complete, write the result to: ${resultPath}`,
    `Content must be:`,
    `{`,
    `  "status": "complete" | "failed",`,
    `  "items": [`,
    `    {`,
    `      "proposed_title": "...",`,
    `      "proposed_body": "...",`,
    `      "proposed_labels": ["..."],`,
    `      "duplicate_of": null | { "number": N, "title": "..." }`,
    `    }`,
    `  ],`,
    `  "error": "..."`,
    `}`,
    ``,
    `Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function buildInitialReviewPrompt(
  artifact_path: string,
  working_directory: string,
  impl_result: ImplementationResult,
  diff_context: string,
  changed_files: string[],
): string {
  const reviewResultPath = join(working_directory, '.autocatalyst', 'impl-review-result.json');
  const summaryLines = [
    impl_result.summary ? `Summary: ${impl_result.summary}` : '',
    impl_result.review_summary?.changes?.length
      ? `Changes:\n${impl_result.review_summary.changes.map(c => `- ${c}`).join('\n')}`
      : '',
    impl_result.review_summary?.confirm?.length
      ? `Confirm:\n${impl_result.review_summary.confirm.map(c => `- ${c}`).join('\n')}`
      : '',
    impl_result.testing_instructions ? `Testing instructions: ${impl_result.testing_instructions}` : '',
  ].filter(Boolean);

  return [
    `You are an adversarial code reviewer. Your job is to inspect the implementation and find issues.`,
    `Do NOT edit any files. Read only.`,
    ``,
    `Approved artifact (spec): ${artifact_path}`,
    ``,
    `Implementation description from implementer:`,
    `<<<`,
    summaryLines.join('\n\n'),
    `>>>`,
    ``,
    `Changed files:`,
    ...changed_files.map(f => `- ${f}`),
    ``,
    `Git diff:`,
    `<<<`,
    diff_context || '(no diff available)',
    `>>>`,
    ``,
    `Review categories for initial review: correctness, test, security, maintainability, docs.`,
    `Focus on: correctness issues, missing test coverage, security problems, unmaintainable code, missing docs.`,
    ``,
    `Write your result to: ${reviewResultPath}`,
    `Content must be:`,
    `{`,
    `  "status": "no_findings" | "findings" | "failed",`,
    `  "summary": "1-2 sentence summary of review outcome",`,
    `  "findings": [`,
    `    {`,
    `      "id": "INIT-1",`,
    `      "severity": "blocker" | "warning" | "info",`,
    `      "category": "correctness" | "test" | "security" | "maintainability" | "docs",`,
    `      "finding": "concise description",`,
    `      "suggested_action": "optional action"`,
    `    }`,
    `  ],`,
    `  "requires_human_retest": false,`,
    `  "error": "only when status is failed"`,
    `}`,
    ``,
    `Rules:`,
    `- Do NOT include secrets, API keys, env values, or raw credential values in findings.`,
    `- Do NOT include your reasoning chain or full prompt in findings.`,
    `- Do NOT edit any files in the workspace.`,
    `- Use sequential IDs: INIT-1, INIT-2, etc.`,
    `- If no issues found, use status: "no_findings" with empty findings array.`,
    `- Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function buildFinalReviewPrompt(
  artifact_path: string,
  working_directory: string,
  impl_result: ImplementationResult,
  diff_context: string,
  changed_files: string[],
): string {
  const reviewResultPath = join(working_directory, '.autocatalyst', 'impl-review-result.json');
  const summaryLines = [
    impl_result.summary ? `Summary: ${impl_result.summary}` : '',
    impl_result.review_summary?.changes?.length
      ? `Changes:\n${impl_result.review_summary.changes.map(c => `- ${c}`).join('\n')}`
      : '',
  ].filter(Boolean);

  return [
    `You are an adversarial code reviewer performing a final pre-PR security and readiness check.`,
    `Do NOT edit any files. Read only.`,
    ``,
    `Approved artifact (spec): ${artifact_path}`,
    ``,
    `Implementation description from implementer:`,
    `<<<`,
    summaryLines.join('\n\n'),
    `>>>`,
    ``,
    `Changed files:`,
    ...changed_files.map(f => `- ${f}`),
    ``,
    `Git diff:`,
    `<<<`,
    diff_context || '(no diff available)',
    `>>>`,
    ``,
    `FOCUS for final review: security and pr_readiness.`,
    `Only include correctness, maintainability, test, or docs findings if the issue is newly discovered`,
    `and serious enough to block or delay the PR.`,
    ``,
    `Write your result to: ${reviewResultPath}`,
    `Content must be:`,
    `{`,
    `  "status": "no_findings" | "findings" | "failed",`,
    `  "summary": "1-2 sentence summary",`,
    `  "findings": [`,
    `    {`,
    `      "id": "FINAL-1",`,
    `      "severity": "blocker" | "warning" | "info",`,
    `      "category": "security" | "pr_readiness" | "correctness" | "test" | "maintainability" | "docs",`,
    `      "finding": "concise description",`,
    `      "suggested_action": "optional action"`,
    `    }`,
    `  ],`,
    `  "requires_human_retest": false,`,
    `  "error": "only when status is failed"`,
    `}`,
    ``,
    `Rules:`,
    `- Do NOT include secrets, API keys, env values, or raw credential values.`,
    `- Do NOT edit any files.`,
    `- Use sequential IDs: FINAL-1, FINAL-2, etc.`,
    `- Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function buildImplementerResponsePrompt(
  artifact_path: string,
  working_directory: string,
  impl_result: ImplementationResult,
  findings: ImplementationReviewFinding[],
): string {
  const resultFilePath = join(working_directory, '.autocatalyst', 'impl-result.json');

  const findingBlocks = findings.map(f => [
    `[REVIEW_ID: ${f.id}]`,
    `Severity: ${f.severity}`,
    `Category: ${f.category}`,
    `Finding: ${f.finding}`,
    ...(f.suggested_action ? [`Suggested action: ${f.suggested_action}`] : []),
  ].join('\n'));

  return [
    `Review findings require your response.`,
    ``,
    BRANCH_OWNERSHIP_POLICY,
    ``,
    `Read the approved artifact at: ${artifact_path}`,
    ``,
    `Previous implementation summary: ${impl_result.summary ?? '(none)'}`,
    ``,
    `Review findings:`,
    ``,
    findingBlocks.join('\n\n'),
    ``,
    `For each [REVIEW_ID: ...] finding, either fix it or decline it with a concrete reason.`,
    ``,
    `Step 1 - Respond to each finding.`,
    `For blockers: fix the issue in code/tests/docs, or escalate to needs_input with a specific question.`,
    `For warnings/info: fix, or decline with a concrete reason (not "no action needed").`,
    ``,
    `Step 2 - Commit any changes.`,
    ``,
    `Step 3 - Write the result to: ${resultFilePath}`,
    `Content must be:`,
    `{`,
    `  "status": "complete" | "needs_input" | "failed",`,
    `  "summary": "updated summary",`,
    `  "review_summary": { "changes": [...], "confirm": [...] },`,
    `  "testing_steps": [...],`,
    `  "resolved_feedback_items": [],`,
    `  "review_responses": [`,
    `    {`,
    `      "id": "<exact REVIEW_ID value>",`,
    `      "disposition": "fixed" | "declined" | "needs_input",`,
    `      "response": "what changed or concrete reason for decline"`,
    `    }`,
    `  ],`,
    `  "requires_human_retest": false`,
    `}`,
    ``,
    `Rules:`,
    `- Include one review_responses entry per [REVIEW_ID:] finding.`,
    `- "declined" responses must include a concrete reason, not just "no action needed".`,
    `- "fixed" responses should mention changed files or behavior.`,
    `- Use exact ID strings — do not modify or guess IDs.`,
    `- requires_human_retest: set true only if you changed user-visible behavior or testing steps.`,
    `- Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

export function parseImplementationReviewResult(content: string, path: string): ImplementationReviewResult {
  let obj: Record<string, unknown>;
  try {
    const data = JSON.parse(content);
    if (typeof data !== 'object' || data === null) {
      return { status: 'failed', summary: '', findings: [], error: `Review result at "${path}" is not a JSON object` };
    }
    obj = data as Record<string, unknown>;
  } catch (err) {
    return { status: 'failed', summary: '', findings: [], error: `Review result at "${path}" is not valid JSON: ${String(err)}` };
  }

  const rawStatus = obj['status'];
  if (rawStatus !== 'no_findings' && rawStatus !== 'findings' && rawStatus !== 'failed') {
    return { status: 'failed', summary: '', findings: [], error: `Review result at "${path}" has invalid status: "${String(rawStatus)}"` };
  }

  const findings: ImplementationReviewFinding[] = [];
  if (Array.isArray(obj['findings'])) {
    for (const raw of obj['findings'] as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const f = raw as Record<string, unknown>;
      if (typeof f['id'] === 'string' && typeof f['severity'] === 'string' && typeof f['category'] === 'string' && typeof f['finding'] === 'string') {
        findings.push({
          id: f['id'],
          severity: f['severity'] as ImplementationReviewFinding['severity'],
          category: f['category'] as ImplementationReviewFinding['category'],
          finding: f['finding'],
          ...(typeof f['suggested_action'] === 'string' ? { suggested_action: f['suggested_action'] } : {}),
        });
      }
    }
  }

  return {
    status: rawStatus,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    findings,
    requires_human_retest: obj['requires_human_retest'] === true,
    ...(typeof obj['error'] === 'string' ? { error: obj['error'] } : {}),
  };
}
