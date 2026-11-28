import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';
import { createClaudeAgentAdapter } from '@autocatalyst/claude-agent-adapter';
import { createCodexAgentAdapter } from '@autocatalyst/codex-agent-adapter';
import { applyRunDirective, runWorkflows, startRunLifecycle } from '@autocatalyst/core';
import { createAgentConnection, type MaterializedExecutionEnvironment, type ResolvedAgentRunnerProfile } from '@autocatalyst/execution';
import { createDrizzleDomainRepositories, createSqliteDatabase, DrizzleAgentConversationRepository, migrateSqliteDatabase } from '@autocatalyst/persistence';

import { admitsReviewedLiveConversation, createReviewedAttemptPort, createFreshConversationResolver } from './reviewed-conversation.js';
import { ReviewedLiveConversations } from './reviewed-live-conversations.js';

const provider = process.env['AUTOCATALYST_LIVE_MEMORY_PROVIDER'];
const git = promisify(execFile);

describe.skipIf(provider === undefined)('live reviewed conversation', () => {
  it('recalls the prior round only within the same role, without writing a transcript', async () => {
    const model = process.env['AUTOCATALYST_LIVE_MEMORY_MODEL'];
    const home = process.env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
    if ((provider !== 'claude' && provider !== 'codex') || !model || !home || !await realpath(home)) {
      throw new Error('Select a provider, an authorized model, and a disposable signed-in provider home.');
    }
    const history = join(home, provider === 'codex' ? 'sessions' : 'projects');
    const transcripts = async () => (await readdir(history, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).filter(file => file.endsWith('.jsonl')).sort();
    const before = await transcripts();
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ac-live-conversation-')));
    const live = new ReviewedLiveConversations();
    const db = createSqliteDatabase({ path: join(root, 'control.sqlite') });
    try {
      await migrateSqliteDatabase(db);
      const repos = createDrizzleDomainRepositories(db);
      const tenant = 'fixture';
      const owner = { kind: 'human' as const, id: 'test', tenantId: tenant };
      const project = await repos.projects.create({ owner, tenant, displayName: 'Fixture', repoUrl: 'https://github.com/test/repo',
        hostRepository: { provider: 'github', owner: 'test', name: 'repo' }, workspaceRootOverride: null,
        issueTrackerSetting: null, codeHostSetting: null, credentialRefs: [] });
      const conversation = await repos.conversations.create({ owner, tenant, projectId: project.id, identity: 'test', activeTopicId: null });
      const topic = await repos.topics.create({ owner, tenant, conversationId: conversation.id, title: 'Fixture', kind: 'main' });
      const clock = () => new Date().toISOString();
      let work = await startRunLifecycle({ runs: repos.runs, run: { owner, tenant, topicId: topic.id, workKind: 'feature' }, clock });
      while (work.run.currentStep !== 'implementation.build') {
        work = await applyRunDirective({ runs: repos.runs, runId: work.run.id, directive: 'advance', clock });
      }
      const { run, runStep } = work;
      const workspacesRoot = join(root, 'workspaces');
      const repoRoot = join(workspacesRoot, run.id, 'repo');
      const scratchRoot = join(workspacesRoot, run.id, 'scratch');
      const hostRepository = join(root, 'host');
      await Promise.all([mkdir(hostRepository), mkdir(scratchRoot, { recursive: true })]);
      const args = { cwd: hostRepository, env: { ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } };
      await git('git', ['init', '-b', 'main'], args);
      await git('git', ['commit', '--allow-empty', '-m', 'base'], args);
      await git('git', ['worktree', 'add', '-b', 'fixture', repoRoot], args);
      await repos.runWorkspaceMetadata.upsert({ runId: run.id, workspaceHandle: 'fixture', workspaceRepoRoot: repoRoot, createdAt: clock() });

      const adapter = provider === 'codex' ? createCodexAgentAdapter({ authentication: 'business_sign_in' })
        : createClaudeAgentAdapter({ authentication: 'subscription' });
      const profile: ResolvedAgentRunnerProfile = {
        mode: 'agent', providerKind: adapter.providerKind, adapterId: adapter.adapterId,
        profileName: 'live-conversation', model: { model, provider: provider === 'codex' ? 'openai' : 'anthropic' },
        inferenceSettings: { reasoningEffort: 'low' }, connectionMechanism: 'process_environment', endpoint: {}
      };
      const runContext = { id: run.id, tenant, workKind: 'feature', currentStep: 'implementation.build' } as const;
      const workspaceRoots = [repoRoot, scratchRoot];
      const allowedTools = ['bash', 'filesystem'];
      const skills = { requested: [], resolved: [] };
      const repository = new DrizzleAgentConversationRepository(db);
      async function turn(prompt: string, role: 'implementer' | 'reviewer', round: number, resume: boolean) {
        const resultFile = `result-${randomUUID()}.txt`;
        const environment: MaterializedExecutionEnvironment = {
          context: { run: runContext, task: { prompt, inputs: { outputContract: { resultFile } } },
            workspaceIntent: { shape: 'none' }, secretBindings: [], skills,
            toolPolicy: { allowedTools, workspaceScope: 'declared_workspace' },
            capabilityRequirements: { shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: true }, lsp: { requested: false } } },
          workspace: { shape: 'two_roots', repoRoot, scratchRoot, workspaceRoots, branchName: 'fixture', provisionedBaseRef: 'main' },
          environment: { variables: { [provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: home! }, secretVariableNames: [] },
          toolPolicy: { allowedTools, workspaceRoots }, skills,
          capabilities: { shell: { kind: 'bash', available: false }, paths: { repoRoot, scratchRoot }, lsp: { requested: false, available: false } }
        };
        const port = createReviewedAttemptPort({
          repository, roleInput: { run, runId: run.id, tenant, role, round,
            reviewedOccurrence: { id: runStep.id, workflow: runWorkflows.feature } },
          live, admitsLive: admitsReviewedLiveConversation, prepareFreshConversation: createFreshConversationResolver(),
          workspacesRoot, hostRepository, repositoryIdentity: 'test/repo', freshHandoff: ''
        })!;
        const attemptId = 'sess_' + randomUUID();
        const nativeConversation = await port.prepare({ attemptId, environment, profile, fallback: false });
        if (nativeConversation?.mode !== 'in_memory') throw new Error('Expected production in-memory admission.');
        expect(Boolean(nativeConversation.resource)).toBe(resume);
        const telemetryContext = { runId: run.id, step: run.currentStep, role };
        const connection = await createAgentConnection({ profile, telemetryContext, credentialReference: { required: false },
          credentialResolver: { resolveCredential: async () => undefined } });
        let accepted = false;
        try {
          const session = await adapter.startSession({ profile, connection, telemetryContext, runInput: { nativeConversation, environment } });
          try {
            for await (const event of session.events) {
              expect(event.type).not.toBe('runner_tool_activity');
              if (event.type === 'runner_terminal_result') accepted = event.result.directive === 'advance';
            }
            expect((await session.metadata).outcome).toBe('succeeded');
            expect(accepted).toBe(true);
            return (await readFile(join(scratchRoot, resultFile), 'utf8')).trim();
          } finally { await session.close?.(); }
        } finally {
          await port.finish({ attemptId, accepted });
          await connection.close?.();
        }
      }

      const marker = randomUUID();
      expect(await turn(`Do not use tools. Remember this fixture marker for a later turn. Reply with only ${marker}`, 'implementer', 1, false)).toBe(marker);
      expect(await turn('Without tools or guessing, reply only with the exact fixture marker from the earlier turn.', 'implementer', 2, true)).toBe(marker);
      expect(await turn('Without tools, reply only with the earlier fixture marker if present in this conversation, otherwise reply NONE.',
        'reviewer', 1, false)).toBe('NONE');
      expect(await transcripts()).toEqual(before);
    } finally {
      live.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});
