// src/adapters/agent/spec-generator.ts
import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { Idea, SpecFeedback } from '../../types/events.js';

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

export interface SpecGenerator {
  create(idea: Idea, workspace_path: string): Promise<string>;
  revise(
    feedback: SpecFeedback,
    notion_comments: NotionComment[],
    spec_path: string,
    workspace_path: string,
  ): Promise<NotionCommentResponse[]>;
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
      `Then write the complete spec as a Markdown document with YAML frontmatter.`,
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
  ): Promise<NotionCommentResponse[]> {
    const currentSpec = readFileSync(spec_path, 'utf-8');

    const notionSection = notion_comments.length > 0
      ? [
          ``,
          `Notion page comments:`,
          `<<<`,
          ...notion_comments.map(c => `[COMMENT_ID: ${c.id}]\n${c.body}`),
          `>>>`,
        ].join('\n')
      : '';

    const shapeLines = notion_comments.length > 0
      ? [
          `Your response must match this shape exactly:`,
          `{`,
          `  "spec": "<complete revised spec as a Markdown string — preserve YAML frontmatter>",`,
          `  "comment_responses": [`,
          `    { "comment_id": "<id from [COMMENT_ID:] tag>", "response": "<1-2 sentences explaining how this comment was addressed>" }`,
          `  ]`,
          `}`,
        ]
      : [
          `Your response must match this shape exactly:`,
          `{`,
          `  "spec": "<complete revised spec as a Markdown string — preserve YAML frontmatter>",`,
          `  "comment_responses": []`,
          `}`,
          `Return "comment_responses": [] since there are no Notion comments.`,
        ];

    const prompt = [
      `Revise the spec below based on the following feedback. Respond with only a JSON object — no other text before or after it.`,
      ``,
      ...shapeLines,
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

    const rawOutput = extractRawOutput(artifactContent, 'Spec revision');

    // Parse JSON response
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawOutput.trim());
    } catch {
      throw new Error(`Spec revision: OMC response is not valid JSON`);
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Spec revision: OMC response is not a JSON object`);
    }
    const obj = parsed as Record<string, unknown>;

    if (typeof obj['spec'] !== 'string' || obj['spec'].length === 0) {
      throw new Error(`Spec revision: JSON response missing non-empty "spec" field`);
    }
    if (!Array.isArray(obj['comment_responses'])) {
      throw new Error(`Spec revision: JSON response missing "comment_responses" array`);
    }

    const commentResponses: NotionCommentResponse[] = [];
    for (const item of obj['comment_responses'] as unknown[]) {
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

    writeFileSync(spec_path, obj['spec'] as string, 'utf-8');
    this.logger.info({ event: 'spec.revised', idea_id: feedback.idea_id, spec_path }, 'Spec revised');

    return commentResponses;
  }
}
