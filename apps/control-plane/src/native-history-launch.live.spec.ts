import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAgentAdapter } from '@autocatalyst/claude-agent-adapter';
import { createCodexAgentAdapter } from '@autocatalyst/codex-agent-adapter';
import {
  createAgentConnection, nativeHistoryLeaseOwner, privateConversationDirectory, type MaterializedExecutionEnvironment,
  type NativeConversationTurn, type ResolvedAgentRunnerProfile
} from '@autocatalyst/execution';
import { createNativeHistoryLaunch, readNativeHistoryHost } from './native-history-launch.js';
import { createFreshConversationResolver, type RetentionBuild, type VerifiedLaunch } from './reviewed-conversation.js';

const provider = process.env['AUTOCATALYST_LIVE_NATIVE_HISTORY'];

describe.skipIf(provider === undefined)('supervised native history host qualification', () => {
  it('checks the production launch, restart and cleanup against one exact host build', async () => {
    const configuredRoot = process.env['AUTOCATALYST_NATIVE_HISTORY_FIXTURE_ROOT'];
    const model = process.env['AUTOCATALYST_NATIVE_HISTORY_FIXTURE_MODEL'];
    if ((provider !== 'codex' && provider !== 'claude') || !configuredRoot ||
        await realpath(configuredRoot) !== configuredRoot || !basename(configuredRoot).startsWith('ac-native-history-') || !model) {
      throw new Error('Select codex or claude and an isolated, canonical ac-native-history-* directory and model.');
    }
    const host = readNativeHistoryHost(process.env);
    const home = host.homes[provider];
    if (!host.supervisor || !home || await nativeHistoryLeaseOwner(home)) {
      throw new Error('Use a disposable signed-in home without a live lease, and a trusted host supervisor.');
    }
    const ws = await mkdtemp(join(configuredRoot, 'managed-'));
    const runRoot = join(ws, 'run_fixture');
    const repoRoot = join(runRoot, 'repo');
    const scratchRoot = join(runRoot, 'scratch');
    await Promise.all([mkdir(repoRoot, { recursive: true }), mkdir(scratchRoot, { recursive: true })]);
    const adapter = provider === 'codex' ? createCodexAgentAdapter({ authentication: 'business_sign_in' })
      : createClaudeAgentAdapter({ authentication: 'subscription' });
    const profile: ResolvedAgentRunnerProfile = {
      mode: 'agent', providerKind: adapter.providerKind, adapterId: adapter.adapterId,
      profileName: 'native-qualification', model: { model, provider: provider === 'codex' ? 'openai' : 'anthropic' },
      inferenceSettings: { reasoningEffort: 'low' }, connectionMechanism: 'process_environment', endpoint: {}
    };
    const run = { id: 'run_fixture', tenant: 'fixture', workKind: 'enhancement', currentStep: 'implementation.build' } as const;
    const allowedTools = ['bash', 'filesystem'];
    const workspaceRoots = [repoRoot, scratchRoot];
    const environment: MaterializedExecutionEnvironment = {
      context: {
        run, task: { prompt: '', inputs: {} }, workspaceIntent: { shape: 'none' }, secretBindings: [],
        toolPolicy: { allowedTools, workspaceScope: 'declared_workspace' }, skills: { requested: [], resolved: [] },
        capabilityRequirements: {
          shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: true }, lsp: { requested: false }
        }
      },
      workspace: { shape: 'two_roots', repoRoot, scratchRoot, workspaceRoots, branchName: 'enhancement/native-fixture', provisionedBaseRef: 'fixture' },
      environment: { variables: {}, secretVariableNames: [] }, toolPolicy: { allowedTools, workspaceRoots },
      skills: { requested: [], resolved: [] },
      capabilities: { shell: { kind: 'bash', available: false }, paths: { repoRoot, scratchRoot }, lsp: { requested: false, available: false } }
    };
    const references = new Set<string>();
    const input = { environment, profile, tenant: run.tenant, generation: randomUUID(), workspaceRoot: ws,
      referencedScopes: () => references };
    // This opt-in fixture invokes the same composition as the server. Its
    // local observation hook is not available to production configuration.
    let build: RetentionBuild | undefined;
    const launch = () => createNativeHistoryLaunch(host, observed => { build = observed; return true; });
    type Opened = NonNullable<Awaited<ReturnType<VerifiedLaunch['open']>>>;

    async function turn(prompt: string, nativeConversation: NativeConversationTurn, role: 'implementer' | 'reviewer') {
      const telemetryContext = { runId: run.id, step: run.currentStep, role };
      const connection = await createAgentConnection({
        profile, telemetryContext, credentialReference: { required: false },
        credentialResolver: { resolveCredential: async () => undefined }
      });
      const resultFile = `result-${randomUUID()}.txt`;
      try {
        const session = await adapter.startSession({
          profile, connection, telemetryContext,
          runInput: { nativeConversation, environment: { ...environment, context: { ...environment.context,
            task: { prompt, inputs: { outputContract: { resultFile } } }
          } } }
        });
        try {
          let tools = 0;
          let advanced = false;
          for await (const event of session.events) {
            if (event.type === 'runner_terminal_result') advanced = event.result.directive === 'advance';
            if (event.type === 'runner_tool_activity') tools++;
          }
          if (!advanced || (await session.metadata).outcome !== 'succeeded' || tools) {
            throw new Error('Expected a clean tool-free turn.');
          }
          return (await readFile(join(scratchRoot, resultFile), 'utf8')).trim();
        } finally { await session.close?.(); }
      } catch {
        throw new Error('Supervised adapter turn did not produce native qualification evidence.');
      } finally { await connection.close?.(); }
    }

    const retained = async (opened: Opened, prompt: string, role: 'implementer' | 'reviewer', resumeId?: string) => {
      let handle: string | undefined;
      let reply: string;
      let released = false;
      try {
        reply = await turn(prompt, { ...opened.native, mode: 'retained', ...(resumeId ? { resumeId } : {}),
          completed(id) { handle = id; }
        }, role);
      } finally {
        released = await opened.finish?.() === true;
      }
      if (!released) throw new Error('Native writer and descendants were not confirmed exited.');
      expect(handle, 'Retained native completion produced no handle.').toBeDefined();
      expect(await nativeHistoryLeaseOwner(home)).toBeNull();
      return { handle: handle!, reply };
    };

    const start = await (await launch().admit(input))?.open();
    expect(start, 'Host build or custody was not admitted.').toBeDefined();
    const marker = randomUUID();
    const seeded = await retained(start!, `Do not use tools. Remember this secret fixture marker for a later turn. Reply with only ${marker}`, 'implementer');
    expect(seeded.reply === marker, 'The start did not return the synthetic marker.').toBe(true);
    references.add(start!.storageScope);
    const restarted = launch();
    await restarted.recover();
    const reopened = await (await restarted.admit(input))?.open({ handle: seeded.handle, storageScope: start!.storageScope });
    expect(reopened, 'A second launch could not acquire the published scope.').toBeDefined();
    const recalled = await retained(reopened!, 'Without tools or guessing, reply only with the exact fixture marker from the earlier turn.', 'implementer', seeded.handle);
    expect(recalled.reply === marker && recalled.handle === seeded.handle, 'Native resume did not recall the seeded marker.').toBe(true);
    const protectedFresh = await restarted.protectFresh(createFreshConversationResolver())(environment, profile);
    if (provider === 'claude' && !protectedFresh.verifiedNonPersistence) throw new Error('Fresh non-persistence is not verified.');
    const independent = await turn('Without tools, reply only with the earlier fixture marker if present in this conversation, otherwise reply NONE.',
      protectedFresh, 'reviewer');
    expect(independent === 'NONE', 'The new reviewer was not independent.').toBe(true);

    const scope = join(runRoot, privateConversationDirectory, start!.storageScope);
    expect((await lstat(scope)).isDirectory()).toBe(true);
    expect(await restarted.lifecycle.reconcileConversationScopes({ runRoot, runId: run.id, tenant: run.tenant })).toBe(true);
    await expect(lstat(scope)).rejects.toMatchObject({ code: 'ENOENT' });
    console.info('Native history launcher fixture passed (not a full release qualification):', build);
  }, 240_000);
});
