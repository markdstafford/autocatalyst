import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { RunnerEvent } from '@autocatalyst/api-contract';

import type { Runner, RunnerCloseResult, RunnerRunInput } from '@autocatalyst/execution';

export type SpecAuthoringHarnessMode = 'conformant' | 'mismatched_path' | 'invalid_json' | 'empty_body' | 'omitted_specced_by' | 'invalid_specced_by';

export interface SpecAuthoringHarnessRecord {
  readonly prompt: string;
  readonly taskInputs: Record<string, unknown>;
  readonly scratchRoot: string | undefined;
}

export interface SpecAuthoringHarness {
  readonly records: SpecAuthoringHarnessRecord[];
  readonly runner: Runner;
}

/**
 * Creates a harness Runner for spec-authoring integration tests.
 *
 * - Captures the prompt and task inputs from the materialized execution context.
 * - Validates that the prompt is a real spec-authoring prompt (contains 'mm:planning').
 * - Writes a `step-result.json` to the scratch directory in the requested mode.
 * - Emits a minimal event sequence ending with an `advance` terminal event.
 *
 * The `createExecutionEntryPoint` with `scratch_file` validation will then read and
 * validate the file, attaching the parsed result to the advance terminal event.
 */
export function createSpecAuthoringHarness(mode: SpecAuthoringHarnessMode = 'conformant'): SpecAuthoringHarness {
  const records: SpecAuthoringHarnessRecord[] = [];

  const runner: Runner = {
    async *run(input: RunnerRunInput): AsyncIterable<RunnerEvent> {
      const { environment } = input;
      const { run, task } = environment.context;
      const runId = run.id;
      const step = run.currentStep;
      const createdAt = new Date().toISOString();

      const prompt = task.prompt;
      const taskInputs = task.inputs as Record<string, unknown>;

      // Resolve scratch root from the materialized workspace
      const scratchRoot = 'scratchRoot' in environment.workspace
        ? (environment.workspace as { scratchRoot: string }).scratchRoot
        : undefined;

      // Only record and validate spec.author steps — other steps (e.g. 'intake') are
      // passed through as a simple advance without capturing or validating.
      if (step === 'spec.author') {
        records.push({ prompt, taskInputs, scratchRoot });

        // Guard: the prompt must be a real spec-authoring prompt, not a placeholder
        if (!prompt.includes('mm:planning')) {
          throw new Error(
            `SpecAuthoringHarness: expected a real spec-authoring prompt containing 'mm:planning', ` +
            `but got a prompt that does not contain it. ` +
            `This usually means the spec-authoring context was not injected correctly.`
          );
        }
        if (!prompt.includes('step-result.json')) {
          throw new Error('Harness requires real prompt with step-result.json contract.');
        }
        if (!prompt.includes('do not push')) {
          throw new Error('Harness requires runtime ownership rules in prompt.');
        }
        if (!prompt.includes('do not merge')) {
          throw new Error('Harness requires runtime ownership rules in prompt.');
        }
        if (!prompt.includes('do not open PRs')) {
          throw new Error('Harness requires runtime ownership rules in prompt.');
        }

        // Write the step-result.json to scratch if we have a scratch directory
        if (scratchRoot !== undefined) {
          await writeResultFile({ scratchRoot, mode, taskInputs });
        }
      }

      // Emit a minimal runner event sequence
      yield {
        id: `evt_${runId}_progress`,
        type: 'runner_progress',
        runId,
        step,
        importance: 'normal',
        createdAt,
        progress: { kind: 'intent', summary: `SpecAuthoringHarness received task for step: ${step}` }
      };

      // Terminal: advance (result will be read from scratch file by execution entry point)
      yield {
        id: `evt_${runId}_terminal`,
        type: 'runner_terminal_result',
        runId,
        step,
        importance: 'high',
        createdAt: new Date().toISOString(),
        result: { directive: 'advance' }
      };
    },

    async close(): Promise<RunnerCloseResult> {
      return { status: 'closed' };
    }
  };

  return { records, runner };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function writeResultFile(input: {
  readonly scratchRoot: string;
  readonly mode: SpecAuthoringHarnessMode;
  readonly taskInputs: Record<string, unknown>;
}): Promise<void> {
  const { scratchRoot, mode, taskInputs } = input;
  const resultPath = join(scratchRoot, 'step-result.json');
  await mkdir(dirname(resultPath), { recursive: true });

  const outputContract = taskInputs['outputContract'] as Record<string, unknown> | undefined;
  const expectedKind = (outputContract?.['expectedKind'] as string | undefined) ?? 'feature_spec';
  // expectedPathPrefix already includes the full directory prefix, e.g. 'context-human/specs/feature-'
  const expectedPathPrefix = (outputContract?.['expectedPathPrefix'] as string | undefined) ?? 'context-human/specs/feature-';

  const slug = 'harness-e2e-test';

  if (mode === 'conformant') {
    const result = {
      kind: expectedKind,
      slug,
      relativePath: `${expectedPathPrefix}${slug}.md`,
      frontmatter: {
        created: '2026-06-12',
        last_updated: '2026-06-12',
        status: 'draft',
        specced_by: 'autocatalyst'
      },
      body: `# Feature: Harness E2E Test\n\n## Overview\n\nThis spec was written by the spec-authoring harness.\n\n## Task list\n\n- [ ] Implement harness\n`
    };
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
    return;
  }

  if (mode === 'mismatched_path') {
    // kind says 'feature_spec' but path uses 'enhancement-' prefix — fails superRefine check
    const result = {
      kind: expectedKind,
      slug,
      relativePath: `context-human/specs/enhancement-${slug}.md`,
      frontmatter: {
        created: '2026-06-12',
        last_updated: '2026-06-12',
        status: 'draft',
        specced_by: 'autocatalyst'
      },
      body: `# Feature: Harness E2E Test (mismatched)\n\n## Task list\n\n- [ ] Implement\n`
    };
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
    return;
  }

  if (mode === 'invalid_json') {
    await writeFile(resultPath, 'NOT_VALID_JSON', 'utf8');
    return;
  }

  if (mode === 'empty_body') {
    const result = {
      kind: expectedKind,
      slug,
      relativePath: `${expectedPathPrefix}${slug}.md`,
      frontmatter: {
        created: '2026-06-12',
        last_updated: '2026-06-12',
        status: 'draft',
        specced_by: 'autocatalyst'
      },
      body: '   ' // whitespace-only — fails z.string().trim().min(1)
    };
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
    return;
  }

  if (mode === 'omitted_specced_by') {
    const result = {
      kind: expectedKind,
      slug,
      relativePath: `${expectedPathPrefix}${slug}.md`,
      frontmatter: {
        created: '2026-06-16',
        last_updated: '2026-06-16',
        status: 'draft'
        // specced_by omitted intentionally — system should stamp it
      },
      body: `# Feature: Harness E2E Test (omitted specced_by)\n\n## Overview\n\nThis spec omits specced_by.\n\n## Task list\n\n- [ ] Implement harness\n`
    };
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
    return;
  }

  if (mode === 'invalid_specced_by') {
    const result = {
      kind: expectedKind,
      slug,
      relativePath: `${expectedPathPrefix}${slug}.md`,
      frontmatter: {
        created: '2026-06-16',
        last_updated: '2026-06-16',
        status: 'draft',
        specced_by: 'autocatalyst:mm:planning'  // invalid — system should stamp to 'autocatalyst'
      },
      body: `# Feature: Harness E2E Test (invalid specced_by)\n\n## Overview\n\nThis spec has an invalid specced_by.\n\n## Task list\n\n- [ ] Implement harness\n`
    };
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
    return;
  }
}
