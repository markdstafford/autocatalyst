import type { ChannelBinding } from '../../src/types/channel.js';
import { channelKey, type ChannelRef, type ConversationRef, type MessageRef } from '../../src/types/channel.js';

export const TEST_PROVIDER = 'test-provider';
export const TEST_CHANNEL_ID = 'C123';
export const TEST_CONVERSATION_ID = '100.0';

export function testChannel(id = TEST_CHANNEL_ID): ChannelRef {
  return { provider: TEST_PROVIDER, id, name: `channel-${id}` };
}

export function testConversation(
  channel_id = TEST_CHANNEL_ID,
  conversation_id = TEST_CONVERSATION_ID,
): ConversationRef {
  return { provider: TEST_PROVIDER, channel_id, conversation_id };
}

export function testMessage(
  channel_id = TEST_CHANNEL_ID,
  conversation_id = TEST_CONVERSATION_ID,
  message_id = conversation_id,
): MessageRef {
  return { ...testConversation(channel_id, conversation_id), message_id };
}

export const TEST_CHANNEL = testChannel();
export const TEST_CONVERSATION = testConversation();
export const TEST_ORIGIN = testMessage();

export function testChannelBinding(
  id = TEST_CHANNEL_ID,
  repo_url = 'https://example.test/org/repo.git',
  workspace_root = '/tmp/workspaces',
): [string, ChannelBinding] {
  const channel = testChannel(id);
  return [channelKey(channel), { channel, repo_url, workspace_root }];
}
