export type ImplementationReviewStatus =
  | 'not_started'
  | 'in_progress'
  | 'waiting_on_feedback'
  | 'approved';

export interface FeedbackItem {
  id: string;
  text: string;
  resolved: boolean;
  conversation: string[];
}

export interface PublishedImplementationReview {
  id: string;
  url?: string;
}

export interface ImplementationReviewInput {
  artifact_ref: string;
  artifact_url?: string;
  title: string;
  summary: string;
  testing_instructions: string;
}

export interface ImplementationReviewPublisher {
  create(input: ImplementationReviewInput): Promise<PublishedImplementationReview>;

  readFeedback(review_ref: string): Promise<FeedbackItem[]>;

  update(
    review_ref: string,
    options: {
      summary?: string;
      resolved_items?: Array<{
        id: string;
        resolution_comment: string;
      }>;
    },
  ): Promise<void>;

  updateStatus?(review_ref: string, status: ImplementationReviewStatus): Promise<void>;
  setPRLink?(review_ref: string, pr_url: string): Promise<void>;
}
