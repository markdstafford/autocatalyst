export type ChannelProvider = string;

export interface ChannelRef {
  provider: ChannelProvider;
  id: string;
  name?: string;
}

export interface ConversationRef {
  provider: ChannelProvider;
  channel_id: string;
  conversation_id: string;
}

export interface MessageRef extends ConversationRef {
  message_id: string;
}

export interface ChannelBinding {
  channel: ChannelRef;
  repo_url: string;
  workspace_root: string;
}

export type ChannelRegistry = Map<string, ChannelBinding>;

export function channelKey(ref: ChannelRef): string {
  return `${ref.provider}:${ref.id}`;
}

export function conversationKey(ref: ConversationRef): string {
  return `${ref.provider}:${ref.channel_id}:${ref.conversation_id}`;
}

export function messageKey(ref: MessageRef): string {
  return `${conversationKey(ref)}:${ref.message_id}`;
}
