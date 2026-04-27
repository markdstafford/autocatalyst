import { readFile } from 'node:fs/promises';
import type pino from 'pino';
import { createLogger } from '../logger.js';
import type {
  AgentRoutingPolicy,
  DirectModelRunner,
} from '../../types/ai.js';
import type { RequestIntent } from '../../types/runs.js';

export interface PRTitleInput {
  intent: RequestIntent;
  spec_path: string;
  impl_summary: string | undefined;
}

export interface PRTitleGenerator {
  generate(input: PRTitleInput): Promise<string | null>;
}

export interface ModelPRTitleGeneratorOptions {
  routingPolicy?: AgentRoutingPolicy;
  model?: string;
  max_tokens?: number;
  logDestination?: pino.DestinationStream;
}

export class ModelPRTitleGenerator implements PRTitleGenerator {
  private readonly logger: pino.Logger;

  constructor(
    private readonly runner: DirectModelRunner,
    private readonly options: ModelPRTitleGeneratorOptions = {},
  ) {
    this.logger = createLogger('pr-title-generator', { destination: options.logDestination });
  }

  async generate(input: PRTitleInput): Promise<string | null> {
    const content = await readFile(input.spec_path, 'utf8');
    const prompt = buildPrompt(input.intent, content, input.impl_summary);
    const route = { task: 'pr.title_generate' as const, intent: input.intent };
    const response = await this.runner.run({
      route,
      profile: this.options.routingPolicy?.resolve(route),
      model: this.options.model,
      max_tokens: this.options.max_tokens ?? 60,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.text.trim() || null;
  }
}

function buildPrompt(intent: RequestIntent, artifact: string, implSummary: string | undefined): string {
  return [
    'You are writing the title for a pull request.',
    '',
    `Intent: ${intent}`,
    'Artifact:',
    '<<<',
    artifact,
    '>>>',
    '',
    'Implementation summary:',
    '<<<',
    implSummary ?? '',
    '>>>',
    '',
    'Rules:',
    '- Output only the title, no prefix, no quotes, no trailing period.',
    '- Max 72 characters. Lowercase except for proper nouns and code identifiers.',
    '- Describe the change concretely (what was done / fixed / added), not the problem.',
    '- Use imperative mood.',
    '',
    'Title:',
  ].join('\n');
}
