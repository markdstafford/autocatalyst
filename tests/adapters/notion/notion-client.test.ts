import { describe, it, expect } from 'vitest';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';

describe('NotionClient interface', () => {
  it('users.me is defined on the interface', () => {
    // Type-level check: this test verifies the interface shape compiles
    const client: NotionClient = {
      pages: { create: async () => ({}) as never, getMarkdown: async () => '', updateMarkdown: async () => {} },
      blocks: { children: { list: async () => ({}) as never } },
      comments: { list: async () => ({}) as never, create: async () => ({}) as never },
      users: { me: async () => ({ id: 'test' }) },
    };
    expect(typeof client.users.me).toBe('function');
  });
});
