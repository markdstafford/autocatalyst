// src/adapters/notion/notion-client.ts
import { Client } from '@notionhq/client';
import type {
  CreatePageParameters,
  CreatePageResponse,
  ListBlockChildrenParameters,
  ListBlockChildrenResponse,
  ListCommentsParameters,
  ListCommentsResponse,
  CreateCommentParameters,
  CreateCommentResponse,
} from '@notionhq/client/build/src/api-endpoints.js';

export type MarkdownOperation =
  { type: 'replace_content'; replace_content: { new_str: string } };

export interface NotionClient {
  pages: {
    create(args: CreatePageParameters): Promise<CreatePageResponse>;
    getMarkdown(page_id: string): Promise<string>;
    updateMarkdown(page_id: string, operation: MarkdownOperation): Promise<void>;
    updateProperties(page_id: string, properties: Record<string, unknown>): Promise<void>;
  };
  blocks: {
    children: {
      list(args: ListBlockChildrenParameters): Promise<ListBlockChildrenResponse>;
    };
  };
  comments: {
    list(args: ListCommentsParameters): Promise<ListCommentsResponse>;
    create(args: CreateCommentParameters): Promise<CreateCommentResponse>;
  };
  users: {
    me(): Promise<{ id: string }>;
  };
  databases: {
    query(
      database_id: string,
      filter?: unknown,
    ): Promise<{ results: Array<{ id: string; properties: Record<string, unknown> }> }>;
  };
}

export class NotionClientImpl implements NotionClient {
  private readonly client: Client;

  constructor({ integration_token }: { integration_token: string }) {
    this.client = new Client({ auth: integration_token });
  }

  readonly pages = {
    create: (args: CreatePageParameters): Promise<CreatePageResponse> =>
      this.client.pages.create(args),

    getMarkdown: async (page_id: string): Promise<string> => {
      const response = await (this.client as unknown as {
        request: (args: { path: string; method: string; headers?: Record<string, string> }) => Promise<unknown>;
      }).request({
        path: `pages/${page_id}/markdown`,
        method: 'GET',
        headers: { 'Notion-Version': '2026-03-11' },
      });
      return (response as { markdown: string }).markdown;
    },

    updateMarkdown: async (page_id: string, operation: MarkdownOperation): Promise<void> => {
      await (this.client as unknown as {
        request: (args: { path: string; method: string; body: unknown; headers?: Record<string, string> }) => Promise<unknown>;
      }).request({
        path: `pages/${page_id}/markdown`,
        method: 'PATCH',
        headers: { 'Notion-Version': '2026-03-11' },
        body: operation,
      });
    },

    updateProperties: async (page_id: string, properties: Record<string, unknown>): Promise<void> => {
      await this.client.pages.update({ page_id, properties: properties as never });
    },
  };

  readonly blocks = {
    children: {
      list: (args: ListBlockChildrenParameters): Promise<ListBlockChildrenResponse> =>
        this.client.blocks.children.list(args),
    },
  };

  readonly comments = {
    list: (args: ListCommentsParameters): Promise<ListCommentsResponse> =>
      this.client.comments.list(args),
    create: (args: CreateCommentParameters): Promise<CreateCommentResponse> =>
      this.client.comments.create(args),
  };

  readonly users = {
    me: async (): Promise<{ id: string }> => {
      const response = await (this.client as unknown as {
        request: (args: { path: string; method: string }) => Promise<unknown>;
      }).request({
        path: 'users/me',
        method: 'GET',
      });
      return { id: (response as { id: string }).id };
    },
  };

  readonly databases = {
    query: async (
      database_id: string,
      filter?: unknown,
    ): Promise<{ results: Array<{ id: string; properties: Record<string, unknown> }> }> => {
      const response = await (this.client as unknown as {
        databases: {
          query: (args: { database_id: string; filter?: unknown }) => Promise<{ results: unknown[] }>;
        };
      }).databases.query({
        database_id,
        ...(filter !== undefined ? { filter } : {}),
      });
      return {
        results: response.results as Array<{ id: string; properties: Record<string, unknown> }>,
      };
    },
  };
}
