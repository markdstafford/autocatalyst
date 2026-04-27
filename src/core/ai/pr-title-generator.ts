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
    const truncated = truncateArtifact(content);
    const prompt = buildPrompt(input.intent, truncated, input.impl_summary);
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

const IMPL_HEADINGS = [
  '## Design changes',
  '## Technical changes',
  '## Task list',
  '## Implementation',
];
const MAX_ARTIFACT_CHARS = 3000;

function truncateArtifact(content: string): string {
  let earliest = -1;
  for (const heading of IMPL_HEADINGS) {
    const idx = content.indexOf(`\n${heading}`);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  if (earliest !== -1) return content.slice(0, earliest).trimEnd();
  return content.length > MAX_ARTIFACT_CHARS ? content.slice(0, MAX_ARTIFACT_CHARS) : content;
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
