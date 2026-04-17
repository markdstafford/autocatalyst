import { describe, it, expect, vi } from 'vitest';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';

describe('NotionClient interface', () => {
  it('users.me is defined on the interface', () => {
    const client: NotionClient = {
      pages: {
        create: async () => ({}) as never,
        getMarkdown: async () => '',
        updateMarkdown: async () => {},
        updateProperties: async () => {},
      },
      blocks: { children: { list: async () => ({}) as never } },
      comments: { list: async () => ({}) as never, create: async () => ({}) as never },
      users: { me: async () => ({ id: 'test' }) },
      databases: { query: async () => ({ results: [] }) },
    };
    expect(typeof client.users.me).toBe('function');
  });

  it('pages.updateProperties is defined on the interface', () => {
    const client: NotionClient = {
      pages: {
        create: async () => ({}) as never,
        getMarkdown: async () => '',
        updateMarkdown: async () => {},
        updateProperties: async () => {},
      },
      blocks: { children: { list: async () => ({}) as never } },
      comments: { list: async () => ({}) as never, create: async () => ({}) as never },
      users: { me: async () => ({ id: 'test' }) },
      databases: { query: async () => ({ results: [] }) },
    };
    expect(typeof client.pages.updateProperties).toBe('function');
  });

  it('databases.query is defined on the interface', () => {
    const mockQuery = vi.fn().mockResolvedValue({ results: [{ id: 'page-id', properties: {} }] });
    const client: NotionClient = {
      pages: {
        create: async () => ({}) as never,
        getMarkdown: async () => '',
        updateMarkdown: async () => {},
        updateProperties: async () => {},
      },
      blocks: { children: { list: async () => ({}) as never } },
      comments: { list: async () => ({}) as never, create: async () => ({}) as never },
      users: { me: async () => ({ id: 'test' }) },
      databases: { query: mockQuery },
    };
    expect(typeof client.databases.query).toBe('function');
  });

  it('databases.query called without a filter does not error', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ results: [] });
    const client: NotionClient = {
      pages: {
        create: async () => ({}) as never,
        getMarkdown: async () => '',
        updateMarkdown: async () => {},
        updateProperties: async () => {},
      },
      blocks: { children: { list: async () => ({}) as never } },
      comments: { list: async () => ({}) as never, create: async () => ({}) as never },
      users: { me: async () => ({ id: 'test' }) },
      databases: { query: mockQuery },
    };
    await expect(client.databases.query('db-id')).resolves.toEqual({ results: [] });
  });
});
