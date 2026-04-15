// src/adapters/agent/question-answerer.ts
import Anthropic from '@anthropic-ai/sdk';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';

type CreateFn = (params: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: 'user'; content: string }>;
}) => Promise<{ content: Array<{ type: string; text: string }> }>;

export interface QuestionAnswerer {
  answer(question: string): Promise<string>;
}

interface AnthropicQuestionAnswererOptions {
  createFn?: CreateFn;
  logDestination?: pino.DestinationStream;
}

const SYSTEM_PROMPT = `You are Autocatalyst, an AI-powered product engineering assistant integrated into Slack.

You help teams turn ideas into shipped features by:
- Taking feature requests and bug reports from Slack
- Generating product specs collaboratively with the team
- Implementing features using AI agents and creating pull requests
- Routing in-thread feedback and approvals to the right handlers

Answer the user's question concisely and helpfully. If the question is about a specific codebase, repository, or domain you don't have context about, say so clearly and suggest they check with a team member directly.`;

export class AnthropicQuestionAnswerer implements QuestionAnswerer {
  private readonly createFn: CreateFn;
  private readonly logger: pino.Logger;

  constructor(apiKey: string, options?: AnthropicQuestionAnswererOptions) {
    if (options?.createFn) {
      this.createFn = options.createFn;
    } else {
      const client = new Anthropic({ apiKey });
      this.createFn = (params) => client.messages.create(params) as Promise<{ content: Array<{ type: string; text: string }> }>;
    }
    this.logger = createLogger('question-answerer', { destination: options?.logDestination });
  }

  async answer(question: string): Promise<string> {
    this.logger.debug({ event: 'question.answering', question_length: question.length }, 'Answering question');

    const response = await this.createFn({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: question }],
    });

    const text = response.content.find(b => b.type === 'text')?.text ?? '';
    if (!text) {
      return "I'm not sure how to answer that — try rephrasing or asking the team directly.";
    }

    this.logger.info({ event: 'question.answered', response_length: text.length }, 'Question answered');
    return text;
  }
}
