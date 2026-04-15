// src/adapters/agent/spec-generator.ts
import { query as _query } from '@anthropic-ai/claude-agent-sdk';
import { readFile as _readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { Idea, ThreadMessage } from '../../types/events.js';
import { stripCommentSpans, extractCommentSpans, ensureSpansPreserved } from '../notion/markdown-diff.js';

export interface NotionComment {
  id: string;
  body: string;
}

export interface NotionCommentResponse {
  comment_id: string;
  response: string;
}

type QueryFn = typeof _query;

export interface ReviseResult {
  comment_responses: NotionCommentResponse[];
  page_content?: string;
}

export interface SpecGenerator {
  create(idea: Idea, workspace_path: string): Promise<string>;
  revise(
    feedback: ThreadMessage,
    notion_comments: NotionComment[],
    spec_path: string,
    workspace_path: string,
    current_page_markdown?: string,
  ): Promise<ReviseResult>;
}

interface AgentSDKSpecGeneratorOptions {
  queryFn?: QueryFn;
  logDestination?: pino.DestinationStream;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
}

function parseCommentResponses(content: string, path: string): NotionCommentResponse[] {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Spec revision: result file at "${path}" is not valid JSON: ${String(err)}`);
  }
  if (typeof data !== 'object' || data === null) {
    throw new Error(`Spec revision: result file at "${path}" is not a JSON object`);
  }
  const obj = data as Record<string, unknown>;
  const raw = obj['comment_responses'];
  if (!Array.isArray(raw)) {
    throw new Error(`Spec revision: result file missing "comment_responses" array`);
  }
  const responses: NotionCommentResponse[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Spec revision: comment_responses entry is not an object`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry['comment_id'] !== 'string') {
      throw new Error(`Spec revision: comment_responses entry missing string "comment_id"`);
    }
    if (typeof entry['response'] !== 'string') {
      throw new Error(`Spec revision: comment_responses entry missing string "response"`);
    }
    responses.push({ comment_id: entry['comment_id'], response: entry['response'] });
  }
  return responses;
}

export class AgentSDKSpecGenerator implements SpecGenerator {
  private readonly queryFn: QueryFn;
  private readonly logger: pino.Logger;
  private readonly readFileFn: (path: string, encoding: 'utf-8') => Promise<string>;

