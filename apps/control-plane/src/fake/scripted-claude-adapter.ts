import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter,
  type ClaudeAgentAdapterLogger
} from '@autocatalyst/claude-agent-adapter';
import { buildProviderAdapterKey, type ProviderAdapterFactory } from '@autocatalyst/core';
import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionInput
} from '@autocatalyst/execution';

import {
  bumpLaunchCounter,
  bumpSpecAuthorPass,
  consumeFailureIfMatches,
  recordLaunchContext
} from './launch-context.js';
import { claimLaunchDelay, launchScript } from './scripted-launch.js';
import type { FakeStatePaths } from './paths.js';
import { buildScriptedSessionEvents, scriptedPrelude, type ScriptedSessionSelection } from './scripted-results.js';

/** The adapter key fake mode must occupy — the real Claude Agent SDK key. */
export const scriptedClaudeAdapterKey = buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId);

export interface ScriptedClaudeAdapterDependencies {
  readonly paths: FakeStatePaths;
  readonly logger?: ClaudeAgentAdapterLogger;
  /** Resolve the tracked issue number for a run when it is not in the task inputs. */
  readonly isStillRunning?: (runId: string, step: string) => Promise<boolean>;
  readonly resolveIssueNumber?: (runId: string) => Promise<number | undefined> | number | undefined;
}

function readRole(taskInputs: Record<string, unknown> | undefined): string | undefined {
  const role = taskInputs?.['role'];
  return typeof role === 'string' ? role : undefined;
}

function readRound(taskInputs: Record<string, unknown> | undefined): number | undefined {
  const round = taskInputs?.['round'];
  return typeof round === 'number' && Number.isInteger(round) ? round : undefined;
}

function readIssueNumberFromInputs(taskInputs: Record<string, unknown> | undefined): number | undefined {
  const runInput = taskInputs?.['run'];
  if (typeof runInput === 'object' && runInput !== null && !Array.isArray(runInput)) {
    const candidate = (runInput as Record<string, unknown>)['issueNumber'];
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Create the scripted Claude adapter. It occupies the real Claude Agent SDK
 * adapter key and, for each session, records a launch context keyed by run id +
 * launch sequence, then delegates to the real adapter's event→result machinery
 * with a deterministic scripted event sequence. Behavior never depends on prompt
 * wording — only on the recorded launch context and the result schema id.
 */
export function createScriptedClaudeAdapter(deps: ScriptedClaudeAdapterDependencies): AgentProviderAdapter {
  return {
    credentialRequirement: 'required',
    supportsSpecReview: true,
    providerKind: claudeProviderKind,
    adapterId: claudeAgentAdapterId,
    supportedConnectionMechanism: 'process_environment',
    async startSession(input: AgentProviderSessionInput): Promise<AgentProviderSession> {
      const context = input.runInput.environment.context;
      const taskInputs = context.task.inputs as Record<string, unknown> | undefined;
      const runId = context.run.id;
      const step = context.run.currentStep;
      const workKind = context.run.workKind;
      const role = readRole(taskInputs);
      const round = readRound(taskInputs);
      const resultSchemaId = input.structuredResultCapture?.schemaId ?? 'any';

      const issueFromInputs = readIssueNumberFromInputs(taskInputs);
      const issueNumber = issueFromInputs ?? (step !== 'implementation.testing_guide' ? await deps.resolveIssueNumber?.(runId) : undefined);

      const launchSequence = await bumpLaunchCounter(deps.paths);
      const specAuthorPass = step === 'spec.author' && role !== 'reviewer' ? await bumpSpecAuthorPass(deps.paths, runId) : undefined;

      await recordLaunchContext(deps.paths, {
        runId,
        stepId: step,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        workKind,
        launchSequence,
        resultSchemaId,
        ...(role !== undefined ? { role } : {})
      });

      const failed = issueNumber !== undefined && await consumeFailureIfMatches(deps.paths, issueNumber, step);
      const delay = issueNumber === undefined ? undefined : await claimLaunchDelay(deps.paths, issueNumber, step);
      const controller = new AbortController();

      // Implementer sessions write a deterministic committable file into the
      // workspace repo so the convergence engine records an implementerCommitSha.
      if (!failed && step === 'implementation.build' && role === 'implementer') {
        const workspace = input.runInput.environment.workspace as { shape?: string; repoRoot?: string };
        if (workspace.shape === 'two_roots' && typeof workspace.repoRoot === 'string') {
          const filePath = join(workspace.repoRoot, `fake-implementer-round-${round ?? 1}.txt`);
          await writeFile(filePath, `Deterministic fake-mode implementer output for round ${round ?? 1}.\n`, 'utf-8');
        }
      }

      const review = taskInputs?.['specReview'] as { requiredFeedbackIds?: readonly string[] } | undefined;
      const testingGuidePass = taskInputs?.['testingGuidePass'];
      const required = taskInputs?.['requiredDispositions'];
      const requiredBuildFeedbackIds = Array.isArray(required) ? required.flatMap(entry =>
        entry && typeof entry.feedbackId === 'string' && entry.feedbackId.length > 0 ? [entry.feedbackId as string] : []
      ) : [];
      const selection: ScriptedSessionSelection = {
        ...(review?.requiredFeedbackIds ? { requiredFeedbackIds: review.requiredFeedbackIds } : {}),
        requiredBuildFeedbackIds,
        ...(typeof testingGuidePass === 'number' && Number.isInteger(testingGuidePass) && testingGuidePass > 0 ? { testingGuidePass } : {}),
        step,
        workKind,
        ...(role !== undefined ? { role } : {}),
        resultSchemaId,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        ...(specAuthorPass !== undefined ? { specAuthorPass } : {})
      };
      const events = failed ? scriptedPrelude(step) : buildScriptedSessionEvents(selection);
      const base = createClaudeAgentAdapter({
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        launchClaudeSession: launchScript({
          events,
          failed,
          ms: delay ?? 0,
          signal: controller.signal,
          stillRunning: () => deps.isStillRunning?.(runId, step) ?? Promise.resolve(true)
        })
      });
      const session = await base.startSession(input);
      return { ...session, async close() {
        controller.abort();
        await session.close?.();
      } };
    }
  };
}

/**
 * Build the provider adapter factory that fake-mode startup registers under the
 * real Claude adapter key. The factory ignores its configuration record and
 * always returns the scripted adapter.
 */
export function createScriptedClaudeAdapterFactory(deps: ScriptedClaudeAdapterDependencies): ProviderAdapterFactory {
  const adapter = createScriptedClaudeAdapter(deps);
  return () => adapter;
}
