import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { codexBusinessAdapterId, codexProviderKind } from '@autocatalyst/codex-agent-adapter';
import { claudeProviderKind, claudeSubscriptionAdapterId } from '@autocatalyst/claude-agent-adapter';
import { nativeHistoryLeaseOwner, privateConversationDirectory, type MaterializedExecutionEnvironment,
  type ResolvedAgentRunnerProfile } from '@autocatalyst/execution';
import { applyRunDirective, recordExecutionSession, runWorkflows, startRunLifecycle } from '@autocatalyst/core';
import { createDrizzleDomainRepositories, createSqliteDatabase, DrizzleAgentConversationRepository,
  migrateSqliteDatabase } from '@autocatalyst/persistence';
import { createNativeHistoryLaunch } from './native-history-launch.js';
import { createReviewedAttemptPort } from './reviewed-conversation.js';

// Scripted supervisor models the process boundary, not native execution or OS confinement.
const script = `
const {existsSync, readFileSync, writeFileSync} = require('node:fs');
const {join} = require('node:path');
const [action, a, b, c, d, e] = process.argv.slice(2);
const protocol = 'autocatalyst.native-history.v1';
const emit = row => console.log(JSON.stringify(row));
if (action === 'describe') {
  emit({protocol, provider:a, home:b, executable:join(__dirname, 'native.cjs'),
    version:a === 'codex' ? '0.171.0' : 'subscription:0.3.177:2.1.328',
    sha256:'a'.repeat(64), confinement:'scripted', accountBinding:'binding',
    credentialRevision:'revision', storageNamespace:a, accountEmail:'fixture@example.test',
    historyToolIsolation:'all_launches'});
} else if (action === 'run') {
  if (!existsSync(join(__dirname, a+'.reserved'))) process.exit(11);
  const provider = process.argv[8];
  const home = process.argv[9];
  const actual = provider === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
  if (actual !== home) process.exit(12);
  writeFileSync(join(home, provider === 'codex' ? 'sessions' : 'projects', 'fixture'), 'synthetic');
} else {
  const reserved = join(__dirname, a+'.reserved');
  const sealed = join(__dirname, a+'.sealed');
  const row = {protocol, writerIdentity:a, descendantGroup:b, tenant:c, runId:d, generation:e};
  if (action === 'reserve') writeFileSync(reserved, JSON.stringify(row), {flag:'wx'});
  if (action === 'seal' && existsSync(reserved)) writeFileSync(sealed, readFileSync(reserved));
  if (action === 'reserve') emit({...row, state:'reserved'});
  else if (existsSync(sealed)) emit({...JSON.parse(readFileSync(sealed)), state:'sealed_and_exited'});
  else emit({...row, state:'pid_missing'});
}
`;

async function fixture(action: (fixture: {
  host: { supervisor: string; homes: { codex: string; claude: string } };
  base: string; workspaceRoot: string;
  input: (runId: string, provider?: 'codex' | 'claude') => Promise<Parameters<ReturnType<typeof createNativeHistoryLaunch>['admit']>[0]>;
}) => Promise<void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'history-launch-')));
  const workspaceRoot = join(base, 'managed');
  const host = { supervisor: join(base, 'supervisor.cjs'), homes: { codex: join(base, 'codex'), claude: join(base, 'claude') } };
  try {
    await Promise.all([mkdir(workspaceRoot), ...Object.values(host.homes).map(home => mkdir(home, { mode: 0o700 })),
      writeFile(host.supervisor, '#!' + process.execPath + '\n' + script, { mode: 0o700 }),
      writeFile(join(base, 'native.cjs'), '#!' + process.execPath + '\nconsole.log("2.1.328 (Claude Code)")', { mode: 0o700 })
    ]);
    await action({
      host, base, workspaceRoot,
      async input(runId, provider = 'codex') {
        const runRoot = join(workspaceRoot, runId);
        const repoRoot = join(runRoot, 'repo');
        const scratchRoot = join(runRoot, 'scratch');
        await Promise.all([mkdir(repoRoot, { recursive: true }), mkdir(scratchRoot, { recursive: true })]);
        const workspaceRoots = [repoRoot, scratchRoot];
        const environment: MaterializedExecutionEnvironment = {
          context: { run: { id: runId, workKind: 'feature', currentStep: 'implementation.build', tenant: 'tenant' },
            task: { prompt: 'fixture', inputs: {} }, workspaceIntent: { shape: 'none' }, secretBindings: [],
            skills: { resolved: [], requested: [] }, toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
            capabilityRequirements: { shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: true }, lsp: { requested: false } }
          },
          environment: { variables: { HOME: base }, secretVariableNames: [] },
          workspace: { shape: 'two_roots', repoRoot, scratchRoot, workspaceRoots, branchName: 'work', provisionedBaseRef: 'fixture' },
          toolPolicy: { allowedTools: [], workspaceRoots }, skills: { resolved: [], requested: [] },
          capabilities: { shell: { kind: 'bash', available: false }, paths: { repoRoot, scratchRoot }, lsp: { requested: false, available: false } }
        };
        return { workspaceRoot, generation: 'generation', tenant: 'tenant', referencedScopes: () => new Set(), environment,
          profile: (provider === 'codex' ? { providerKind: codexProviderKind, adapterId: codexBusinessAdapterId }
            : { providerKind: claudeProviderKind, adapterId: claudeSubscriptionAdapterId }) as ResolvedAgentRunnerProfile };
      }
    });
  } finally { await rm(base, { recursive: true, force: true }); }
}

