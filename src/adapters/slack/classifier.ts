import type { ThreadRegistry } from './thread-registry.js';

export interface MessageInput {
  text: string | undefined;
  user: string;
  ts: string;
  thread_ts?: string;
}

export type MessageClassification =
  | { intent: 'new_request' }
  | { intent: 'thread_message'; request_id: string }
  | { intent: 'ignore' };

export function classifyMessage(
  message: MessageInput,
  botUserId: string,
  registry: ThreadRegistry,
): MessageClassification {
  // Suppress bot's own messages (prevents response loops)
  if (message.user === botUserId) return { intent: 'ignore' };

  // Thread reply: thread_ts exists and differs from ts
  const isReply = message.thread_ts !== undefined && message.thread_ts !== message.ts;
  if (isReply) {
    // Must contain exact @mention token for bot
    const mention = `<@${botUserId}>`;
    if (!message.text || !message.text.includes(mention)) {
      return { intent: 'ignore' };
    }

    const request_id = registry.resolve(message.thread_ts!);
    if (request_id === undefined) return { intent: 'ignore' };
    return { intent: 'thread_message', request_id };
  }

  // Root message: must contain exact @mention token
  const mention = `<@${botUserId}>`;
  if (!message.text || !message.text.includes(mention)) {
    return { intent: 'ignore' };
  }

  return { intent: 'new_request' };
}
