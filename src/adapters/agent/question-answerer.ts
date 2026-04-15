// src/adapters/agent/question-answerer.ts
import { query as _query } from '@anthropic-ai/claude-agent-sdk';
import { readFile as _readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';

type QueryFn = typeof _query;

export interface QuestionAnswerer {
  answer(question: string): Promise<string>;
}

interface AgentSDKQuestionAnswererOptions {
  queryFn?: QueryFn;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  logDestination?: pino.DestinationStream;
}

export class AgentSDKQuestionAnswerer implements QuestionAnswerer {
  private readonly queryFn: QueryFn;
  private readonly readFileFn: (path: string, encoding: 'utf-8') => Promise<string>;
  private readonly logger: pino.Logger;
  private readonly repo_path: string;

  constructor(repo_path: string, options?: AgentSDKQuestionAnswererOptions) {
    this.repo_path = repo_path;
    this.queryFn = options?.queryFn ?? _query;
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
    this.logger = createLogger('question-answerer', { destination: options?.logDestination });
  }

  async answer(question: string): Promise<string> {
    const resultPath = join(this.repo_path, '.autocatalyst', `question-${randomUUID()}.json`);
    const prompt = buildPrompt(question, resultPath);

    this.logger.debug({ event: 'question.answering', question_length: question.length }, 'Answering question via Agent SDK');

    try {
      for await (const _message of this.queryFn({
        prompt,
        options: {
          cwd: this.repo_path,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      })) {
        // drain iterator — agent writes result file on completion
      }
    } catch (err) {
      this.logger.error({ event: 'question.agent_failed', error: String(err) }, 'Agent SDK exited with error during question answering');
      throw new Error(`Agent SDK question answering failed: ${String(err)}`);
    }

    let content: string;
    try {
      content = await this.readFileFn(resultPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Question answering: result file not found at "${resultPath}" after agent completed`);
      }
      throw err;
    }

    // Clean up result file — best-effort
    unlink(resultPath).catch(() => {});

    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (err) {
      throw new Error(`Question answering: result file is not valid JSON: ${String(err)}`);
    }
    if (typeof data !== 'object' || data === null || typeof (data as Record<string, unknown>)['answer'] !== 'string') {
      throw new Error(`Question answering: result file missing "answer" string`);
    }

    const answer = (data as Record<string, unknown>)['answer'] as string;
    this.logger.info({ event: 'question.answered', response_length: answer.length }, 'Question answered');
    return answer;
  }
}

function buildPrompt(question: string, resultPath: string): string {
  return [
    `You are Autocatalyst, an AI-powered product engineering assistant integrated into Slack.`,
    ``,
    `Answer the following question. You have access to shell tools — use them as needed.`,
    `For example: \`gh issue list\`, \`gh pr list\`, \`git log\`, read files, etc.`,
    ``,
    `Question:`,
    question,
    ``,
    `When you have your answer, write it to: ${resultPath}`,
    `Content must be: { "answer": "<your answer as a single string>" }`,
    ``,
    `Keep the answer concise — it will be posted directly to Slack.`,
    `Do not signal completion until the result file has been written.`,
  ].join('\n');
}
