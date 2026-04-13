// src/adapters/agent/spec-generator.ts
import { query as _query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const FILENAME_REGEX = /^(feature|enhancement)-[a-z0-9-]+\.md$/;

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
}

// If text begins with a code fence (```lang), extract the content inside it.
// Uses last-match strategy for the outer fence closer.
function unwrapFence(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex(l => l.trim() !== '');
  if (first === -1 || !lines[first].startsWith('```')) return text;
  for (let i = lines.length - 1; i > first; i--) {
    if (/^```[ \t]*$/.test(lines[i])) {
      return lines.slice(first + 1, i).join('\n');
    }
  }
  return lines.slice(first + 1).join('\n');
}

// Extract the content between "LABEL:\n<<<\n" and "\n>>>" delimiters.
function extractDelimitedSection(text: string, label: string, context: string): string {
  const startMarker = `${label}\n<<<\n`;
  const start = text.indexOf(startMarker);
  if (start === -1) throw new Error(`${context}: missing ${label} section`);
  const contentStart = start + startMarker.length;
  const end = text.indexOf('\n>>>', contentStart);
  if (end === -1) throw new Error(`${context}: ${label} section missing closing >>>`);
  return text.slice(contentStart, end);
}

function parseSpecResponse(responseText: string): { filename: string; body: string } {
  const lines = responseText.split('\n');
  const filenameIdx = lines.findIndex(l => l.trim().startsWith('FILENAME:'));
  if (filenameIdx === -1) {
    throw new Error(`Artifact ## Raw output missing "FILENAME: <name>" line`);
  }

  const filename = lines[filenameIdx].replace(/^FILENAME:\s*/, '').trim();
  if (!FILENAME_REGEX.test(filename)) {
    throw new Error(
      `Invalid spec filename "${filename}". Must match ${FILENAME_REGEX} (e.g. feature-my-feature.md or enhancement-my-enhancement.md)`
    );
  }

  const rawBody = lines.slice(filenameIdx + 1).join('\n').trimStart();
  const body = unwrapFence(rawBody).trimStart();
  return { filename, body };
}

async function runQuery(queryFn: QueryFn, prompt: string, workspace_path: string): Promise<string> {
  let resultText = '';
  try {
    // @ts-expect-error — SDK option types may not perfectly match all fields used at runtime
    for await (const message of queryFn({
      prompt,
      options: {
        cwd: workspace_path,
        allowedTools: [],
        maxTurns: 1,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    })) {
      const msg = message as { result?: string };
      if (typeof msg.result === 'string') {
        resultText = msg.result;
      }
    }
  } catch (err) {
    throw new Error(String(err));
  }
  if (!resultText) {
    throw new Error('Agent SDK returned no result text for spec generation');
  }
  return resultText;
}

export class AgentSDKSpecGenerator implements SpecGenerator {
  private readonly queryFn: QueryFn;
  private readonly logger: pino.Logger;

  constructor(options?: AgentSDKSpecGeneratorOptions) {
    this.queryFn = options?.queryFn ?? _query;
    this.logger = createLogger('spec-generator', { destination: options?.logDestination });
  }

  async create(idea: Idea, workspace_path: string): Promise<string> {
    const prompt = [
      `Using mm:planning conventions, generate a complete product spec for the following idea.`,
      ``,
      `On the very first line of your response, write: FILENAME: feature-<slug>.md`,
      `Use the "feature-" prefix for new standalone functionality, or "enhancement-" prefix for improvements to an existing feature.`,
      `Then write the spec as a Markdown document with YAML frontmatter.`,
      ``,
      `Idea:`,
      `<<<`,
      idea.content,
      `>>>`,
    ].join('\n');

    this.logger.debug({ event: 'spec.agent_invoked', idea_id: idea.id }, 'Invoking Agent SDK for spec creation');

    const resultText = await runQuery(this.queryFn, prompt, workspace_path);

    this.logger.debug({ event: 'spec.agent_completed', idea_id: idea.id }, 'Agent SDK spec creation completed');

    const { filename, body } = parseSpecResponse(resultText);

    const specDir = join(workspace_path, 'context-human', 'specs');
    mkdirSync(specDir, { recursive: true });
    const spec_path = join(specDir, filename);
    writeFileSync(spec_path, body, 'utf-8');

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
    const originalSpans = current_page_markdown ? extractCommentSpans(current_page_markdown) : [];
    const hasSpans = originalSpans.length > 0;
    const currentSpec = hasSpans ? current_page_markdown! : readFileSync(spec_path, 'utf-8');

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
      ? `[{ "comment_id": "<id from [COMMENT_ID:] tag>", "response": "<1-2 sentences explaining how this comment was addressed>" }, ...]`
      : `[]`;

    const shapeLines = [
      `Your response must use this structure exactly — no other text before or after it:`,
      ``,
      `SPEC:`,
      `<<<`,
      `[complete revised spec as a Markdown document — preserve YAML frontmatter]`,
      `>>>`,
      ``,
      `COMMENT_RESPONSES:`,
      `<<<`,
      commentResponsesShape,
      `>>>`,
      ...(notion_comments.length === 0 ? [``, `Use an empty array for COMMENT_RESPONSES since there are no Notion comments.`] : []),
    ];

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

    const prompt = [
      `Revise the spec below based on the following feedback.`,
      ``,
      ...shapeLines,
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

    this.logger.debug({ event: 'spec_revision.input', idea_id: feedback.idea_id, notion_comment_count: notion_comments.length }, 'Revise called with Notion comments');
    this.logger.debug({ event: 'spec.agent_invoked', idea_id: feedback.idea_id }, 'Invoking Agent SDK for spec revision');

    const resultText = await runQuery(this.queryFn, prompt, workspace_path);

    this.logger.debug({ event: 'spec.agent_completed', idea_id: feedback.idea_id }, 'Agent SDK spec revision completed');

    const unwrapped = unwrapFence(resultText.trim());

    const spec = extractDelimitedSection(unwrapped, 'SPEC:', 'Spec revision');
    if (!spec) {
      throw new Error(`Spec revision: response missing non-empty SPEC section`);
    }

    const commentResponsesRaw = extractDelimitedSection(unwrapped, 'COMMENT_RESPONSES:', 'Spec revision');
    let parsedResponses: unknown;
    try {
      parsedResponses = JSON.parse(commentResponsesRaw.trim() || '[]');
    } catch {
      throw new Error(`Spec revision: COMMENT_RESPONSES section is not valid JSON`);
    }
    if (!Array.isArray(parsedResponses)) {
      throw new Error(`Spec revision: COMMENT_RESPONSES is not a JSON array`);
    }

    const commentResponses: NotionCommentResponse[] = [];
    for (const item of parsedResponses as unknown[]) {
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
      commentResponses.push({ comment_id: entry['comment_id'], response: entry['response'] });
    }

    this.logger.debug({ event: 'spec_revision.output', idea_id: feedback.idea_id, comment_response_count: commentResponses.length }, 'Parsed comment responses from revision');

    if (hasSpans) {
      const pageContent = ensureSpansPreserved(spec, originalSpans);
      writeFileSync(spec_path, stripCommentSpans(pageContent), 'utf-8');
      this.logger.info({ event: 'spec.revised', idea_id: feedback.idea_id, spec_path, spans_preserved: true }, 'Spec revised with span passthrough');
      return { comment_responses: commentResponses, page_content: pageContent };
    }

    writeFileSync(spec_path, spec, 'utf-8');
    this.logger.info({ event: 'spec.revised', idea_id: feedback.idea_id, spec_path }, 'Spec revised');
    return { comment_responses: commentResponses };
  }
}
