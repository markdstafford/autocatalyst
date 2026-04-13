import { promisify } from 'node:util';
import { execFile as _execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';

// Collect lines from an open code fence until the matching close (depth tracking)
function collectFenceContent(lines: string[], startIndex: number): string {
  let depth = 1;
  const result: string[] = [];
  for (let i = startIndex; i < lines.length; i++) {
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

function extractRawOutput(artifactContent: string, context: string): string {
  const match = artifactContent.match(/^## Raw output\s*\n```(?:\w+)?\n/m);
  if (!match) throw new Error(`${context}: artifact missing ## Raw output section`);
  const lines = artifactContent.slice(match.index! + match[0].length).split('\n');
  return collectFenceContent(lines, 0);
}

const defaultExecFile = promisify(_execFile);

type ExecFn = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

export type ImplementationStatus = 'complete' | 'needs_input' | 'failed';

export interface ImplementationResult {
  status: ImplementationStatus;
  summary?: string;
  testing_instructions?: string;
  question?: string;
  error?: string;
}

export interface Implementer {
  implement(
    spec_path: string,
    workspace_path: string,
    additional_context?: string,
  ): Promise<ImplementationResult>;
}

interface OMCImplementerOptions {
  logDestination?: pino.DestinationStream;
}

// Extract a delimited section: LABEL:\n<<<\n...\n>>>
function extractSection(text: string, label: string): string | null {
  const startMarker = `${label}\n<<<\n`;
  const start = text.indexOf(startMarker);
  if (start === -1) return null;
  const contentStart = start + startMarker.length;
  const end = text.indexOf('\n>>>', contentStart);
  if (end === -1) return null;
  return text.slice(contentStart, end);
}

function requireSection(text: string, label: string, context: string): string {
  const value = extractSection(text, label);
  if (value === null) throw new Error(`${context}: missing ${label} section`);
  if (!value.trim()) throw new Error(`${context}: ${label} section is empty`);
  return value;
}

export class OMCImplementer implements Implementer {
  private readonly execFn: ExecFn;
  private readonly logger: pino.Logger;

  constructor(execFn?: ExecFn, options?: OMCImplementerOptions) {
    this.execFn = execFn ?? defaultExecFile;
    this.logger = createLogger('implementer', { destination: options?.logDestination });
  }

  async implement(
    spec_path: string,
    workspace_path: string,
    additional_context?: string,
  ): Promise<ImplementationResult> {
    const specContent = readFileSync(spec_path, 'utf-8');
    const hasAdditionalContext = Boolean(additional_context);

    const prompt = buildPrompt(specContent, additional_context);

    this.logger.debug(
      { event: 'omc.team_invoked', workspace_path, has_additional_context: hasAdditionalContext },
      'Invoking OMC for implementation',
    );

    let artifactPath: string;
    try {
      const { stdout } = await this.execFn('omc', ['team', '1:claude', prompt], { cwd: workspace_path });
      artifactPath = stdout.trim();
    } catch (err) {
      this.logger.error(
        { event: 'omc.team_failed', error: String(err), stderr: (err as { stderr?: string }).stderr?.slice(0, 500) },
        'OMC exited non-zero during implementation',
      );
      throw new Error(`OMC implementation failed: ${String(err)}`);
    }

    if (!artifactPath) {
      throw new Error('OMC returned empty artifact path');
    }

    let artifactContent: string;
    try {
      artifactContent = readFileSync(artifactPath, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read artifact at "${artifactPath}": ${String(err)}`);
    }

    const rawOutput = extractRawOutput(artifactContent, 'Implementation');
    const result = parseResult(rawOutput.trim());

    this.logger.debug(
      { event: 'omc.team_completed', status: result.status },
      'OMC implementation completed',
    );

    return result;
  }
}

function buildPrompt(specContent: string, additionalContext?: string): string {
  const lines = [
    `You are implementing a feature according to the spec below.`,
    ``,
    `Implementation instructions:`,
    `- Use the task list in the spec as the implementation plan`,
    `- Execute tasks in dependency order`,
    `- Check off each task list item as you complete it (- [ ] → - [x])`,
    `- When all tasks in a story complete, check off the story`,
    `- After completing all tasks, run the test suite`,
    ``,
    `When done, respond using this exact structure:`,
    ``,
    `STATUS: complete | needs_input | failed`,
    ``,
    `SUMMARY:`,
    `<<<`,
    `[what was implemented]`,
    `>>>`,
    ``,
    `TESTING_INSTRUCTIONS:`,
    `<<<`,
    `[step-by-step instructions to test the implementation]`,
    `>>>`,
    ``,
    `QUESTION:`,
    `<<<`,
    `[only present when STATUS is needs_input — the question for the human]`,
    `>>>`,
    ``,
    `ERROR:`,
    `<<<`,
    `[only present when STATUS is failed — what went wrong]`,
    `>>>`,
  ];

  if (additionalContext) {
    lines.push('');
    lines.push('Additional context from the human:');
    lines.push('<<<');
    lines.push(additionalContext);
    lines.push('>>>');
  }

  lines.push('');
  lines.push('Spec:');
  lines.push('<<<');
  lines.push(specContent);
  lines.push('>>>');

  return lines.join('\n');
}

function parseResult(rawOutput: string): ImplementationResult {
  const statusMatch = rawOutput.match(/^STATUS:\s*(\S+)/m);
  if (!statusMatch) throw new Error('Implementation: missing STATUS line in OMC output');

  const status = statusMatch[1] as ImplementationStatus;
  if (status !== 'complete' && status !== 'needs_input' && status !== 'failed') {
    throw new Error(`Implementation: invalid STATUS value "${status}"`);
  }

  if (status === 'complete') {
    const summary = requireSection(rawOutput, 'SUMMARY:', 'Implementation');
    const testing_instructions = requireSection(rawOutput, 'TESTING_INSTRUCTIONS:', 'Implementation');
    return { status, summary, testing_instructions };
  }

  if (status === 'needs_input') {
    const question = requireSection(rawOutput, 'QUESTION:', 'Implementation');
    return { status, question };
  }

  // failed
  const error = requireSection(rawOutput, 'ERROR:', 'Implementation');
  return { status, error };
}
