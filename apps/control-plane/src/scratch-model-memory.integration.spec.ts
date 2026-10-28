import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { convergenceCheckpointSchema, type ExecutionContext } from '@autocatalyst/api-contract';
import { createExecutionRunUnitOfWork, type RunRoleWorkInput } from '@autocatalyst/core';
import {
  createAgentOrchestratorRunner, createExecutionEntryPoint,
  type AgentConnection, type AgentProviderAdapter, type AgentModelMemorySnapshot,
  type ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import { createDrizzleDomainRepositories, createSqliteDatabase, migrateSqliteDatabase } from '@autocatalyst/persistence';

const owner = { id: 'human', kind: 'human', tenantId: 'tenant' } as const;

describe('scratch model memory with durable review checkpoints', () => {
  it('completes a second reviewer round without changing its strict convergence checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ac-memory-checkpoint-'));
    const database = createSqliteDatabase({ path: join(root, 'control-plane.sqlite') });
    try {
      await migrateSqliteDatabase(database);
      const repos = createDrizzleDomainRepositories(database);
      const project = await repos.projects.create({
        owner, tenant: 'tenant', displayName: 'Memory regression', repoUrl: 'https://example.test/repo',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' }, workspaceRootOverride: null,
        issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
      });
      const conversation = await repos.conversations.create({ projectId: project.id, owner, tenant: 'tenant', identity: 'memory-test', activeTopicId: null });
      const topic = await repos.topics.create({ conversationId: conversation.id, owner, tenant: 'tenant', title: 'Review memory', kind: 'main' });
      const run = await repos.runs.create({ topicId: topic.id, owner, tenant: 'tenant', workKind: 'chore', currentStep: 'implementation.build', terminal: false });
      const step = await repos.runSteps.create({ runId: run.id, phase: 'implementation', step: 'implementation.build', role: 'none', startedAt: new Date().toISOString(), endedAt: null, durationMs: null, occurrence: { index: 0, attempt: 1 } });
      const scratchRoot = join(root, 'scratch');
      await mkdir(scratchRoot);
      const checkpoint = convergenceCheckpointSchema.parse({
        kind: 'convergence_review', step: 'implementation.build', maxRounds: 3,
        routing: { distinct: true }, rounds: [], outcome: 'max_rounds', openFeedbackIds: [], lastPositions: {}
      });
      const snapshot = { providerKind: 'openai', adapterId: 'openai-agents-sdk', state: { previousResponseId: 'resp_reviewer_1' } };
      const seen: Array<AgentModelMemorySnapshot | null> = [];
      const profile: ResolvedAgentRunnerProfile = {
        mode: 'agent', providerKind: 'openai', adapterId: 'openai-agents-sdk', profileName: 'reviewer',
        model: { provider: 'openai', model: 'fake' }, inferenceSettings: {}, endpoint: {}, connectionMechanism: 'fetch_transport'
      };
      const adapter: AgentProviderAdapter = {
        providerKind: profile.providerKind, adapterId: profile.adapterId, supportedConnectionMechanism: profile.connectionMechanism,
        startSession(input) {
          return {
            events: (async function* () {
              seen.push(await input.modelMemory!.store.load());
              await input.modelMemory!.store.save(snapshot);
              yield {
                id: `evt_${seen.length}`, type: 'runner_terminal_result' as const, runId: run.id,
                step: run.currentStep, importance: 'normal' as const, createdAt: new Date().toISOString(),
                result: { directive: 'advance' as const }
              };
            })(),
            metadata: Promise.resolve({ degradedCapabilities: [], tokenUsage: { available: false } })
          };
        }
      };
      const connection: AgentConnection = {
        profile, credentialResolved: true, createFetchTransport: () => ({ fetch }),
        createProcessLaunchConfig: () => ({ environment: {}, secretVariableNames: [], degradedCapabilities: [], redacted: {} }),
        close: async () => undefined
      };
      const context: ExecutionContext = {
        run: { id: run.id, workKind: run.workKind, currentStep: run.currentStep, tenant: run.tenant },
        task: { prompt: 'Review implementation', inputs: {} }, workspaceIntent: { shape: 'none' },
        secretBindings: [], toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
        skills: { requested: [], resolved: [] }, capabilityRequirements: { shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: false }, lsp: { requested: false } }
      };
      const review = async (round: number) => {
        const runner = createAgentOrchestratorRunner({ adapter, profile, connection, telemetryContext: { runId: run.id, step: run.currentStep, role: 'reviewer' } });
        const entryPoint = createExecutionEntryPoint({
          runner, resultValidation: { mode: 'none' },
          materialize: async () => ({
            context, workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] },
            environment: { variables: {}, secretVariableNames: [] }, toolPolicy: { allowedTools: [], workspaceRoots: [scratchRoot] },
            skills: context.skills, capabilities: { shell: { kind: 'bash', available: false }, paths: { scratchRoot }, lsp: { requested: false, available: false } }
          })
        });
        const uow = createExecutionRunUnitOfWork({ execute: entryPoint, resolveContext: async () => context });
        const input: RunRoleWorkInput = { runId: run.id, run, tenant: run.tenant, role: 'reviewer', round };
        expect(await uow.run(input)).toMatchObject({ directive: 'advance' });
      };
      await review(1);
      await repos.runSteps.updateCheckpoint({ runStepId: step.id, runId: run.id, tenant: run.tenant, checkpointResult: checkpoint });
      // Demonstrate the exact old collision still rejects, without weakening the schema.
      expect(convergenceCheckpointSchema.safeParse({ ...checkpoint, providerModelMemory: { reviewer: snapshot } }).success).toBe(false);
      const updateCheckpoint = vi.spyOn(repos.runSteps, 'updateCheckpoint');
      await review(2);
      expect(seen).toEqual([null, snapshot]);
      expect(updateCheckpoint).not.toHaveBeenCalled();
      expect((await repos.runSteps.findById(step.id))?.checkpointResult).toEqual(checkpoint);
      await rm(scratchRoot, { recursive: true });
      await mkdir(scratchRoot);
      await review(3);
      expect(seen.at(-1)).toBeNull();
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
