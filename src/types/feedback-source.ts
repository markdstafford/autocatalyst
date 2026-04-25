export interface FeedbackComment {
  id: string;
  body: string;
}

export interface FeedbackSource {
  fetch(publication_ref: string): Promise<FeedbackComment[]>;
  reply(publication_ref: string, comment_id: string, response: string): Promise<void>;
}
