// src/adapters/agent/spec-generator.ts
import { promisify } from 'node:util';
import { exec as _exec } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { Idea, SpecFeedback } from '../../types/events.js';

const defaultExec = promisify(_exec);

type ExecFn = (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

const FILENAME_REGEX = /^(feature|enhancement)-[a-z0-9-]+\.md$/;

export interface SpecGenerator {
  create(idea: Idea, workspace_path: string): Promise<string>;
  revise(feedback: SpecFeedback, spec_path: string, workspace_path: string): Promise<void>;
}

interface SpecGeneratorOptions {
  execFn?: ExecFn;
  logDestination?: pino.DestinationStream;
}

function parseArtifact(artifactContent: string): { filename: string; body: string } {
  // Find the ## Raw output section
  const rawOutputMatch = artifactContent.match(/^## Raw output\s*\n```(?:\w+)?\n([\s\S]*?)```/m);
  if (!rawOutputMatch) {
    throw new Error('Artifact missing ## Raw output section');
  }
  const rawOutput = rawOutputMatch[1];

  // First line must be FILENAME: <name>
  const lines = rawOutput.split('\n');
  const firstLine = lines[0].trim();
  if (!firstLine.startsWith('FILENAME:')) {
    throw new Error(`Artifact ## Raw output must begin with "FILENAME: <name>", got: "${firstLine}"`);
  }

  const filename = firstLine.replace(/^FILENAME:\s*/, '').trim();
  if (!FILENAME_REGEX.test(filename)) {
    throw new Error(
      `Invalid spec filename "${filename}". Must match ${FILENAME_REGEX} (e.g. feature-my-feature.md or enhancement-my-enhancement.md)`
    );
  }

  const body = lines.slice(1).join('\n').trimStart();
  return { filename, body };
}

export class OMCSpecGenerator implements SpecGenerator {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(options?: SpecGeneratorOptions) {
    this.execFn = options?.execFn ?? defaultExec;
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
      const { stdout } = await this.execFn(`omc ask claude --print "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, { cwd: workspace_path });
      artifactPath = stdout.trim();
    } catch (err) {
      this.logger.error({ event: 'omc.failed', idea_id: idea.id, error: String(err) }, 'OMC exited non-zero');
      throw new Error(`OMC failed: ${String(err)}`);
    }

    this.logger.debug({ event: 'omc.completed', idea_id: idea.id, artifactPath }, 'OMC completed');

    const artifactContent = readFileSync(artifactPath, 'utf-8');
    const { filename, body } = parseArtifact(artifactContent);

    const specDir = join(workspace_path, 'context-human', 'specs');
    mkdirSync(specDir, { recursive: true });
    const spec_path = join(specDir, filename);
    writeFileSync(spec_path, body, 'utf-8');

    this.logger.info({ event: 'spec.generated', idea_id: idea.id, spec_path }, 'Spec generated');
    return spec_path;
  }

  async revise(feedback: SpecFeedback, spec_path: string, workspace_path: string): Promise<void> {
    const currentSpec = readFileSync(spec_path, 'utf-8');

    const prompt = [
      `Revise the spec below based on the feedback. Return the complete revised spec as a Markdown document.`,
      ``,
      `Feedback:`,
      `<<<`,
      feedback.content,
      `>>>`,
      ``,
      `Current spec:`,
      `<<<`,
      currentSpec,
      `>>>`,
    ].join('\n');

    this.logger.debug({ event: 'omc.invoked', idea_id: feedback.idea_id }, 'Invoking OMC for spec revision');

    let artifactPath: string;
    try {
      const { stdout } = await this.execFn(`omc ask claude --print "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`, { cwd: workspace_path });
      artifactPath = stdout.trim();
    } catch (err) {
      this.logger.error({ event: 'omc.failed', idea_id: feedback.idea_id, error: String(err) }, 'OMC exited non-zero during revision');
      throw new Error(`OMC revision failed: ${String(err)}`);
    }

    this.logger.debug({ event: 'omc.completed', idea_id: feedback.idea_id, artifactPath }, 'OMC revision completed');

    const artifactContent = readFileSync(artifactPath, 'utf-8');
    // For revision, OMC returns the full revised spec in ## Raw output (no FILENAME line required,
    // but if present we strip it). Write the body back to the same spec_path.
    const rawOutputMatch = artifactContent.match(/^## Raw output\s*\n```(?:\w+)?\n([\s\S]*?)```/m);
    if (!rawOutputMatch) throw new Error('Revision artifact missing ## Raw output section');

    let revisedBody = rawOutputMatch[1];
    // Strip leading FILENAME: line if present (revision may omit it)
    if (revisedBody.trimStart().startsWith('FILENAME:')) {
      revisedBody = revisedBody.split('\n').slice(1).join('\n').trimStart();
    }

    writeFileSync(spec_path, revisedBody, 'utf-8');
    this.logger.info({ event: 'spec.revised', idea_id: feedback.idea_id, spec_path }, 'Spec revised');
  }
}
