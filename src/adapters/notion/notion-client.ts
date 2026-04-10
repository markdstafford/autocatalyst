// src/adapters/notion/notion-client.ts
import { Client } from '@notionhq/client';
import type {
  CreatePageParameters,
  CreatePageResponse,
  ListBlockChildrenParameters,
  ListBlockChildrenResponse,
  AppendBlockChildrenParameters,
  AppendBlockChildrenResponse,
  DeleteBlockParameters,
  DeleteBlockResponse,
  ListCommentsParameters,
  ListCommentsResponse,
  CreateCommentParameters,
  CreateCommentResponse,
} from '@notionhq/client/build/src/api-endpoints.js';

export interface NotionClient {
  pages: {
    create(args: CreatePageParameters): Promise<CreatePageResponse>;
  };
  blocks: {
    children: {
      list(args: ListBlockChildrenParameters): Promise<ListBlockChildrenResponse>;
      append(args: AppendBlockChildrenParameters): Promise<AppendBlockChildrenResponse>;
    };
    delete(args: DeleteBlockParameters): Promise<DeleteBlockResponse>;
  };
  comments: {
    list(args: ListCommentsParameters): Promise<ListCommentsResponse>;
    create(args: CreateCommentParameters): Promise<CreateCommentResponse>;
    update(comment_id: string): Promise<void>; // best-effort resolve; may 404/405
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
  };

  readonly blocks = {
    children: {
      list: (args: ListBlockChildrenParameters): Promise<ListBlockChildrenResponse> =>
        this.client.blocks.children.list(args),
      append: (args: AppendBlockChildrenParameters): Promise<AppendBlockChildrenResponse> =>
        this.client.blocks.children.append(args),
    },
    delete: (args: DeleteBlockParameters): Promise<DeleteBlockResponse> =>
      this.client.blocks.delete(args),
  };

  readonly comments = {
    list: (args: ListCommentsParameters): Promise<ListCommentsResponse> =>
      this.client.comments.list(args),
    create: (args: CreateCommentParameters): Promise<CreateCommentResponse> =>
      this.client.comments.create(args),
    update: async (comment_id: string): Promise<void> => {
      // PATCH /v1/comments/:id — best-effort; Notion API may not support this
      await (this.client as unknown as {
        request: (args: { path: string; method: string; body: unknown }) => Promise<unknown>;
      }).request({
        path: `comments/${comment_id}`,
        method: 'PATCH',
        body: { resolved: true },
      });
    },
  };
}
