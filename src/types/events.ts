export interface Idea {
  id: string;
  source: 'slack';
  content: string;
  author: string;
  received_at: string; // ISO 8601
  thread_ts: string;   // Slack thread identifier; used to post replies
  channel_id: string;
}

export interface SpecFeedback {
  idea_id: string;
  content: string;
  author: string;
  received_at: string; // ISO 8601
  thread_ts: string;   // Slack thread identifier; used to post replies
  channel_id: string;
}

export interface ApprovalSignal {
  idea_id: string;
  approver: string;
  emoji: string;
  received_at: string; // ISO 8601
}

export type InboundEvent =
  | { type: 'new_idea'; payload: Idea }
  | { type: 'spec_feedback'; payload: SpecFeedback }
  | { type: 'approval_signal'; payload: ApprovalSignal };
