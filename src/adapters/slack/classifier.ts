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
  | { intent: 'new_idea' }
  | { intent: 'spec_feedback'; idea_id: string }
  | { intent: 'ignore' };

export type ReactionClassification =
  | { intent: 'approval_signal'; idea_id: string }
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
    const idea_id = registry.resolve(message.thread_ts!);
    if (idea_id === undefined) return { intent: 'ignore' };
    return { intent: 'spec_feedback', idea_id };
  }

  return { intent: 'new_idea' };
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

  const idea_id = registry.resolve(reaction.item_ts);
  if (idea_id === undefined) return { intent: 'ignore' };
  return { intent: 'approval_signal', idea_id };
}
