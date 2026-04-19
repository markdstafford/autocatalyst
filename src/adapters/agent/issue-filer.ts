// src/adapters/agent/issue-filer.ts
import { query as _query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages';
import { readFile as _readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pino from 'pino';
import { createLogger } from '../../core/logger.js';
import type { Request } from '../../types/events.js';
import type { IssueManager } from './issue-manager.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface FiledIssue {
  number: number;
  title: string;
  action: 'filed' | 'duplicate';
}

export interface FilingResult {
  status: 'complete' | 'failed';
  summary: string;
  filed_issues: FiledIssue[];
  error?: string;
}

export interface IssueFiler {
  file(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<FilingResult>;
}

// ---------------------------------------------------------------------------
// Internal types (not exported)
// ---------------------------------------------------------------------------

interface EnrichmentItem {
  proposed_title: string;
  proposed_body: string;
  proposed_labels: string[];
  duplicate_of: { number: number; title: string } | null;
}

interface EnrichmentResult {
  status: 'complete' | 'failed';
  items: EnrichmentItem[];
  error?: string;
}

// ---------------------------------------------------------------------------
// AgentSDKIssueFiler
// ---------------------------------------------------------------------------

type QueryFn = typeof _query;

interface AgentSDKIssueFilerOptions {
  queryFn?: QueryFn;
  logDestination?: pino.DestinationStream;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
}

export class AgentSDKIssueFiler implements IssueFiler {
  private readonly issueManager: IssueManager;
  private readonly queryFn: QueryFn;
  private readonly logger: pino.Logger;
  private readonly readFileFn: (path: string, encoding: 'utf-8') => Promise<string>;

  constructor(issueManager: IssueManager, options?: AgentSDKIssueFilerOptions) {
    this.issueManager = issueManager;
    this.queryFn = options?.queryFn ?? _query;
    this.logger = createLogger('issue-filer', { destination: options?.logDestination });
    this.readFileFn = options?.readFile ?? ((path, enc) => _readFile(path, enc));
  }

  async file(
    request: Request,
    workspace_path: string,
    onProgress?: (message: string) => Promise<void>,
  ): Promise<FilingResult> {
    const enrichmentFilePath = join(workspace_path, '.autocatalyst', 'enrichment-result.json');
    const prompt = buildEnrichmentPrompt(request, enrichmentFilePath);

    this.logger.debug({ event: 'filing.agent_invoked', request_id: request.id }, 'Invoking Agent SDK for issue enrichment');

    // Phase 1: enrichment
    try {
      for await (const message of this.queryFn({
        prompt,
        options: {
          cwd: workspace_path,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          tools: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      })) {
        if (onProgress && (message as SDKMessage).type === 'assistant') {
          const assistantMsg = message as Extract<SDKMessage, { type: 'assistant' }>;
          const relayMessage = parseRelayMessage(assistantMsg.message.content);
          if (relayMessage) {
            onProgress(relayMessage)
              .then(() => {
                this.logger.info(
                  { event: 'progress_update', phase: 'enrichment', message: relayMessage },
                  'Progress update posted',
                );
              })
              .catch(err => {
                this.logger.warn(
                  { event: 'progress_failed', phase: 'enrichment', error: String(err) },
                  'Failed to post progress update',
                );
              });
          }
        }
      }
    } catch (err) {
      this.logger.error(
        { event: 'filing.agent_failed', request_id: request.id, error: String(err) },
        'Agent SDK exited with error during enrichment',
      );
      throw new Error(`Agent SDK enrichment failed: ${String(err)}`);
    }

    // Phase 2: read and validate enrichment result
    const enrichmentResult = await readAndValidateEnrichmentResult(this.readFileFn, enrichmentFilePath);

    if (enrichmentResult.status === 'failed') {
      return {
        status: 'failed',
        summary: '',
        filed_issues: [],
        error: enrichmentResult.error ?? 'Enrichment agent reported failure',
      };
    }

    // Phase 3: creation
    const filed_issues: FiledIssue[] = [];

    for (const item of enrichmentResult.items) {
      if (item.duplicate_of) {
        filed_issues.push({
          number: item.duplicate_of.number,
          title: item.duplicate_of.title,
          action: 'duplicate',
        });
      } else {
        const created = await this.issueManager.create(
          workspace_path,
          item.proposed_title,
          item.proposed_body,
          item.proposed_labels,
        );
        filed_issues.push({ number: created.number, title: item.proposed_title, action: 'filed' });
      }
    }

    const summary = buildSummary(filed_issues);
    this.logger.debug({ event: 'filing.agent_completed', request_id: request.id }, 'Issue filing completed');
    return { status: 'complete', summary, filed_issues };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRelayMessage(content: BetaMessage['content']): string | null {
  for (const block of content) {
    if (block.type === 'text') {
      for (const line of block.text.split('\n')) {
        const match = line.match(/^\[Relay\]\s+(.+)$/);
        if (match) return match[1].trim();
      }
    }
  }
  return null;
}

async function readAndValidateEnrichmentResult(
  readFileFn: (path: string, encoding: 'utf-8') => Promise<string>,
  filePath: string,
): Promise<EnrichmentResult> {
  let content: string;
  try {
    content = await readFileFn(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Issue filing: enrichment result file not found at "${filePath}" after agent completed`);
    }
    throw err;
  }

  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new Error(`Issue filing: enrichment result file at "${filePath}" is not valid JSON: ${String(err)}`);
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error(`Issue filing: enrichment result file at "${filePath}" is not a JSON object`);
  }
  const obj = data as Record<string, unknown>;

  if (obj['status'] !== 'complete' && obj['status'] !== 'failed') {
    throw new Error(`Issue filing: enrichment result at "${filePath}" has invalid status: "${String(obj['status'])}"`);
  }

  if (!Array.isArray(obj['items'])) {
    throw new Error(`Issue filing: enrichment result at "${filePath}" missing "items" array`);
  }

  const items: EnrichmentItem[] = [];
  for (let i = 0; i < (obj['items'] as unknown[]).length; i++) {
    const raw = (obj['items'] as unknown[])[i];
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Issue filing: enrichment result items[${i}] is not an object`);
    }
    const item = raw as Record<string, unknown>;

    if (item['duplicate_of'] !== null && item['duplicate_of'] !== undefined) {
      const dup = item['duplicate_of'];
      if (typeof dup !== 'object' || dup === null || typeof (dup as Record<string, unknown>)['number'] !== 'number' || typeof (dup as Record<string, unknown>)['title'] !== 'string') {
        throw new Error(`Issue filing: enrichment result items[${i}].duplicate_of must be null or { number: number, title: string }`);
      }
      items.push({
        proposed_title: '',
        proposed_body: '',
        proposed_labels: [],
        duplicate_of: { number: (dup as Record<string, unknown>)['number'] as number, title: (dup as Record<string, unknown>)['title'] as string },
      });
    } else {
      if (typeof item['proposed_title'] !== 'string' || !item['proposed_title']) {
        throw new Error(`Issue filing: enrichment result items[${i}].proposed_title must be a non-empty string when duplicate_of is null`);
      }
      if (typeof item['proposed_body'] !== 'string' || !item['proposed_body']) {
        throw new Error(`Issue filing: enrichment result items[${i}].proposed_body must be a non-empty string when duplicate_of is null`);
      }
      if (!Array.isArray(item['proposed_labels'])) {
        throw new Error(`Issue filing: enrichment result items[${i}].proposed_labels must be an array when duplicate_of is null`);
      }
      items.push({
        proposed_title: item['proposed_title'] as string,
        proposed_body: item['proposed_body'] as string,
        proposed_labels: item['proposed_labels'] as string[],
        duplicate_of: null,
      });
    }
  }

  return {
    status: obj['status'] as 'complete' | 'failed',
    items,
    error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
  };
}

function buildSummary(filedIssues: FiledIssue[]): string {
  const newIssues = filedIssues.filter(i => i.action === 'filed');
  const duplicates = filedIssues.filter(i => i.action === 'duplicate');

  const parts: string[] = [];

  if (newIssues.length > 0) {
    const list = newIssues.map(i => `#${i.number} ${i.title}`).join(', ');
    parts.push(`Filed ${newIssues.length} new issue${newIssues.length === 1 ? '' : 's'}: ${list}`);
  }

  if (duplicates.length > 0) {
    const list = duplicates.map(i => `#${i.number} ${i.title}`).join(', ');
    parts.push(`Found ${duplicates.length} existing issue${duplicates.length === 1 ? '' : 's'}: ${list}`);
  }

  if (parts.length === 0) {
    return 'No issues filed (empty list).';
  }

  return parts.join(' — ');
}

const CHECKPOINT_INSTRUCTIONS = `At any point during your work, if you have something worth reporting to the human watching —
a phase transition, your current focus, something interesting you found, or a meaningful
milestone — emit it on its own line using this exact format:

[Relay] <your message here>

Examples of good checkpoints:
- [Relay] Investigating codebase for item 1 of 3
- [Relay] Detected duplicate for item 2 — existing issue #45
- [Relay] Enrichment complete — writing result file

The goal is to keep a human informed at intervals they'd find interesting. You decide what's
worth reporting and when.`;

function buildEnrichmentPrompt(request: Request, enrichmentFilePath: string): string {
  return [
    `You are enriching a list of items to be filed as GitHub issues.`,
    ``,
    `Invoke the \`mm:issue-triage\` skill in feedback intake mode to:`,
    `1. Identify each distinct issue in the list below`,
    `2. Investigate each item against the codebase (thorough mode)`,
    `3. For each item:`,
    `   - If a duplicate issue already exists: leave a comment on the existing issue noting the duplicate request; record it with duplicate_of set to the existing issue's number and title; omit proposed_title/body/labels`,
    `   - If no duplicate exists: generate a rich title, descriptive body, and appropriate label suggestions; record it with duplicate_of: null`,
    ``,
    `Do NOT create GitHub issues. Record enrichment data only — issue creation will be handled separately.`,
    ``,
    `List of items:`,
    `>>>`,
    request.content,
    `>>>`,
    ``,
    `When enrichment is complete, write the result to: ${enrichmentFilePath}`,
    `Content must be:`,
    `{`,
    `  "status": "complete" | "failed",`,
    `  "items": [`,
    `    {`,
    `      "proposed_title": "...",      // required when duplicate_of is null`,
    `      "proposed_body": "...",       // required when duplicate_of is null`,
    `      "proposed_labels": ["..."],   // required when duplicate_of is null; may be empty array`,
    `      "duplicate_of": null | { "number": N, "title": "..." }`,
    `    }`,
    `  ],`,
    `  "error": "..." // only when failed`,
    `}`,
    ``,
    `Do not signal completion until the result file has been written.`,
    ``,
    CHECKPOINT_INSTRUCTIONS,
  ].join('\n');
}

// Exported for testing only
export { parseRelayMessage, buildEnrichmentPrompt, buildSummary, readAndValidateEnrichmentResult };
