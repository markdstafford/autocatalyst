export interface Idea {
  id: string;
  source: 'slack';
  content: string;
  author: string;
  received_at: string; // ISO 8601
  thread_ts: string;   // Slack thread identifier; used to post replies
  channel_id: string;
}

export interface ThreadMessage {
  idea_id: string;
  content: string;
  author: string;
  received_at: string; // ISO 8601
  thread_ts: string;   // Slack thread identifier; used to post replies
  channel_id: string;
}

export type InboundEvent =
  | { type: 'new_idea'; payload: Idea }
  | { type: 'thread_message'; payload: ThreadMessage };