describe('production native history composition', () => {
  it('publishes a supervised scope through the reviewed port and reclaims it after retirement', async () => {
    await fixture(async ({ host, base, input, workspaceRoot }) => {
      const dbPath = join(base, 'control.sqlite');
      const db = createSqliteDatabase({ path: dbPath });
      const nextDb = createSqliteDatabase({ path: dbPath });
      try {
        await migrateSqliteDatabase(db);
        const repos = createDrizzleDomainRepositories(db);
        const tenant = 'tenant';
        const owner = { kind: 'human' as const, id: 'test', tenantId: tenant };
        const project = await repos.projects.create({
          owner, tenant, displayName: 'Fixture', repoUrl: 'https://github.com/test/repo',
          hostRepository: { provider: 'github', owner: 'test', name: 'repo' }, workspaceRootOverride: null,
          issueTrackerSetting: null, codeHostSetting: null, credentialRefs: []
        });
        const conversation = await repos.conversations.create({
          owner, tenant, projectId: project.id, identity: 'test', activeTopicId: null
        });
        const topic = await repos.topics.create({ owner, tenant, conversationId: conversation.id, title: 'Fixture', kind: 'main' });
        const clock = () => new Date().toISOString();
        let work = await startRunLifecycle({ runs: repos.runs, run: { owner, tenant, topicId: topic.id, workKind: 'feature' }, clock });
        while (work.run.currentStep !== 'implementation.build') {
          work = await applyRunDirective({ runs: repos.runs, runId: work.run.id, directive: 'advance', clock });
        }
        const { run, runStep } = work;
        const { environment: original, profile } = await input(run.id);
        if (original.workspace.shape !== 'two_roots') throw new Error('Expected two roots.');
        const ws = { ...original.workspace, branchName: 'work' };
        const environment = { ...original, workspace: ws };
        const git = promisify(execFile);
        const hostRepository = join(base, 'host');
        await mkdir(hostRepository);
        const args = { cwd: hostRepository, env: { ...process.env, GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } };
        await git('git', ['init', '-b', 'main'], args);
        await git('git', ['commit', '--allow-empty', '-m', 'base'], args);
        await git('git', ['worktree', 'add', '-b', ws.branchName, ws.repoRoot], args);
        await repos.runWorkspaceMetadata.upsert({
          runId: run.id, workspaceHandle: ws.branchName, workspaceRepoRoot: ws.repoRoot, createdAt: clock()
        });
        const makePort = (database: typeof db, allow: boolean) => {
          const repository = new DrizzleAgentConversationRepository(database);
          const leases = createNativeHistoryLaunch(host, () => allow);
          return createReviewedAttemptPort({
            repository, workspacesRoot: workspaceRoot, hostRepository, repositoryIdentity: 'test/repo', freshHandoff: 'handoff',
            roleInput: { run, runId: run.id, tenant, role: 'implementer', round: 1,
              reviewedOccurrence: { id: runStep.id, workflow: runWorkflows.feature } },
            prepareFreshConversation: leases.protectFresh(async () => ({ mode: 'fresh_only', verifiedNonPersistence: true })),
            qualifiedBuild: () => allow,
            admit: (environment, generation, profile) => leases.admit({
              environment, generation, profile, tenant, workspaceRoot,
              referencedScopes: () => repository.referencedScopes(tenant, run.id, generation)
            }),
            async reconcileWorkspace(_environment, generation) {
              const referenced = repository.referencedScopes(tenant, run.id, generation);
              await leases.lifecycle.reconcileConversationScopes({ tenant, runId: run.id, runRoot: join(workspaceRoot, run.id),
                keep: scope => referenced.has(scope) });
            }
          })!;
        };
        const port = makePort(db, true);
        const attemptId = 'sess_' + randomUUID();
        const native = await port.prepare({ attemptId, environment, profile, fallback: false });
        if (native?.mode !== 'retained') throw new Error('Expected a supervised retained start.');
        expect(await native.verifyLaunch()).toBe(true);
        const marker = await nativeHistoryLeaseOwner(host.homes.codex);
        expect(marker?.runId).toBe(run.id);
        const writer = native.supervisedProcess!;
        const child = writer.spawn({ command: writer.executable, args: [], cwd: ws.repoRoot, env: {} });
        child.stderr.resume();
        await new Promise<void>((resolve, reject) => child.on('error', reject).on('close', code =>
          code === 0 ? resolve() : reject(new Error('Scripted writer failed.'))));
        native.completed('thread_fixture');
        await recordExecutionSession({ sessions: repos.sessions }, {
          runId: run.id, step: 'implementation.build', phase: 'implementation', role: 'implementer', round: 1, attemptId,
          model: { provider: 'openai', model: 'fixture' }, inferenceSettings: {}, outcome: 'succeeded',
          startedAt: clock(), endedAt: clock(), usageAvailable: false
        });
        await port.finish({ attemptId, accepted: true });
        const ready = new DrizzleAgentConversationRepository(nextDb).readyWorkspaceScopes({
          tenant, runId: run.id, root: ws.repoRoot, branch: ws.branchName
        });
        expect(ready?.scopes.size).toBe(1);
        const scopePath = join(workspaceRoot, run.id, privateConversationDirectory, [...ready!.scopes][0]!);
        expect((await lstat(scopePath)).isDirectory()).toBe(true);
        const restart = makePort(nextDb, true);
        const resumedId = 'sess_' + randomUUID();
        expect(await restart.prepare({ attemptId: resumedId, environment, profile, fallback: false }))
          .toMatchObject({ mode: 'retained', resumeId: 'thread_fixture' });
        // Rejected/retired claims cannot preserve the old history.
        await restart.finish({ attemptId: resumedId, accepted: false });
        await expect(lstat(scopePath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { nextDb.close(); db.close(); }
    });
  }, 10_000);

  it.each(['codex', 'claude'] as const)('leases the dedicated %s home and resumes in the same scope after restart', async provider => {
    await fixture(async ({ host, workspaceRoot, input }) => {
      const work = await input('run_first', provider);
      expect(await createNativeHistoryLaunch(host).admit(work)).toBeUndefined();
      const retained = createNativeHistoryLaunch(host, build => build.provider === provider && build.confinementBuild === 'scripted');
      const opened = await (await retained.admit(work))?.open();
      expect(await opened?.native.verifyLaunch()).toBe(true);
      const cwd = work.environment.workspace.workspaceRoots[1]!;
      const writer = opened!.native.supervisedProcess!;
      const child = writer.spawn({ command: writer.executable, args: [], cwd, env: {} });
      child.stderr.resume();
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject).on('close', code => code === 0 ? resolve() : reject(new Error('Scripted writer failed.')));
      });
      const scope = join(workspaceRoot, 'run_first', privateConversationDirectory, opened!.storageScope);
      const history = provider === 'codex' ? 'sessions' : 'projects';
      expect(await readlink(join(host.homes[provider], history))).toBe(join(scope, history));

      // Even an observed bridge process exit cannot substitute for the host receipt.
      const restarted = createNativeHistoryLaunch(host, () => true);
      expect(await (await restarted.admit(await input('run_competing', provider)))?.open()).toBeUndefined();
      expect(await restarted.lifecycle.reconcileConversationScopes({
        runRoot: join(workspaceRoot, 'run_first'), runId: 'run_first'
      })).toBe(false);

      const handle = randomUUID();
      if (provider === 'claude') {
        const project = join(scope, history, cwd.replace(/[^a-zA-Z0-9]/gu, '-'));
        await mkdir(project);
        await writeFile(join(project, handle + '.jsonl'), JSON.stringify({ type: 'user', cwd, sessionId: handle }) + '\n');
      }
      expect(await opened!.finish?.()).toBe(true);
      expect(await nativeHistoryLeaseOwner(host.homes[provider])).toBeNull();
      const launch = await restarted.admit({ ...work, referencedScopes: () => new Set([opened!.storageScope]) });
      const resume = await launch?.open({ handle, storageScope: opened!.storageScope });
      expect(resume?.storageScope).toBe(opened!.storageScope);
      if (provider === 'claude') {
        expect(await resume?.native.lookupRootSession?.(handle, cwd)).toBe(true);
        expect(await resume?.native.lookupRootSession?.(randomUUID(), cwd)).toBe(false);
      }
      expect(await resume?.finish?.()).toBe(true);
      expect(await restarted.lifecycle.reconcileConversationScopes({
        runRoot: join(workspaceRoot, 'run_first'), runId: 'run_first', tenant: 'tenant'
      })).toBe(true);
      await expect(lstat(scope)).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('reclaims an interrupted lease only from a matching durable receipt', async () => {
    await fixture(async ({ host, base, workspaceRoot, input }) => {
      const work = await input('run_interrupted');
      const launch = createNativeHistoryLaunch(host, () => true);
      const opened = await (await launch.admit(work))?.open();
      const writer = await nativeHistoryLeaseOwner(host.homes.codex);
      expect(writer).not.toBeNull();
      const restart = createNativeHistoryLaunch(host, () => true);
      const evidence = join(base, writer!.writerIdentity + '.sealed');
      const check = () => restart.lifecycle.reconcileConversationScopes({
        runRoot: join(workspaceRoot, writer!.runId), runId: writer!.runId, tenant: writer!.tenant
      });
      const receipt = { protocol: 'autocatalyst.native-history.v1', ...writer, state: 'sealed_and_exited' };
      await writeFile(evidence, JSON.stringify({ ...receipt, descendantGroup: 'other-group' }));
      await restart.recover();
      expect(await check()).toBe(false);
      expect(await nativeHistoryLeaseOwner(host.homes.codex)).not.toBeNull();
      expect(await (await restart.admit(work))?.open()).toBeUndefined();
      const other = await (await restart.admit(await input('run_other', 'claude')))?.open();
      expect(await other?.finish?.()).toBe(true);
      await writeFile(evidence, JSON.stringify(receipt));
      await restart.recover();
      expect(await check()).toBe(true);
      await expect(lstat(join(workspaceRoot, writer!.runId, privateConversationDirectory, opened!.storageScope)))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('protects fresh fallback and pinned publication copies without assigning a lease', async () => {
    await fixture(async ({ host, workspaceRoot, input }) => {
      const { environment, profile } = await input('run_final');
      const launch = createNativeHistoryLaunch({ ...host, supervisor: undefined });
      const fresh = launch.protectFresh(async () => ({ mode: 'fresh_only', verifiedNonPersistence: false }));
      const runRoot = join(workspaceRoot, 'run_final');
      const ws = environment.workspace;
      if (ws.shape !== 'two_roots') throw new Error('Expected two roots.');
      expect(await fresh({ ...environment, workspace: { ...ws, repoRoot: join(ws.scratchRoot, 'review', 'source') } }, profile))
        .toEqual({ mode: 'fresh_only', verifiedNonPersistence: false,
          protectedHistoryRoots: [host.homes.codex, host.homes.claude, join(runRoot, privateConversationDirectory)] });
      await expect(fresh({ ...environment, environment: {
        ...environment.environment, variables: { CODEX_HOME: host.homes.codex }
      } }, profile)).rejects.toThrow('Fresh native login is not isolated');
      expect(await nativeHistoryLeaseOwner(host.homes.codex)).toBeNull();
    });
  });
});
