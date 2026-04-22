import type { CommandHandler } from '../../types/commands.js';
import type { IntentClassifier, ClassificationContext } from '../../adapters/agent/intent-classifier.js';
import { VALID_INTENTS_BY_CONTEXT } from '../../adapters/agent/intent-classifier.js';

export function makeClassifyIntentHandler(intentClassifier: IntentClassifier): CommandHandler {
  return async (event, reply) => {
    const { args } = event;

    if (args.length === 0) {
      await reply('Usage: `:ac-classify-intent: <message>` or `:ac-classify-intent: <context> <message>`');
      return;
    }

    let context: ClassificationContext = 'new_thread';
    let text: string;

    if (args[0] in VALID_INTENTS_BY_CONTEXT) {
      context = args[0] as ClassificationContext;
      text = args.slice(1).join(' ');
    } else {
      text = args.join(' ');
    }

    if (!text.trim()) {
      await reply('Usage: `:ac-classify-intent: <message>` or `:ac-classify-intent: <context> <message>`');
      return;
    }

    const intent = await intentClassifier.classify(text, context);

    await reply(`*Classification result*\nContext: \`${context}\`\nIntent: \`${intent}\``);
  };
}
