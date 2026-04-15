// src/adapters/agent/question-answerer.ts
import { query as _query } from '@anthropic-ai/claude-agent-sdk';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';

type QueryFn = typeof _query;

export interface QuestionAnswerer {
  answer(question: string): Promise<string>;
}

interface AgentSDKQuestionAnswererOptions {
  queryFn?: QueryFn;
  logDestination?: pino.DestinationStream;
}

const PROMPT_PREFIX = [
  `You are Autocatalyst, an AI-powered product engineering assistant integrated into Slack.`,
  ``,
  `You have access to the repository via shell tools. Use them to answer the question accurately.`,
  `For example: run \`gh issue list\`, \`gh pr list\`, \`git log\`, read files, etc.`,
  ``,
  `Answer concisely — this response will be posted directly to Slack.`,
  `Do not include preamble or sign-off. Just the answer.`,
  ``,
  `Question:`,
].join('\n');

export class AgentSDKQuestionAnswerer implements QuestionAnswerer {
  private readonly queryFn: QueryFn;
  private readonly logger: pino.Logger;
  private readonly repo_path: string;

  constructor(repo_path: string, options?: AgentSDKQuestionAnswererOptions) {
    this.repo_path = repo_path;
    this.queryFn = options?.queryFn ?? _query;
    this.logger = createLogger('question-answerer', { destination: options?.logDestination });
  }

  async answer(question: string): Promise<string> {
    this.logger.debug({ event: 'question.answering', question_length: question.length }, 'Answering question via Agent SDK');

    const prompt = `${PROMPT_PREFIX}${question}`;
    const chunks: string[] = [];

    try {
      for await (const message of this.queryFn({
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
        // Collect assistant text from the final message
        const msg = message as { role?: string; content?: Array<{ type: string; text?: string }> };
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              chunks.push(block.text);
            }
          }
        }
      }
    } catch (err) {
      this.logger.error({ event: 'question.agent_failed', error: String(err) }, 'Agent SDK exited with error during question answering');
      throw new Error(`Agent SDK question answering failed: ${String(err)}`);
    }

    const response = chunks.join('').trim();
    if (!response) {
      throw new Error('Agent SDK returned no text response for question');
    }

    this.logger.info({ event: 'question.answered', response_length: response.length }, 'Question answered');
    return response;
  }
}
