import Anthropic from '@anthropic-ai/sdk';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { RunStage } from '../../types/runs.js';

export type Intent =
  | 'spec_feedback'
  | 'spec_approval'
  | 'implementation_feedback'
  | 'implementation_approval';

export interface IntentClassifier {
  classify(message: string, run_stage: RunStage): Promise<Intent>;
}

const ALL_INTENTS: Intent[] = [
  'spec_feedback',
  'spec_approval',
  'implementation_feedback',
  'implementation_approval',
];

const VALID_INTENTS_BY_STAGE: Partial<Record<RunStage, Intent[]>> = {
  reviewing_spec: ['spec_feedback', 'spec_approval'],
  reviewing_implementation: ['implementation_feedback', 'implementation_approval'],
  awaiting_impl_input: ['implementation_feedback'],
};

const CONSERVATIVE_FALLBACK: Partial<Record<RunStage, Intent>> = {
  reviewing_spec: 'spec_feedback',
  reviewing_implementation: 'implementation_feedback',
  awaiting_impl_input: 'implementation_feedback',
};

type CreateFn = (params: { model: string; max_tokens: number; messages: Array<{ role: 'user'; content: string }> }) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface AnthropicIntentClassifierOptions {
  createFn?: CreateFn;
  logDestination?: pino.DestinationStream;
}

function parseIntentFromResponse(text: string): Intent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Try JSON unwrapping (handles `"spec_feedback"` format)
  if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return ALL_INTENTS.includes(parsed as Intent) ? (parsed as Intent) : null;
      }
    } catch {
      // fall through to token extraction
    }
  }

  // Extract first whitespace-delimited token (handles "spec_approval — explanation" format)
  const firstToken = trimmed.split(/[\s—–-]/)[0].trim();
  return ALL_INTENTS.includes(firstToken as Intent) ? (firstToken as Intent) : null;
}

export class AnthropicIntentClassifier implements IntentClassifier {
  private readonly createFn: CreateFn;
  private readonly logger: pino.Logger;

  constructor(apiKey: string, options?: AnthropicIntentClassifierOptions) {
    if (options?.createFn) {
      this.createFn = options.createFn;
    } else {
      const client = new Anthropic({ apiKey });
      this.createFn = (params) => client.messages.create(params) as Promise<{ content: Array<{ type: string; text: string }> }>;
    }
    this.logger = createLogger('intent-classifier', { destination: options?.logDestination });
  }

  async classify(message: string, run_stage: RunStage): Promise<Intent> {
    const fallback = CONSERVATIVE_FALLBACK[run_stage] ?? 'spec_feedback';

    if (!message.trim()) {
      return fallback;
    }

    const validIntents = VALID_INTENTS_BY_STAGE[run_stage] ?? ALL_INTENTS;
    const intentDescriptions: Record<Intent, string> = {
      spec_feedback: 'the human wants to revise or give feedback on the spec',
      spec_approval: 'the human is approving the spec and wants implementation to begin',
      implementation_feedback: 'the human is providing feedback, a bug report, or answering a question about the implementation',
      implementation_approval: 'the human confirms the implementation is ready and wants a PR created',
    };

    const prompt = [
      `Classify the following Slack message into one of these intents, given the current workflow stage.`,
      ``,
      `Current stage: ${run_stage}`,
      ``,
      `Valid intents for this stage:`,
      ...validIntents.map(i => `- ${i}: ${intentDescriptions[i]}`),
      ``,
      `Message:`,
      message,
      ``,
      `Respond with only the intent name, nothing else.`,
    ].join('\n');

    let attempt = 0;
    while (attempt < 2) {
      try {
        const response = await this.createFn({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 20,
          messages: [{ role: 'user', content: prompt }],
        });

        const text = response.content.find(b => b.type === 'text')?.text ?? '';
        const intent = parseIntentFromResponse(text);

        if (intent && validIntents.includes(intent)) {
          this.logger.info(
            { event: 'intent.classified', run_stage, classified_intent: intent, message_length: message.length },
            'Intent classified',
          );
          return intent;
        }

        if (intent && !validIntents.includes(intent)) {
          this.logger.warn(
            { event: 'intent.invalid_for_stage', returned_intent: intent, run_stage, valid_intents: validIntents },
            'Model returned intent not valid for stage',
          );
        }
      } catch (err) {
        this.logger.warn(
          { event: 'intent.classification_failed', run_stage, error: String(err) },
          'Intent classification API call failed',
        );
      }

      attempt++;
    }

    this.logger.warn(
      { event: 'intent.classified', run_stage, classified_intent: fallback, message_length: message.length },
      'Falling back to conservative default intent',
    );
    return fallback;
  }
}
