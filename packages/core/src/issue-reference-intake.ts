import type { CreateConversationSubmission, CredentialReference, Project, TrackedIssue, CreateRunWorkKind } from '@autocatalyst/api-contract';
import { IssueTrackerError } from './issue-tracker.js';
import type { IssueTrackerRegistry } from './issue-tracker-registry.js';
import { getRunWorkflowForWorkKind } from './run-workflows.js';

export type IssueReferenceIntakeErrorCode =
  | 'tracker_not_configured'
  | 'unsupported_tracker_provider'
  | 'tracker_target_invalid'
  | 'tracker_credential_missing'
  | 'tracker_read_failed'
  | 'issue_reference_ambiguous'
  | 'work_kind_unresolved';

export class IssueReferenceIntakeError extends Error {
  readonly code: IssueReferenceIntakeErrorCode;
  readonly safeDetails?: Record<string, unknown>;

  constructor(code: IssueReferenceIntakeErrorCode, message: string, safeDetails?: Record<string, unknown>) {
    super(message);
    this.name = 'IssueReferenceIntakeError';
    this.code = code;
    if (safeDetails !== undefined) {
      this.safeDetails = safeDetails;
    }
  }
}

export interface ResolveConversationCreateInput {
  readonly submission: CreateConversationSubmission;
  readonly project: Project;
  readonly tenant: string;
}

export interface ResolvedConversationCreate {
  readonly workKind: CreateRunWorkKind;
  readonly trackedIssue?: TrackedIssue;
  readonly messageBody: string;
}

export interface IssueReferenceIntakeResolver {
  resolve(input: ResolveConversationCreateInput): Promise<ResolvedConversationCreate>;
}

export interface DefaultIssueReferenceIntakeResolverOptions {
  readonly registry: IssueTrackerRegistry;
  readonly workflowLookup?: (workKind: string) => unknown;
}

// Recognition regexes - package private
const ISSUE_WITH_NUMBER_RE = /\bissue\s+#?(\d+)\b/gi;
const HASH_NUMBER_RE = /(?<!\w)#(\d+)\b/g;

function extractIssueNumbers(body: string): Set<number> {
  const numbers = new Set<number>();

  for (const match of body.matchAll(ISSUE_WITH_NUMBER_RE)) {
    numbers.add(Number(match[1]));
  }
  for (const match of body.matchAll(HASH_NUMBER_RE)) {
    // Skip numbers already captured by ISSUE_WITH_NUMBER_RE to avoid double-counting
    // by only adding if they represent standalone hashes not preceded by 'issue'
    numbers.add(Number(match[1]));
  }

  return numbers;
}

const WORK_KIND_LABELS = new Set<string>(['feature', 'enhancement', 'bug', 'chore']);
const TITLE_PREFIX_MAP: ReadonlyMap<string, CreateRunWorkKind> = new Map([
  ['feat:', 'feature'],
  ['fix:', 'bug'],
  ['chore:', 'chore']
]);

function settleWorkKind(issue: TrackedIssue, workflowLookup: (wk: string) => unknown): CreateRunWorkKind {
  const workKindLabels = issue.labels
    .map(l => l.toLowerCase().trim())
    .filter(l => WORK_KIND_LABELS.has(l));

  if (workKindLabels.length > 1) {
    throw new IssueReferenceIntakeError('work_kind_unresolved',
      `Issue has ambiguous work-kind labels: ${workKindLabels.join(', ')}.`);
  }

  if (workKindLabels.length === 1) {
    const workKind = workKindLabels[0] as CreateRunWorkKind;
    if (!workflowLookup(workKind)) {
      throw new IssueReferenceIntakeError('work_kind_unresolved', `No workflow found for work kind: ${workKind}.`);
    }
    return workKind;
  }

  // Title prefix fallback
  const titleLower = issue.title.toLowerCase().trim();
  for (const [prefix, workKind] of TITLE_PREFIX_MAP) {
    if (titleLower.startsWith(prefix)) {
      if (!workflowLookup(workKind)) {
        throw new IssueReferenceIntakeError('work_kind_unresolved', `No workflow found for work kind: ${workKind}.`);
      }
      return workKind;
    }
  }

  throw new IssueReferenceIntakeError('work_kind_unresolved',
    'Issue has no recognized work-kind label or title prefix.');
}

