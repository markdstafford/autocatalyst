import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotionClient } from '../../../src/adapters/notion/notion-client.js';
import { NotionClientImpl } from '../../../src/adapters/notion/notion-client.js';

// Mock the Notion SDK Client so we can inspect what NotionClientImpl passes to it
const mockSdkQuery = vi.fn();
vi.mock('@notionhq/client', () => ({
  Client: vi.fn(() => ({
    dataSources: { query: mockSdkQuery },
  })),
}));

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
      dataSources: { query: async () => ({ results: [] }) },
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
      dataSources: { query: async () => ({ results: [] }) },
    };
    expect(typeof client.pages.updateProperties).toBe('function');
  });

  it('dataSources.query is defined on the interface', () => {
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
      dataSources: { query: mockQuery },
    };
    expect(typeof client.dataSources.query).toBe('function');
  });

  it('dataSources.query called without a filter does not error', async () => {
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
      dataSources: { query: mockQuery },
    };
    await expect(client.dataSources.query('db-id')).resolves.toEqual({ results: [] });
  });
});

describe('NotionClientImpl.dataSources.query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls SDK dataSources.query with data_source_id', async () => {
    mockSdkQuery.mockResolvedValue({ results: [] });
    const impl = new NotionClientImpl({ integration_token: 'test-token' });

    await impl.dataSources.query('ds-abc');

    expect(mockSdkQuery).toHaveBeenCalledWith({ data_source_id: 'ds-abc' });
  });

  it('passes filter through to SDK when provided', async () => {
    mockSdkQuery.mockResolvedValue({ results: [] });
    const impl = new NotionClientImpl({ integration_token: 'test-token' });
    const filter = { property: 'Filename', rich_text: { equals: 'spec.md' } };

    await impl.dataSources.query('ds-abc', filter);

    expect(mockSdkQuery).toHaveBeenCalledWith({ data_source_id: 'ds-abc', filter });
  });

  it('omits filter key when filter not provided', async () => {
    mockSdkQuery.mockResolvedValue({ results: [] });
    const impl = new NotionClientImpl({ integration_token: 'test-token' });

    await impl.dataSources.query('ds-abc');

    expect(mockSdkQuery).toHaveBeenCalledWith(
      expect.not.objectContaining({ filter: expect.anything() }),
    );
  });

  it('returns results from SDK response shaped as { id, properties } array', async () => {
    mockSdkQuery.mockResolvedValue({
      results: [{ id: 'page-1', properties: { Name: {} } }],
    });
    const impl = new NotionClientImpl({ integration_token: 'test-token' });

    const result = await impl.dataSources.query('ds-abc');

    expect(result).toEqual({ results: [{ id: 'page-1', properties: { Name: {} } }] });
  });
});
