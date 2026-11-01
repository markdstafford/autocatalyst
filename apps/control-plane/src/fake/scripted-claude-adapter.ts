import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  claudeAgentAdapterId,
  claudeProviderKind,
  createClaudeAgentAdapter,
  type ClaudeAgentAdapterLogger,
  type ClaudeNativeEvent,
  type ClaudeSessionLaunch
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
import type { FakeStatePaths } from './paths.js';
import { buildScriptedSessionEvents, type ScriptedSessionSelection } from './scripted-results.js';

/** The adapter key fake mode must occupy — the real Claude Agent SDK key. */
export const scriptedClaudeAdapterKey = buildProviderAdapterKey(claudeProviderKind, claudeAgentAdapterId);

export interface ScriptedClaudeAdapterDependencies {
  readonly paths: FakeStatePaths;
  readonly logger?: ClaudeAgentAdapterLogger;
  /** Resolve the tracked issue number for a run when it is not in the task inputs. */
  readonly resolveIssueNumber?: (runId: string) => Promise<number | undefined> | number | undefined;
}

function launchFrom(events: readonly ClaudeNativeEvent[]): ClaudeSessionLaunch {
  return () => {
    async function* iterate(): AsyncIterable<ClaudeNativeEvent> {
      for (const event of events) {
        yield event;
      }
    }
    return iterate();
  };
}

function failingLaunch(error: Error): ClaudeSessionLaunch {
  return () => {
    async function* iterate(): AsyncIterable<ClaudeNativeEvent> {
      throw error;
      yield {} as ClaudeNativeEvent; // unreachable
    }
    return iterate();
  };
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
      const issueNumber = issueFromInputs ?? (deps.resolveIssueNumber !== undefined ? await deps.resolveIssueNumber(runId) : undefined);

      const launchSequence = await bumpLaunchCounter(deps.paths);
      const specAuthorPass = step === 'spec.author' ? await bumpSpecAuthorPass(deps.paths, runId) : undefined;

      await recordLaunchContext(deps.paths, {
        runId,
        stepId: step,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        workKind,
        launchSequence,
        resultSchemaId,
        ...(role !== undefined ? { role } : {})
      });

      // Failure injection: the first matching launch for the issue+step fails.
      if (issueNumber !== undefined && (await consumeFailureIfMatches(deps.paths, issueNumber, step))) {
        const base = createClaudeAgentAdapter({
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
          launchClaudeSession: failingLaunch(new Error('fake-mode scripted failure injected'))
        });
        return base.startSession(input);
      }

      // Implementer sessions write a deterministic committable file into the
      // workspace repo so the convergence engine records an implementerCommitSha.
      if (step === 'implementation.build' && role === 'implementer') {
        const workspace = input.runInput.environment.workspace as { shape?: string; repoRoot?: string };
        if (workspace.shape === 'two_roots' && typeof workspace.repoRoot === 'string') {
          const filePath = join(workspace.repoRoot, `fake-implementer-round-${round ?? 1}.txt`);
          await writeFile(filePath, `Deterministic fake-mode implementer output for round ${round ?? 1}.\n`, 'utf-8');
        }
      }

      const selection: ScriptedSessionSelection = {
        step,
        workKind,
        ...(role !== undefined ? { role } : {}),
        resultSchemaId,
        ...(issueNumber !== undefined ? { issueNumber } : {}),
        ...(specAuthorPass !== undefined ? { specAuthorPass } : {})
      };
      const events = buildScriptedSessionEvents(selection);
      const base = createClaudeAgentAdapter({
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
        launchClaudeSession: launchFrom(events)
      });
      return base.startSession(input);
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
