import type { ChannelRef, ConversationRef, MessageRef } from './channel.js';

export interface CommandEvent {
  command: string;              // normalized command name: 'run.status', 'health', etc.
  args: string[];               // text after the emoji token, split on whitespace
  channel: ChannelRef;
  conversation: ConversationRef;
  origin: MessageRef;
  author: string;
  received_at: string;
  inferred_context?: {
    request_id?: string;
  };
}

export type CommandHandler = (
  event: CommandEvent,
  reply: (text: string) => Promise<void>,
) => Promise<void>;

export interface CommandRegistry {
  register(command: string, handler: CommandHandler, usage?: string): void;
  dispatch(command: string, event: CommandEvent, reply: (text: string) => Promise<void>): Promise<void>;
  has(command: string): boolean;
  list(): string[];
  getUsage(command: string): string | undefined;
}
