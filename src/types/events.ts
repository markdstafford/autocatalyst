import type { CommandEvent } from './commands.js';
import type { ChannelRef, ConversationRef, MessageRef } from './channel.js';

export interface Request {
  id: string;
  channel: ChannelRef;
  conversation: ConversationRef;
  origin: MessageRef;
  content: string;
  author: string;
  received_at: string;
}

export interface ThreadMessage {
  request_id: string;
  channel: ChannelRef;
  conversation: ConversationRef;
  origin: MessageRef;
  content: string;
  author: string;
  received_at: string;
}

export type InboundEvent =
  | { type: 'new_request'; payload: Request }
  | { type: 'thread_message'; payload: ThreadMessage }
  | { type: 'command'; payload: CommandEvent };
