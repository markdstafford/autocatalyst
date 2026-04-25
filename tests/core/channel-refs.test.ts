import { describe, expect, it } from 'vitest';
import { channelKey, conversationKey, messageKey } from '../../src/types/channel.js';
import { channelRegistryToRepoMap } from '../../src/types/config.js';

describe('channel refs', () => {
  it('keys include provider so equal platform IDs do not collide', () => {
    expect(channelKey({ provider: 'chat', id: 'C123', name: 'product' })).toBe('chat:C123');
    expect(channelKey({ provider: 'comments', id: 'C123', name: 'product' })).toBe('comments:C123');
  });

  it('conversation keys include provider, channel, and conversation IDs', () => {
    const ref = { provider: 'chat', channel_id: 'C123', conversation_id: '100.0' };

    expect(conversationKey(ref)).toBe('chat:C123:100.0');
  });

  it('message keys include the conversation key and message ID', () => {
    const ref = {
      provider: 'chat',
      channel_id: 'C123',
      conversation_id: '100.0',
      message_id: '101.0',
    };

    expect(messageKey(ref)).toBe('chat:C123:100.0:101.0');
  });

  it('derives the repo map from the channel registry', () => {
    const repoMap = channelRegistryToRepoMap(new Map([
      ['chat:C123', {
        channel: { provider: 'chat', id: 'C123', name: 'product' },
        repo_url: 'https://example.test/org/repo.git',
        workspace_root: '/workspaces',
      }],
    ]));

    expect(repoMap.get('chat:C123')).toEqual({
      channel_ref: 'chat:C123',
      repo_url: 'https://example.test/org/repo.git',
      workspace_root: '/workspaces',
    });
  });
});
