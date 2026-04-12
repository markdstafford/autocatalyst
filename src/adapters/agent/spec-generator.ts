// src/adapters/agent/spec-generator.ts
import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { Idea, SpecFeedback } from '../../types/events.js';
import { stripCommentSpans, extractCommentSpans, ensureSpansPreserved } from '../notion/markdown-diff.js';

export interface NotionComment {
  id: string;   // discussion ID — used to post the reply
  body: string; // full thread text: all comments in the discussion concatenated, separated by "\n"
}

export interface NotionCommentResponse {
  comment_id: string; // matches NotionComment.id
  response: string;
}

const defaultExecFile = promisify(_execFile);

type ExecFn = (file: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

const FILENAME_REGEX = /^(feature|enhancement)-[a-z0-9-]+\.md$/;

export interface ReviseResult {
  comment_responses: NotionCommentResponse[];
  page_content?: string;  // span-bearing markdown for publisher; undefined if no spans in input
}

export interface SpecGenerator {
  create(idea: Idea, workspace_path: string): Promise<string>;
  revise(
    feedback: SpecFeedback,
    notion_comments: NotionComment[],
    spec_path: string,
    workspace_path: string,
    current_page_markdown?: string,
  ): Promise<ReviseResult>;
}

interface SpecGeneratorOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

// Extract the content of the ## Raw output code fence, handling nested fences via depth tracking.
function extractRawOutput(artifactContent: string, context: string): string {
  const match = artifactContent.match(/^## Raw output\s*\n```(?:\w+)?\n/m);
  if (!match) throw new Error(`${context}: artifact missing ## Raw output section`);

  const lines = artifactContent.slice(match.index! + match[0].length).split('\n');
  let depth = 1;
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (line === '```') {
        depth--;
        if (depth === 0) break;
        result.push(line);
      } else {
        depth++;
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
}

// If text begins with a code fence (```lang), extract the content inside it.
function unwrapFence(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex(l => l.trim() !== '');
  if (first === -1 || !lines[first].startsWith('```')) return text;

  let depth = 1;
  const result: string[] = [];
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (line === '```') {
        depth--;
        if (depth === 0) break;
        result.push(line);
      } else {
        depth++;
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  return result.join('\n');
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

function parseArtifact(artifactContent: string): { filename: string; body: string } {
  const rawOutput = extractRawOutput(artifactContent, 'Spec creation');

  // Find the FILENAME: line anywhere in the raw output (Claude may emit preamble before it)
  const lines = rawOutput.split('\n');
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

  // Claude may wrap the spec body in a ```markdown fence — unwrap it if present
  const rawBody = lines.slice(filenameIdx + 1).join('\n').trimStart();
  const body = unwrapFence(rawBody).trimStart();
  return { filename, body };
}

export class OMCSpecGenerator implements SpecGenerator {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(options?: SpecGeneratorOptions) {
    this.execFn = options?.execFn ?? defaultExecFile;
    this.logger = createLogger('spec-generator', { destination: options?.logDestination });
  }

  async create(idea: Idea, workspace_path: string): Promise<string> {
    const prompt = [
      `Using mm:planning conventions, generate a complete product spec for the following idea.`,
      ``,
      `On the very first line of your response, write: FILENAME: <feature-or-enhancement-slug>.md`,
      `Then write the spec as a Markdown document with YAML frontmatter.`,
      ``,
      `Idea:`,
      `<<<`,
      idea.content,
      `>>>`,
    ].join('\n');

    this.logger.debug({ event: 'omc.invoked', idea_id: idea.id }, 'Invoking OMC for spec creation');

    let artifactPath: string;
    try {
      const { stdout } = await this.execFn('omc', ['ask', 'claude', '--print', prompt], { cwd: workspace_path });
      artifactPath = stdout.trim();
    } catch (err) {
      this.logger.error({ event: 'omc.failed', idea_id: idea.id, error: String(err) }, 'OMC exited non-zero');
      throw new Error(`OMC failed: ${String(err)}`);
    }

    this.logger.debug({ event: 'omc.completed', idea_id: idea.id, artifactPath }, 'OMC completed');

    if (!artifactPath) {
      throw new Error(`OMC returned empty artifact path for idea ${idea.id}`);
    }

    let artifactContent: string;
    try {
      artifactContent = readFileSync(artifactPath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read artifact at "${artifactPath}": ${String(err)}`, { cause: err });
    }
    const { filename, body } = parseArtifact(artifactContent);

    const specDir = join(workspace_path, 'context-human', 'specs');
    mkdirSync(specDir, { recursive: true });
    const spec_path = join(specDir, filename);
    writeFileSync(spec_path, body, 'utf-8');

    this.logger.info({ event: 'spec.generated', idea_id: idea.id, spec_path }, 'Spec generated');
    return spec_path;
  }

  async revise(
    feedback: SpecFeedback,
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

    this.logger.debug({ event: 'spec_revision.input', idea_id: feedback.idea_id, notion_comment_count: notion_comments.length, comment_ids: notion_comments.map(c => c.id) }, 'Revise called with Notion comments');
    this.logger.debug({ event: 'omc.invoked', idea_id: feedback.idea_id }, 'Invoking OMC for spec revision');

    let artifactPath: string;
    try {
      const { stdout } = await this.execFn('omc', ['ask', 'claude', '--print', prompt], { cwd: workspace_path });
      artifactPath = stdout.trim();
    } catch (err) {
      this.logger.error({ event: 'omc.failed', idea_id: feedback.idea_id, error: String(err) }, 'OMC exited non-zero during revision');
      throw new Error(`OMC revision failed: ${String(err)}`);
    }

    this.logger.debug({ event: 'omc.completed', idea_id: feedback.idea_id, artifactPath }, 'OMC revision completed');

    if (!artifactPath) {
      throw new Error(`OMC returned empty artifact path for idea ${feedback.idea_id}`);
    }

    let artifactContent: string;
    try {
      artifactContent = readFileSync(artifactPath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read artifact at "${artifactPath}": ${String(err)}`, { cause: err });
    }

    this.logger.debug({ event: 'omc.artifact_content', idea_id: feedback.idea_id, artifactContent }, 'Raw OMC artifact for revision');
    const rawOutput = extractRawOutput(artifactContent, 'Spec revision');
    const unwrapped = unwrapFence(rawOutput.trim());

    // Extract spec from SPEC: <<< ... >>> section
    const spec = extractDelimitedSection(unwrapped, 'SPEC:', 'Spec revision');
    if (!spec) {
      throw new Error(`Spec revision: response missing non-empty SPEC section`);
    }

    // Extract and parse comment_responses from COMMENT_RESPONSES: <<< ... >>> section
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

    this.logger.debug({ event: 'spec_revision.output', idea_id: feedback.idea_id, comment_response_count: commentResponses.length, comment_response_ids: commentResponses.map(r => r.comment_id) }, 'Parsed comment responses from revision');

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
