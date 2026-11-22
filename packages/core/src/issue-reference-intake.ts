import {
  issueWorkKindSchema,
  type CreateConversationSubmission,
  type CreateRunWorkKind,
  type CredentialReference,
  type IssueReferenceIntakeErrorCode,
  type IssueWorkKind,
  type IssueWorkKindDerivation,
  type Project,
  type ProjectIssueLookupResponse,
  type TrackedIssue
} from '@autocatalyst/api-contract';
import { IssueTrackerError } from './issue-tracker.js';
import type { IssueTrackerRegistry } from './issue-tracker-registry.js';
import { getRunWorkflowForWorkKind } from './run-workflows.js';

export type { IssueReferenceIntakeErrorCode } from '@autocatalyst/api-contract';

interface TrackerReadFailure {
  readonly error: IssueTrackerError;
  readonly provider: string;
  readonly repository: string;
  readonly issueNumber: number;
}

export class IssueReferenceIntakeError extends Error {
  readonly code: IssueReferenceIntakeErrorCode;
  readonly #trackerFailure: TrackerReadFailure | undefined;

  constructor(code: IssueReferenceIntakeErrorCode, message: string, trackerFailure?: TrackerReadFailure) {
    super(message);
    this.name = 'IssueReferenceIntakeError';
    this.code = code;
    this.#trackerFailure = trackerFailure;
  }

  get trackerFailure(): TrackerReadFailure | undefined {
    return this.#trackerFailure;
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
  lookup(project: Project, issueNumber: number): Promise<ProjectIssueLookupResponse>;
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

const WORK_KIND_LABELS: ReadonlySet<string> = new Set(issueWorkKindSchema.options);
const TITLE_PREFIX_MAP: ReadonlyMap<string, IssueWorkKind> = new Map([
  ['feat:', 'feature'],
  ['fix:', 'bug'],
  ['chore:', 'chore']
]);

function deriveWorkKind(issue: TrackedIssue): {
  workKind: IssueWorkKindDerivation;
  matchedLabels: IssueWorkKind[];
} {
  const matchedLabels = issue.labels
    .map(l => l.toLowerCase().trim())
    .filter((label): label is IssueWorkKind => WORK_KIND_LABELS.has(label));

  if (matchedLabels.length > 1) {
    return { workKind: { kind: null, source: 'none', reason: 'ambiguous_labels' }, matchedLabels };
  }

  const [kindFromLabel] = matchedLabels;
  if (kindFromLabel !== undefined) {
    return { workKind: { kind: kindFromLabel, source: 'label' }, matchedLabels };
  }

  const titleLower = issue.title.toLowerCase().trim();
  for (const [prefix, kind] of TITLE_PREFIX_MAP) {
    if (titleLower.startsWith(prefix)) {
      return { workKind: { kind, source: 'title_prefix' }, matchedLabels };
    }
  }
  return { workKind: { kind: null, source: 'none', reason: 'no_match' }, matchedLabels };
}

function settleWorkKind(issue: TrackedIssue, workflowLookup: (wk: string) => unknown): IssueWorkKind {
  const { workKind, matchedLabels } = deriveWorkKind(issue);
  if (workKind.source === 'none') {
    throw new IssueReferenceIntakeError('work_kind_unresolved', workKind.reason === 'ambiguous_labels'
      ? `Issue has ambiguous work-kind labels: ${matchedLabels.join(', ')}.`
      : 'Issue has no recognized work-kind label or title prefix.');
  }
  if (!workflowLookup(workKind.kind)) {
    throw new IssueReferenceIntakeError('work_kind_unresolved', `No workflow found for work kind: ${workKind.kind}.`);
  }
  return workKind.kind;
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

  async lookup(project: Project, issueNumber: number): Promise<ProjectIssueLookupResponse> {
    const issue = await this.#readIssue(project, issueNumber);
    return {
      issue: { number: issue.number, title: issue.title, url: issue.url, labels: issue.labels, state: issue.state },
      workKind: deriveWorkKind(issue).workKind
    };
  }

  async resolve(input: ResolveConversationCreateInput): Promise<ResolvedConversationCreate> {
    const { submission, project } = input;

    // Determine if this is an issue-reference create
    let issueNumber: number;

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

    const trackedIssue = await this.#readIssue(project, issueNumber);
    const explicitKind = submission.kind === 'issue_reference' ? submission.workKind : undefined;
    return {
      workKind: explicitKind ?? settleWorkKind(trackedIssue, this.#workflowLookup),
      trackedIssue,
      messageBody: submission.body
    };
  }

  async #readIssue(project: Project, issueNumber: number): Promise<TrackedIssue> {
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

    const { owner, name } = project.hostRepository;
    const target = {
      provider,
      repository: { owner, name },
      credentialRef
    };

    try {
      return await adapter.read({ target, issueNumber });
    } catch (error: unknown) {
      if (error instanceof IssueTrackerError) {
        throw new IssueReferenceIntakeError('tracker_read_failed',
          'Failed to read issue from tracker.',
          { error, provider, repository: `${owner}/${name}`, issueNumber }
        );
      }
      throw new IssueReferenceIntakeError('tracker_read_failed',
        'Failed to read issue from tracker.');
    }
  }
}