function resolveCredential(project: Project): CredentialReference {
  // Prefer issueTrackerSetting.credentialRef
  if (project.issueTrackerSetting?.credentialRef) {
    return project.issueTrackerSetting.credentialRef;
  }

  // Fall back to exactly one issue_tracker credential
  const issueTrackerCreds = project.credentialRefs.filter(c => c.purpose === 'issue_tracker');

  if (issueTrackerCreds.length === 0) {
    throw new IssueReferenceIntakeError('tracker_credential_missing',
      'No issue tracker credential configured for this project.');
  }

  if (issueTrackerCreds.length > 1) {
    throw new IssueReferenceIntakeError('tracker_credential_missing',
      'Multiple issue tracker credentials found; specify one in issueTrackerSetting.credentialRef.');
  }

  return issueTrackerCreds[0]!;
}

export class DefaultIssueReferenceIntakeResolver implements IssueReferenceIntakeResolver {
  readonly #registry: IssueTrackerRegistry;
  readonly #workflowLookup: (workKind: string) => unknown;

  constructor(options: DefaultIssueReferenceIntakeResolverOptions) {
    this.#registry = options.registry;
    this.#workflowLookup = options.workflowLookup ?? getRunWorkflowForWorkKind;
  }

  async resolve(input: ResolveConversationCreateInput): Promise<ResolvedConversationCreate> {
    const { submission, project } = input;

    // Determine if this is an issue-reference create
    let issueNumber: number | null = null;

    if (submission.kind === 'issue_reference') {
      issueNumber = submission.issue.number;
    } else if (submission.kind === 'free_form') {
      const numbers = extractIssueNumbers(submission.body);

      if (numbers.size > 1) {
        throw new IssueReferenceIntakeError('issue_reference_ambiguous',
          `Free-form text contains multiple issue references: ${[...numbers].join(', ')}.`);
      }

      if (numbers.size === 1) {
        issueNumber = [...numbers][0]!;
      } else {
        // No issue reference — use explicit workKind path
        if (!submission.workKind) {
          throw new IssueReferenceIntakeError('work_kind_unresolved',
            'Free-form submission has no recognized issue reference and no workKind.');
        }
        return {
          workKind: submission.workKind,
          ...(submission.trackedIssue !== undefined ? { trackedIssue: submission.trackedIssue } : {}),
          messageBody: submission.body
        };
      }
    } else {
      // question / list_to_file — explicit workKind path
      return {
        workKind: submission.workKind,
        ...(submission.trackedIssue !== undefined ? { trackedIssue: submission.trackedIssue } : {}),
        messageBody: submission.body
      };
    }

    // Resolve issue reference
    if (!project.issueTrackerSetting) {
      throw new IssueReferenceIntakeError('tracker_not_configured',
        'Project has no issue tracker configured.');
    }

    const { provider } = project.issueTrackerSetting;
    const adapter = this.#registry.get(provider);

    if (!adapter) {
      throw new IssueReferenceIntakeError('unsupported_tracker_provider',
        `Issue tracker provider '${provider}' is not supported.`);
    }

    const credentialRef = resolveCredential(project);

    const target = {
      provider,
      repository: {
        owner: project.hostRepository.owner,
        name: project.hostRepository.name
      },
      credentialRef
    };

    let trackedIssue: TrackedIssue;
    try {
      trackedIssue = await adapter.read({ target, issueNumber: issueNumber! });
    } catch (error: unknown) {
      if (error instanceof IssueTrackerError) {
        throw new IssueReferenceIntakeError('tracker_read_failed',
          `Failed to read issue from tracker: ${error.code}.`,
          { trackerCode: error.code, ...error.safeDetails }
        );
      }
      if (error instanceof IssueReferenceIntakeError) {
        throw error;
      }
      throw new IssueReferenceIntakeError('tracker_read_failed',
        'Failed to read issue from tracker.');
    }

    const workKind = settleWorkKind(trackedIssue, this.#workflowLookup);

    return {
      workKind,
      trackedIssue,
      messageBody: submission.body
    };
  }
}
