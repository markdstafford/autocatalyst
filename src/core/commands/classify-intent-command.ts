import type { CommandHandler } from '../../types/commands.js';
import type { ClassificationContext, IntentClassifier } from '../../types/intent.js';
import { BUILT_IN_CLASSIFICATION_CONTEXTS } from '../extensions/built-ins.js';

export function makeClassifyIntentHandler(intentClassifier: IntentClassifier): CommandHandler {
  return async (event, reply) => {
    const { args } = event;

    if (args.length === 0) {
      await reply('Usage: `:ac-classify-intent: <message>` or `:ac-classify-intent: <context> <message>`');
      return;
    }

    let context: ClassificationContext = 'new_thread';
    let text: string;

    if (BUILT_IN_CLASSIFICATION_CONTEXTS.includes(args[0] as ClassificationContext)) {
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
