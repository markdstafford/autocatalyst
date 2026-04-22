// src/adapters/agent/implementer.ts
import { query as _query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFile as _readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages';

type QueryFn = typeof _query;

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
    onProgress?: (message: string) => Promise<void>,
  ): Promise<ImplementationResult>;
}

interface AgentSDKImplementerOptions {
  logDestination?: pino.DestinationStream;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  queryFn?: QueryFn;
}

const STATUS_SYNONYMS: Record<string, ImplementationStatus> = {
  // → 'complete'
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

  // → 'failed'
  error: 'failed',
  failure: 'failed',
  err: 'failed',
  crashed: 'failed',
  broken: 'failed',
  unsuccessful: 'failed',
  aborted: 'failed',
  terminated: 'failed',
  exception: 'failed',

  // → 'needs_input'
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

function parseResultFile(content: string, path: string): ImplementationResult {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Implementation: result file at "${path}" is not valid JSON: ${String(err)}`);
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error(`Implementation: result file at "${path}" is not a JSON object`);
  }

  const obj = data as Record<string, unknown>;
  const rawStatus = obj['status'];
  const status = typeof rawStatus === 'string'
    ? (STATUS_SYNONYMS[rawStatus] ?? rawStatus)
    : rawStatus;
  if (status !== 'complete' && status !== 'needs_input' && status !== 'failed') {
    throw new Error(`Implementation: invalid STATUS value "${String(rawStatus)}" in result file`);
  }

  return {
    status: status as ImplementationStatus,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : undefined,
    testing_instructions: typeof obj['testing_instructions'] === 'string' ? obj['testing_instructions'] : undefined,
    question: typeof obj['question'] === 'string' ? obj['question'] : undefined,
    error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
  };
}

export class AgentSDKImplementer implements Implementer {
  private readonly queryFn: QueryFn;
  private readonly logger: pino.Logger;
  private readonly readFileFn: (path: string, encoding: 'utf-8') => Promise<string>;

  constructor(options?: AgentSDKImplementerOptions) {
    this.queryFn = options?.queryFn ?? _query;
    this.logger = createLogger('implementer', { destination: options?.logDestination });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async implement(spec_path: string, workspace_path: string, additional_context?: string, onProgress?: (message: string) => Promise<void>): Promise<ImplementationResult> {
    const resultFilePath = join(workspace_path, '.autocatalyst', 'impl-result.json');
    const hasAdditionalContext = Boolean(additional_context);
    const prompt = buildPrompt(spec_path, resultFilePath, additional_context);

    this.logger.debug(
      { event: 'impl.agent_invoked', workspace_path, has_additional_context: hasAdditionalContext },
      'Invoking Agent SDK for implementation',
    );

    try {
      for await (const message of this.queryFn({
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
        if (onProgress && (message as SDKMessage).type === 'assistant') {
          const assistantMsg = message as Extract<SDKMessage, { type: 'assistant' }>;
          const relayMessage = parseRelayMessage(assistantMsg.message.content);
          if (relayMessage) {
            onProgress(relayMessage)
              .then(() => {
                this.logger.info(
                  { event: 'progress_update', phase: 'implementation', message: relayMessage },
                  'Progress update posted',
                );
              })
              .catch(err => {
                this.logger.warn(
                  { event: 'progress_failed', phase: 'implementation', error: String(err) },
                  'Failed to post progress update',
                );
              });
          }
        }
      }
    } catch (err) {
      this.logger.error(
        { event: 'impl.agent_failed', error: String(err) },
        'Agent SDK exited with error during implementation',
      );
      throw new Error(`Agent SDK implementation failed: ${String(err)}`);
    }

    let content: string;
    try {
      content = await this.readFileFn(resultFilePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Implementation: result file not found at "${resultFilePath}" after agent completed`);
      }
      throw err;
    }

    const result = parseResultFile(content, resultFilePath);
    this.logger.debug({ event: 'impl.agent_completed', status: result.status }, 'Agent SDK implementation completed');
    return result;
  }
}

const CHECKPOINT_INSTRUCTIONS = `At any point during your work, if you have something worth reporting to the human watching —
a phase transition, your current focus, something interesting you found, or a meaningful
milestone — emit it on its own line using this exact format:

[Relay] <your message here>

Examples of good checkpoints:
- [Relay] Planning started — analyzing spec and requirements
- [Relay] Planning complete — 7 tasks identified
- [Relay] Task 3 of 7: Implementing the parseRelayMessage helper
- [Relay] Found a potential issue with the existing auth middleware — investigating
- [Relay] Starting final code review

The goal is to keep a human informed at intervals they'd find interesting. You decide what's
worth reporting and when.`;

function parseRelayMessage(content: BetaMessage['content']): string | null {
  for (const block of content) {
    if (block.type === 'text') {
      for (const line of block.text.split('\n')) {
        const match = line.match(/^\[Relay\]\s+(.+)$/);
        if (match) return match[1].trim();
      }
    }
  }
  return null;
}

function buildPrompt(spec_path: string, result_file_path: string, additionalContext?: string): string {
  const lines: string[] = [];

  if (additionalContext) {
    lines.push('The workspace already contains partial implementation from a previous attempt.');
    lines.push('Skip Step 1 (the plan exists) — go directly to Step 2.');
    lines.push('');
    lines.push('Additional context from the human:');
    lines.push('<<<');
    lines.push(additionalContext);
    lines.push('>>>');
    lines.push('');
  }

  lines.push(`Read the feature spec at: ${spec_path}`);
  lines.push('');

  if (!additionalContext) {
    lines.push('Step 1 — Create an implementation plan');
    lines.push('/superpowers:writing-plans');
    lines.push('');
    lines.push('Use the spec as the authoritative baseline, especially its task list. The plan must include:');
    lines.push('- As each task completes, check it off in the spec file (- [ ] → - [x])');
    lines.push('- When all tasks in a story complete, check off the story');
    lines.push('- After all tasks complete, run the test suite');
    lines.push('');
    lines.push('Step 2 — Execute the plan in subagent mode');
  } else {
    lines.push('Step 2 — Execute the plan in subagent mode');
  }

  lines.push('/superpowers:subagent-driven-development');
  lines.push('');
  lines.push('Step 3 — Commit all remaining changes');
  lines.push('Run `git status` and commit anything uncommitted before proceeding.');
  lines.push('');
  lines.push(`Step 4 — Write the result to: ${result_file_path}`);
  lines.push('Create the directory if it does not exist. The JSON must have this structure:');
  lines.push('{');
  lines.push('  "status": "complete" | "needs_input" | "failed",');
  lines.push('  "summary": "what was built",');
  lines.push('  "testing_instructions": "Branch: <branch-name>\\nSetup: <install/build commands>\\nTest: <specific steps to exercise the feature>",');
  lines.push('  "question": "the decision needed from the human (only when needs_input)",');
  lines.push('  "error": "what went wrong (only when failed)"');
  lines.push('}');
  lines.push('');
  lines.push('Use status "needs_input" for important design decisions that are ambiguous in the spec');
  lines.push('and where a wrong choice would require significant rework.');
  lines.push('Do not signal completion until the result file has been written.');

  lines.push('');
  lines.push(CHECKPOINT_INSTRUCTIONS);

  return lines.join('\n');
}

// Exported for testing only
export { parseRelayMessage };
