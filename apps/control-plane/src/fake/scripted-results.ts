import type { ClaudeNativeEvent } from '@autocatalyst/claude-agent-adapter';

import { buildSpecBodyForPass } from './constants.js';

/** Inputs that fully determine a scripted session's output. */
export interface ScriptedSessionSelection {
  readonly step: string;
  readonly workKind: string;
  readonly role?: string;
  /** Result schema id selected for the launch, or 'any'/undefined for the legacy path. */
  readonly resultSchemaId?: string;
  readonly issueNumber?: number;
  /** 1-based spec.author pass number (for deterministic revisions). */
  readonly specAuthorPass?: number;
  readonly testingGuidePass?: number;
  readonly requiredBuildFeedbackIds?: readonly string[];
  readonly requiredFeedbackIds?: readonly string[];
}

function isStructured(schemaId: string | undefined): boolean {
  return schemaId !== undefined && schemaId.length > 0 && schemaId !== 'any';
}

function specSlug(issueNumber: number | undefined): string {
  return issueNumber !== undefined ? `fixture-issue-${issueNumber}` : 'fixture-spec';
}

/** Build the deterministic spec.author result object for a feature/enhancement run. */
export function buildScriptedSpecAuthorResult(selection: ScriptedSessionSelection): Record<string, unknown> {
  const isFeature = selection.workKind === 'feature';
  const prefix = isFeature ? 'feature' : 'enhancement';
  const slug = specSlug(selection.issueNumber);
  const title = `Fixture spec for issue ${selection.issueNumber ?? 0}`;
  return {
    kind: isFeature ? 'feature_spec' : 'enhancement_spec',
    slug,
    relativePath: `context-human/specs/${prefix}-${slug}.md`,
    frontmatter: {
      created: '2026-01-01',
      last_updated: '2026-01-01',
      status: 'draft',
      specced_by: 'autocatalyst',
      ...(selection.issueNumber !== undefined ? { issue: selection.issueNumber } : {})
    },
    body: buildSpecBodyForPass(title, selection.specAuthorPass ?? 1)
  };
}

/** Reviewer result that converges immediately. */
export function buildScriptedReviewerResult(): Record<string, unknown> {
  return { status: 'satisfied' };
}

/** Disposition only the build feedback explicitly required for this round. */
export function buildScriptedImplementerResult(required: readonly string[] = []): Record<string, unknown> {
  return required.length === 0 ? {} : {
    dispositions: [...new Set(required)].map(feedbackId => ({
      feedbackId, disposition: 'fixed', summary: 'Addressed in the deterministic build revision.'
    }))
  };
}

const guideInstructions = [
  'From the fake repository root, inspect the checked-out files:',
  '```sh',
  'git ls-files',
  '```'
].join('\n');

function buildScriptedTestingGuide(pass: number): Record<string, unknown> {
  return {
    instructions: guideInstructions,
    items: [
      { text: 'A. Find README.md in the file list.', expected: 'README.md is listed.' },
      { text: 'B. Open README.md.', expected: 'The file contains the fixture repository description.' },
      { text: 'C. Find fake-implementer-round-1.txt.', expected: 'The scripted build file is present.' },
      ...(pass === 1 ? [
        { text: 'D. Open the scripted build file.', expected: 'It contains deterministic implementer output.' }
      ] : [
        { text: 'D. Check the first line of the scripted build file.', expected: 'It reads: Deterministic fake-mode implementer output for round 1.' },
        { text: 'E. Inspect the checked-out file list for a testing guide.', expected: 'No testing guide is committed.' }
      ])
    ]
  };
}

/** Pull-request finalize result that advances. */
export function buildScriptedPrFinalizeResult(): Record<string, unknown> {
  return {
    directive: 'advance',
    titleSubject: 'Apply fixture change',
    reconciledSummary: 'Deterministic fake-mode change for the fixture app.',
    validationSummary: ['fake-mode scripted finalize'],
    findings: []
  };
}

/** Select the result object this scripted session should return. */
export function selectScriptedResult(selection: ScriptedSessionSelection): Record<string, unknown> {
  if (selection.step === 'spec.author' && (selection.workKind === 'feature' || selection.workKind === 'enhancement')) {
    if (selection.role === 'reviewer') return buildScriptedReviewerResult();
    const spec = buildScriptedSpecAuthorResult(selection);
    return selection.resultSchemaId === 'autocatalyst.reviewed_spec_author.v1'
      ? { spec, dispositions: (selection.requiredFeedbackIds ?? []).map(feedbackId => ({
          feedbackId, disposition: 'fixed', summary: 'Addressed in the deterministic spec revision.'
        })) }
      : spec;
  }
  if (selection.step === 'implementation.build' && selection.role === 'reviewer') {
    return buildScriptedReviewerResult();
  }
  if (selection.step === 'implementation.build' && selection.role === 'implementer') {
    return buildScriptedImplementerResult(selection.requiredBuildFeedbackIds);
  }
  if (selection.step === 'implementation.testing_guide') return buildScriptedTestingGuide(selection.testingGuidePass ?? 1);
  if (selection.step === 'pr.finalize') {
    return buildScriptedPrFinalizeResult();
  }
  // Legacy / generic steps (bug spec.author, question.answer, etc.).
  return { directive: 'advance' };
}

export function scriptedTaskProgress(label: string, completed: number, total: number): ClaudeNativeEvent {
  return { type: 'tool_use', tool: { name: 'report_progress', input: { label, completed, total } } };
}

export function scriptedPrelude(step?: string): ClaudeNativeEvent[] {
  return [
    { type: 'assistant', content: 'Scripted fake-mode session.' },
    { type: 'tool_use', tool: { name: 'Read' } },
    ...(step === 'implementation.testing_guide' ? [] : [scriptedTaskProgress('Scripted work', 0, 1)])
  ];
}

/**
 * Build the native Claude event sequence for a scripted session. The lifecycle
 * advance is driven by the written result file (structured capture or legacy
 * `result.output`), never by prompt text.
 */
export function buildScriptedSessionEvents(selection: ScriptedSessionSelection): ClaudeNativeEvent[] {
  const result = selectScriptedResult(selection);
  const usage = { total_tokens: 20, input_tokens: 10, output_tokens: 10 } as const;

  if (isStructured(selection.resultSchemaId)) {
    return [
      ...scriptedPrelude(selection.step),
      {
        type: 'result',
        structuredOutput: result,
        result: { is_error: false, output: 'scripted structured result', ...usage }
      }
    ];
  }

  return [
    ...scriptedPrelude(selection.step),
    {
      type: 'result',
      result: { output: JSON.stringify(result), is_error: false, ...usage }
    }
  ];
}
