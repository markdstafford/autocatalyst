import type { ChannelRegistry, ConversationRef, MessageRef } from '../types/channel.js';
import type { InboundEvent } from '../types/events.js';

export interface ChannelAdapter {
  resolveChannels(): Promise<ChannelRegistry>;
  receive(): AsyncIterable<InboundEvent>;
  reply(ref: ConversationRef, text: string): Promise<MessageRef>;
  replyError(ref: ConversationRef, text: string): Promise<MessageRef>;
  start(): Promise<void>;
  stop(): Promise<void>;
  react?(ref: MessageRef, reaction: string): Promise<void>;
  registerConversation?(ref: ConversationRef, request_id: string): void;
}
