import Anthropic from '@anthropic-ai/sdk';
import type { DirectModelRunRequest, DirectModelRunResult, DirectModelRunner } from '../../types/ai.js';

export type AnthropicCreateFn = (params: {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}) => Promise<{ content: Array<{ type: string; text?: string }> }>;

export interface AnthropicDirectModelRunnerOptions {
  createFn?: AnthropicCreateFn;
  defaultModel?: string;
}

export class AnthropicDirectModelRunner implements DirectModelRunner {
  private readonly createFn: AnthropicCreateFn;
  private readonly defaultModel?: string;

  constructor(apiKey: string, options?: AnthropicDirectModelRunnerOptions) {
    if (options?.createFn) {
      this.createFn = options.createFn;
    } else {
      const client = new Anthropic({ apiKey });
      this.createFn = params => client.messages.create(params) as Promise<{ content: Array<{ type: string; text?: string }> }>;
    }
    this.defaultModel = options?.defaultModel;
  }

  async run(request: DirectModelRunRequest): Promise<DirectModelRunResult> {
    const model = request.model ?? request.profile?.model ?? this.defaultModel;
    if (!model) {
      throw new Error(`Direct model route ${request.route.task} requires a model`);
    }

    const raw = await this.createFn({
      model,
      max_tokens: request.max_tokens ?? 1024,
      messages: request.messages,
    });
    return {
      text: raw.content.find(block => block.type === 'text')?.text ?? '',
      raw,
    };
  }
}
