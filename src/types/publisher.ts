import { basename } from 'path';

export type SpecEntryStatus =
  | 'Speccing'
  | 'Waiting on feedback'
  | 'Approved'
  | 'Complete'
  | 'Superseded';

export interface SpecPublisher {
  create(channel_id: string, thread_ts: string, spec_path: string): Promise<string>;
  update(publisher_ref: string, spec_path: string, page_content?: string): Promise<void>;
  getPageMarkdown(publisher_ref: string, stripHtml?: boolean): Promise<string>;
  updateStatus?(publisher_ref: string, status: SpecEntryStatus): Promise<void>;
  setIssueLink?(publisher_ref: string, issue_url: string): Promise<void>;
}

export function titleFromPath(spec_path: string): string {
  const slug = basename(spec_path, '.md')
    .replace(/^(feature|enhancement)-/, '')
    .replace(/-/g, ' ');
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}
