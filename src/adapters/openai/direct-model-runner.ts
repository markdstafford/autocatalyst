import OpenAI from 'openai';
import type { DirectModelRunRequest, DirectModelRunResult, DirectModelRunner } from '../../types/ai.js';

export type OpenAIChatCompletionFn = (params: {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user'; content: string }>;
}) => Promise<{ choices: Array<{ message: { content: string | null } }> }>;

export interface OpenAIDirectModelRunnerOptions {
  createFn?: OpenAIChatCompletionFn;
  defaultModel?: string;
}

export class OpenAIDirectModelRunner implements DirectModelRunner {
  private readonly createFn: OpenAIChatCompletionFn;
  private readonly defaultModel?: string;

  constructor(apiKey: string, baseUrl?: string, options?: OpenAIDirectModelRunnerOptions) {
    if (options?.createFn) {
      this.createFn = options.createFn;
    } else {
      const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
      if (baseUrl) {
        // Azure APIM / Grove gateways require 'api-key' instead of 'Authorization: Bearer'.
        // Setting defaultHeaders here ensures any request to a custom base URL uses it.
        clientOptions.baseURL = baseUrl;
        clientOptions.defaultHeaders = { 'api-key': apiKey };
      }
      const client = new OpenAI(clientOptions);
      this.createFn = params =>
        client.chat.completions.create(params) as Promise<{ choices: Array<{ message: { content: string | null } }> }>;
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
      text: raw.choices[0]?.message.content ?? '',
      raw,
    };
  }
}
