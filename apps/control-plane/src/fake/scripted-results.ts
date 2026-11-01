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

/** Implementer dispositions result with no carried-forward findings. */
export function buildScriptedImplementerResult(): Record<string, unknown> {
  return {};
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
    return buildScriptedSpecAuthorResult(selection);
  }
  if (selection.step === 'implementation.build' && selection.role === 'reviewer') {
    return buildScriptedReviewerResult();
  }
  if (selection.step === 'implementation.build' && selection.role === 'implementer') {
    return buildScriptedImplementerResult();
  }
  if (selection.step === 'pr.finalize') {
    return buildScriptedPrFinalizeResult();
  }
  // Legacy / generic steps (bug spec.author, question.answer, etc.).
  return { directive: 'advance' };
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
      { type: 'assistant', content: 'Scripted fake-mode session.' },
      { type: 'tool_use', tool: { name: 'report_progress', input: { note: 'scripted' } } },
      {
        type: 'result',
        structuredOutput: result,
        result: { is_error: false, output: 'scripted structured result', ...usage }
      }
    ];
  }

  return [
    { type: 'assistant', content: 'Scripted fake-mode session.' },
    {
      type: 'result',
      result: { output: JSON.stringify(result), is_error: false, ...usage }
    }
  ];
}
