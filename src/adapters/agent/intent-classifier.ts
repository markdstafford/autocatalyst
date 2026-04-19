import Anthropic from '@anthropic-ai/sdk';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { RunStage } from '../../types/runs.js';

export type Intent =
  | 'idea'
  | 'bug'
  | 'chore'
  | 'file_issues'
  | 'question'
  | 'feedback'
  | 'approval'
  | 'ignore';

export type ClassificationContext = 'new_thread' | RunStage;

const ALL_INTENTS: Intent[] = ['idea', 'bug', 'chore', 'file_issues', 'question', 'feedback', 'approval', 'ignore'];

export const VALID_INTENTS_BY_CONTEXT: Partial<Record<ClassificationContext, Intent[]>> = {
  new_thread:               ['idea', 'bug', 'chore', 'file_issues', 'question', 'ignore'],
  intake:                   ['idea', 'bug', 'chore', 'file_issues', 'question', 'ignore'],
  reviewing_spec:           ['feedback', 'approval', 'question', 'ignore'],
  reviewing_implementation: ['feedback', 'approval', 'question', 'ignore'],
  awaiting_impl_input:      ['feedback', 'question', 'ignore'],
  speccing:                 ['feedback', 'question', 'ignore'],
  implementing:             ['feedback', 'question', 'ignore'],
  done:                     ['ignore'],
  failed:                   ['ignore'],
};

const CONSERVATIVE_FALLBACK: Partial<Record<ClassificationContext, Intent>> = {
  new_thread:               'idea',
  intake:                   'idea',
  reviewing_spec:           'feedback',
  reviewing_implementation: 'feedback',
  awaiting_impl_input:      'feedback',
  speccing:                 'feedback',
  implementing:             'feedback',
  done:                     'ignore',
  failed:                   'ignore',
};

type CreateFn = (params: { model: string; max_tokens: number; messages: Array<{ role: 'user'; content: string }> }) => Promise<{ content: Array<{ type: string; text: string }> }>;

interface AnthropicIntentClassifierOptions {
  createFn?: CreateFn;
  logDestination?: pino.DestinationStream;
}

function parseIntentFromResponse(text: string): Intent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('"') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return ALL_INTENTS.includes(parsed as Intent) ? (parsed as Intent) : null;
      }
    } catch {
      // fall through
    }
  }

  const firstToken = trimmed.split(/[\s—–-]/)[0].trim();
  return ALL_INTENTS.includes(firstToken as Intent) ? (firstToken as Intent) : null;
}

export interface IntentClassifier {
  classify(message: string, context: ClassificationContext): Promise<Intent>;
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

  async classify(message: string, context: ClassificationContext): Promise<Intent> {
    const fallback = CONSERVATIVE_FALLBACK[context] ?? 'feedback';

    if (!message.trim()) return fallback;

    const validIntents = VALID_INTENTS_BY_CONTEXT[context] ?? ALL_INTENTS;

    const intentDescriptions: Record<Intent, string> = {
      idea:     'the human wants to build a new feature or improvement',
      bug:      'the human is reporting a bug or something broken',
      chore:    'the human is requesting maintenance work — a refactor, cleanup, dependency update, or other non-feature, non-bug task',
      file_issues: 'the human is explicitly requesting that one or more items be filed as GitHub issues',
      question: 'the human is asking a question',
      feedback: 'the human is providing feedback, a revision request, or answering a question about the current work',
      approval: 'the human is approving the current work and wants to proceed',
      ignore:   'the message is not directed at the bot or has no actionable intent',
    };

    const prompt = [
      `Classify the following Slack message into one of these intents, given the current context.`,
      ``,
      `Current context: ${context}`,
      ``,
      `Valid intents for this context:`,
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
            { event: 'intent.classified', context, classified_intent: intent, message_length: message.length },
            'Intent classified',
          );
          return intent;
        }

        if (intent && !validIntents.includes(intent)) {
          this.logger.warn(
            { event: 'intent.invalid_for_context', returned_intent: intent, context, valid_intents: validIntents },
            'Model returned intent not valid for context',
          );
        }
      } catch (err) {
        this.logger.warn(
          { event: 'intent.classification_failed', context, error: String(err) },
          'Intent classification API call failed',
        );
      }

      attempt++;
    }

    this.logger.warn(
      { event: 'intent.classified_fallback', context, classified_intent: fallback, message_length: message.length },
      'Falling back to conservative default intent',
    );
    return fallback;
  }
}