  constructor(options?: AgentSDKSpecGeneratorOptions) {
    this.queryFn = options?.queryFn ?? _query;
    this.logger = createLogger('spec-generator', { destination: options?.logDestination });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async create(idea: Idea, workspace_path: string): Promise<string> {
    const createResultPath = join(workspace_path, '.autocatalyst', 'spec-create-result.json');
    const specDir = join(workspace_path, 'context-human', 'specs');
    const prompt = buildCreatePrompt(idea, specDir, createResultPath);

    this.logger.debug({ event: 'spec.agent_invoked', idea_id: idea.id }, 'Invoking Agent SDK for spec creation');

    try {
      for await (const _message of this.queryFn({
        prompt,
        options: {
          cwd: workspace_path,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      })) {
        // drain iterator — agent writes spec and result file on completion
      }
    } catch (err) {
      this.logger.error(
        { event: 'spec.agent_failed', idea_id: idea.id, error: String(err) },
        'Agent SDK exited with error during spec creation',
      );
      throw new Error(`Agent SDK spec creation failed: ${String(err)}`);
    }

    let content: string;
    try {
      content = await this.readFileFn(createResultPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Spec creation: result file not found at "${createResultPath}" after agent completed`);
      }
      throw err;
    }

    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (err) {
      throw new Error(`Spec creation: result file at "${createResultPath}" is not valid JSON: ${String(err)}`);
    }
    if (typeof data !== 'object' || data === null) {
      throw new Error(`Spec creation: result file at "${createResultPath}" is not a JSON object`);
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj['spec_path'] !== 'string') {
      throw new Error(`Spec creation: result file missing "spec_path" string`);
    }
    const spec_path = obj['spec_path'];

    this.logger.debug({ event: 'spec.agent_completed', idea_id: idea.id }, 'Agent SDK spec creation completed');
    this.logger.info({ event: 'spec.generated', idea_id: idea.id, spec_path }, 'Spec generated');
    return spec_path;
  }

  async revise(
    feedback: ThreadMessage,
    notion_comments: NotionComment[],
    spec_path: string,
    workspace_path: string,
    current_page_markdown?: string,
  ): Promise<ReviseResult> {
    const reviseResultPath = join(workspace_path, '.autocatalyst', 'spec-revise-result.json');
    const originalSpans = current_page_markdown ? extractCommentSpans(current_page_markdown) : [];
    const hasSpans = originalSpans.length > 0;
    const currentSpec = hasSpans ? current_page_markdown! : readFileSync(spec_path, 'utf-8');

    const prompt = buildRevisePrompt(feedback, notion_comments, spec_path, reviseResultPath, currentSpec, hasSpans);

    this.logger.debug(
      { event: 'spec_revision.input', idea_id: feedback.idea_id, notion_comment_count: notion_comments.length },
      'Revise called with Notion comments',
    );
    this.logger.debug({ event: 'spec.agent_invoked', idea_id: feedback.idea_id }, 'Invoking Agent SDK for spec revision');

    try {
      for await (const _message of this.queryFn({
        prompt,
        options: {
          cwd: workspace_path,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      })) {
        // drain iterator — agent writes revised spec and result file on completion
      }
    } catch (err) {
      this.logger.error(
        { event: 'spec.agent_failed', idea_id: feedback.idea_id, error: String(err) },
        'Agent SDK exited with error during spec revision',
      );
      throw new Error(`Agent SDK spec revision failed: ${String(err)}`);
    }

    let content: string;
    try {
      content = await this.readFileFn(reviseResultPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Spec revision: result file not found at "${reviseResultPath}" after agent completed`);
      }
      throw err;
    }

    const commentResponses = parseCommentResponses(content, reviseResultPath);

    this.logger.debug({ event: 'spec.agent_completed', idea_id: feedback.idea_id }, 'Agent SDK spec revision completed');
    this.logger.debug(
      { event: 'spec_revision.output', idea_id: feedback.idea_id, comment_response_count: commentResponses.length },
      'Parsed comment responses from revision',
    );

    if (hasSpans) {
      const agentSpec = readFileSync(spec_path, 'utf-8');
      const pageContent = ensureSpansPreserved(agentSpec, originalSpans);
      writeFileSync(spec_path, stripCommentSpans(pageContent), 'utf-8');
      this.logger.info(
        { event: 'spec.revised', idea_id: feedback.idea_id, spec_path, spans_preserved: true },
        'Spec revised with span passthrough',
      );
      return { comment_responses: commentResponses, page_content: pageContent };
    }

    this.logger.info({ event: 'spec.revised', idea_id: feedback.idea_id, spec_path }, 'Spec revised');
    return { comment_responses: commentResponses };
  }
}

function buildCreatePrompt(idea: Idea, specDir: string, createResultPath: string): string {
  return [
    `Use the /mm:planning skill to create a complete product spec for the following idea.`,
    ``,
    `/mm:planning`,
    ``,
    `Idea:`,
    `<<<`,
    idea.content,
    `>>>`,
    ``,
    `When the spec is complete:`,
    `- Write the spec file to: ${specDir}`,
    `  Use "feature-<slug>.md" for new standalone functionality, "enhancement-<slug>.md" for improvements.`,
    `- Write the result to: ${createResultPath}`,
    `  Content must be: { "spec_path": "<absolute path to the spec file you wrote>" }`,
    ``,
    `Do not signal completion until both files have been written.`,
  ].join('\n');
}

function buildRevisePrompt(
  feedback: ThreadMessage,
  notion_comments: NotionComment[],
  spec_path: string,
  reviseResultPath: string,
  currentSpec: string,
  hasSpans: boolean,
): string {
  const notionSection = notion_comments.length > 0
    ? [
        ``,
        `Notion page comments:`,
        `<<<`,
        ...notion_comments.map(c => `[COMMENT_ID: ${c.id}]\n${c.body}`),
        `>>>`,
      ].join('\n')
    : '';

  const commentResponsesShape = notion_comments.length > 0
    ? `[{ "comment_id": "<id from [COMMENT_ID:] tag>", "response": "<1-2 sentences explaining how addressed>" }, ...]`
    : `[]`;

  const noCommentNote = notion_comments.length === 0
    ? [``, `Use an empty array for comment_responses since there are no Notion comments.`]
    : [];

  const spanInstructions = hasSpans
    ? [
        ``,
        `CRITICAL: The spec contains <span discussion-urls="..."> tags marking inline comment anchors.`,
        `Every span in the input MUST appear somewhere in your output. Follow these rules exactly:`,
        ``,
        `1. Span text unchanged — keep the span wrapping that same text.`,
        `2. Span text rewritten — move the span to wrap the closest equivalent text in your revision.`,
        `3. Span text removed entirely — add an "## Orphaned comments" section at the very end`,
        `   of the spec with one bullet per orphaned span:`,
        `   - <span discussion-urls="EXACT_UUID_HERE">exact original inner text</span>`,
        ``,
        `DO NOT drop any span. If you are uncertain where to place one, orphan it.`,
        `The "## Orphaned comments" section must be the last section in the document.`,
      ]
    : [];

  return [
    `Revise the spec below based on the following feedback.`,
    ``,
    `Write the revised spec to: ${spec_path}`,
    `Write the result to: ${reviseResultPath}`,
    `Content must be:`,
    `{`,
    `  "comment_responses": ${commentResponsesShape}`,
    `}`,
    ...noCommentNote,
    `Do not signal completion until the result file has been written.`,
    ...spanInstructions,
    ``,
    `Slack message:`,
    `<<<`,
    feedback.content,
    `>>>`,
    notionSection,
    ``,
    `Current spec:`,
    `<<<`,
    currentSpec,
    `>>>`,
  ].filter(line => line !== undefined).join('\n');
}
