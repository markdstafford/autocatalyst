import type { ThreadRegistry } from './thread-registry.js';

export interface MessageInput {
  text: string | undefined;
  user: string;
  ts: string;
  thread_ts?: string;
}

export interface ReactionInput {
  reaction: string;
  user: string;
  item_ts: string;
}

export type MessageClassification =
  | { intent: 'new_request' }
  | { intent: 'thread_message'; request_id: string }
  | { intent: 'ignore' };

export type ReactionClassification =
  | { intent: 'approval_signal'; request_id: string }
  | { intent: 'ignore' };

export function classifyMessage(
  message: MessageInput,
  botUserId: string,
  registry: ThreadRegistry,
): MessageClassification {
  // Suppress bot's own messages (prevents response loops)
  if (message.user === botUserId) return { intent: 'ignore' };

  // Must contain exact @mention token
  const mention = `<@${botUserId}>`;
  if (!message.text || !message.text.includes(mention)) {
    return { intent: 'ignore' };
  }

  // Thread reply: thread_ts exists and differs from ts
  const isReply = message.thread_ts !== undefined && message.thread_ts !== message.ts;
  if (isReply) {
    const request_id = registry.resolve(message.thread_ts!);
    if (request_id === undefined) return { intent: 'ignore' };
    return { intent: 'thread_message', request_id };
  }

  return { intent: 'new_request' };
}

export function classifyReaction(
  reaction: ReactionInput,
  approvalEmojis: string[],
  registry: ThreadRegistry,
  botUserId: string,
): ReactionClassification {
  // Suppress bot's own reactions
  if (reaction.user === botUserId) return { intent: 'ignore' };

  if (!approvalEmojis.includes(reaction.reaction)) return { intent: 'ignore' };

  const request_id = registry.resolve(reaction.item_ts);
  if (request_id === undefined) return { intent: 'ignore' };
  return { intent: 'approval_signal', request_id };
}
