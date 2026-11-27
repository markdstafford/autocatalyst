import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CODEX_SUPPORTED_VERSION, codexBusinessAdapterId, codexProviderKind } from '@autocatalyst/codex-agent-adapter';
import { claudeSubscriptionAdapterId, claudeProviderKind, lookupClaudeRootSession, readClaudeSdkVersion } from '@autocatalyst/claude-agent-adapter';
import {
  acquireNativeHistoryLease, createPrivateConversationScope, createWorkspaceLifecycle,
  nativeHistoryLeaseOwner, privateConversationDirectory, privateConversationScopePath, protectedHistoryRoots,
  releaseNativeHistoryLease, type MaterializedExecutionEnvironment, type ResolvedAgentRunnerProfile,
  type WorkspaceConversationWriter
} from '@autocatalyst/execution';
import { allowsRetention, type PrepareFreshConversation, type RetentionBuild, type VerifiedLaunch } from './reviewed-conversation.js';

type Provider = 'codex' | 'claude';
const exec = promisify(execFile);
const protocol = 'autocatalyst.native-history.v1';
const pinnedClaude = 'subscription:0.3.177:2.1.328';
const id = z.string().min(1).max(256);
const binding = z.object({
  protocol: z.literal(protocol), provider: z.enum(['codex', 'claude']), home: z.string(),
  executable: z.string(), version: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  confinement: id, accountBinding: id, credentialRevision: id, storageNamespace: id,
  historyToolIsolation: z.literal('all_launches'),
  accountEmail: z.string().email().optional()
});
const evidence = z.object({
  protocol: z.literal(protocol), tenant: id, runId: id, generation: id, writerIdentity: id, descendantGroup: id,
  state: z.enum(['reserved', 'sealed_and_exited'])
});

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

async function canonical(path: string): Promise<boolean> {
  return isAbsolute(path) && normalize(path) === path && await realpath(path) === path;
}

/** Paths come only from the host bootstrap, never a profile, prompt, or provider. */
export function readNativeHistoryHost(env: NodeJS.ProcessEnv) {
  return {
    supervisor: env['AUTOCATALYST_NATIVE_HISTORY_SUPERVISOR'],
    homes: {
      codex: env['AUTOCATALYST_CODEX_BUSINESS_HISTORY_HOME'],
      claude: env['AUTOCATALYST_CLAUDE_SUBSCRIPTION_HISTORY_HOME']
    }
  };
}

function providerOf(profile: ResolvedAgentRunnerProfile): Provider | undefined {
  if (profile.providerKind === codexProviderKind && profile.adapterId === codexBusinessAdapterId) return 'codex';
  if (profile.providerKind === claudeProviderKind && profile.adapterId === claudeSubscriptionAdapterId) return 'claude';
  return undefined;
}

function sameWriter(a: Omit<WorkspaceConversationWriter, 'version'>, b: WorkspaceConversationWriter): boolean {
  return a.writerIdentity === b.writerIdentity && a.descendantGroup === b.descendantGroup &&
    a.tenant === b.tenant && a.runId === b.runId && a.generation === b.generation;
}

function writerArgs(writer: WorkspaceConversationWriter): string[] {
  return [writer.writerIdentity, writer.descendantGroup, writer.tenant, writer.runId, writer.generation];
}

type Host = ReturnType<typeof readNativeHistoryHost>;

/** Production supplies no release overrides. Tests exercise this composition with a scripted host supervisor. */
export function createNativeHistoryLaunch(host: Host, qualify: (build: RetentionBuild) => boolean = allowsRetention) {
  const homes = Object.values(host.homes).filter((home): home is string => Boolean(home));
  // Never pass control-plane configuration/secrets to management commands via ambient env.
  const controlEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR'].map(key => [key, process.env[key]]));
  async function supervisorPath(): Promise<string> {
    const program = host.supervisor;
    if (!program || !await canonical(program) || homes.some(home => inside(home, program))) throw new Error('Native supervisor unavailable.');
    const stat = await lstat(program);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || (stat.mode & 0o100) === 0 ||
        (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())) throw new Error('Native supervisor unavailable.');
    return program;
  }
  async function command(program: string, args: readonly string[]): Promise<unknown> {
    const { stdout } = await exec(program, [...args], { env: controlEnv, timeout: 5000, maxBuffer: 8192 });
    return JSON.parse(stdout) as unknown;
  }
  async function confirmed(program: string, action: 'reserve' | 'seal' | 'exited',
    writer: WorkspaceConversationWriter): Promise<boolean> {
    try {
      const row = evidence.parse(await command(program, [action, ...writerArgs(writer)]));
      return sameWriter(row, writer) && row.state === (action === 'reserve' ? 'reserved' : 'sealed_and_exited');
    } catch { return false; }
  }
  async function writerExited(writer: WorkspaceConversationWriter): Promise<boolean> {
    try {
      const program = await supervisorPath();
      if (!await confirmed(program, 'exited', writer)) return false;
      const ownedHomes = writer.provider ? [host.homes[writer.provider]] : homes;
      if (!ownedHomes.length) return false;
      for (const home of ownedHomes) {
        if (!home || (writer.storageHome !== undefined && writer.storageHome !== home)) return false;
        const owner = await nativeHistoryLeaseOwner(home);
        if (owner && sameWriter(owner, writer) && !await releaseNativeHistoryLease({
          home, writerExited: marker => confirmed(program, 'exited', marker)
        })) return false;
      }
      return true;
    } catch { return false; }
  }
  const lifecycle = createWorkspaceLifecycle(writerExited);

  async function recoverHome(home: string) {
    try {
      const owner = await nativeHistoryLeaseOwner(home);
      return !owner || await writerExited(owner);
    } catch { return false; }
  }

  async function protection(environment: MaterializedExecutionEnvironment): Promise<readonly string[] | undefined> {
    const ws = environment.workspace;
    const roots = [...homes];
    for (const home of homes) {
      const resolved = await realpath(home).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return home;
      });
      roots.push(resolved);
    }
    if (ws.shape === 'two_roots') {
      // pr.finalize substitutes a candidate copy for repoRoot, but not scratchRoot.
      const parent = await realpath(dirname(ws.scratchRoot));
      const custody = join(parent, privateConversationDirectory);
      if (homes.length || await lstat(custody).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })) roots.push(custody);
    }
    if (!roots.length) return undefined;
    const verified = protectedHistoryRoots(roots, ws.workspaceRoots);
    if (!verified) throw new Error('Native history tool boundary cannot be established.');
    return verified;
  }

  /** The compatibility path uses its shipped login, never an active dedicated history home. */
  function protectFresh(resolveFresh: PrepareFreshConversation): PrepareFreshConversation {
    return async (environment, profile) => {
      if (!profile || (profile.providerKind !== codexProviderKind && profile.providerKind !== claudeProviderKind)) {
        return resolveFresh(environment, profile);
      }
      const roots = await protection(environment);
      if (!roots) return resolveFresh(environment, profile);
      const vars = environment.environment.variables;
      const codex = profile.providerKind === codexProviderKind;
      const home = vars['HOME'] ?? process.env['HOME'];
      const login = codex ? vars['CODEX_HOME'] ?? (home && join(home, '.codex'))
        : vars['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'] ?? (home && join(home, '.claude'));
      if (!login || !isAbsolute(login)) throw new Error('Fresh native login is not isolated from retained history.');
      const path = await realpath(login).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        // Resolve the parent even before the provider creates its config directory.
        return realpath(dirname(login)).then(parent => join(parent, basename(login)));
      });
      const aliasesHistory = (path: string) => roots.some(dedicated => inside(dedicated, path) || inside(path, dedicated));
      if (aliasesHistory(path)) throw new Error('Fresh native login is not isolated from retained history.');
      for (const directory of codex ? ['sessions', 'archived_sessions'] : ['projects']) {
        const target = await realpath(join(login, directory)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        });
        if (target && aliasesHistory(target)) throw new Error('Fresh native login is not isolated from retained history.');
      }
      return { ...await resolveFresh(environment, profile), protectedHistoryRoots: roots };
    };
  }

  async function admit(input: {
    environment: MaterializedExecutionEnvironment; generation: string; profile: ResolvedAgentRunnerProfile;
    tenant: string; workspaceRoot: string;
    referencedScopes(): ReadonlySet<string>;
  }): Promise<VerifiedLaunch | undefined> {
    const { environment, generation, profile, tenant } = input;
    const ws = environment.workspace;
    const provider = providerOf(profile);
    const home = provider && host.homes[provider];
    if (!provider || !home || ws.shape !== 'two_roots') return undefined;
    const runId = environment.context.run.id;
    const runRoot = await realpath(dirname(ws.repoRoot));
    const workspaceRoot = await realpath(input.workspaceRoot);
    const program = await supervisorPath();
    if (!inside(workspaceRoot, runRoot) || runRoot === workspaceRoot || inside(workspaceRoot, program) ||
        homes.some(dir => inside(workspaceRoot, dir) || inside(dir, workspaceRoot)) ||
        new Set(homes).size !== homes.length || (homes.length === 2 &&
          (inside(homes[0]!, homes[1]!) || inside(homes[1]!, homes[0]!)))) return undefined;
    const describe = async () => {
      if (!await canonical(home)) return undefined;
      const stat = await lstat(home);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return undefined;
      const result = binding.parse(await command(program, ['describe', provider, home]));
      if (result.provider !== provider || result.home !== home || !await canonical(result.executable) ||
          inside(workspaceRoot, result.executable) || homes.some(dir => inside(dir, result.executable))) return undefined;
      return result;
    };
    const descriptor = await describe();
    if (!descriptor || (provider === 'codex' && (descriptor.version !== CODEX_SUPPORTED_VERSION || !descriptor.accountEmail)) ||
        (provider === 'claude' && (descriptor.version !== pinnedClaude || await readClaudeSdkVersion() !== '0.3.177'))) return undefined;
    const build = {
      provider, adapterBuild: profile.adapterId + ':protected-history-v1',
      nativeBuild: [descriptor.version, descriptor.sha256, process.platform, process.arch].join(':'),
      confinementBuild: descriptor.confinement, authMode: provider === 'codex' ? 'business_sign_in' : 'subscription'
    } satisfies RetentionBuild;
    if (!qualify(build)) return undefined;
    const roots = await protection(environment);
    if (!roots) return undefined;
    const reconcile = async () => {
      const live = input.referencedScopes();
      return lifecycle.reconcileConversationScopes({ runId, runRoot, tenant,
        keep: (scope, owner) => owner.generation === generation && live.has(scope) });
    };
    return {
      build, authenticatedBinding: descriptor.accountBinding, credentialRevision: descriptor.credentialRevision,
      storageNamespace: descriptor.storageNamespace,
      async reconcile() { await reconcile(); },
      async open(resume) {
        if (!await reconcile() || !await recoverHome(home)) return undefined;
        const writer = { version: 1, tenant, runId, generation, provider, storageHome: home, writerIdentity: randomUUID(),
          descendantGroup: randomUUID() } as const;
        if (!await confirmed(program, 'reserve', writer)) return undefined;
        let handedOff = false;
        const finish = async () => await confirmed(program, 'seal', writer) && await writerExited(writer);
        try {
          const prior = resume && privateConversationScopePath(runRoot, resume.storageScope);
          if (resume && !prior) return undefined;
          const scope = resume && prior ? { scope: prior, id: resume.storageScope } : await createPrivateConversationScope(runRoot, writer);
          const lease = await acquireNativeHistoryLease({ home, scope: scope.scope, writer, provider,
            // acquire has already claimed its staging directory. Looking for the
            // old home lease here would misread our intentionally incomplete one.
            previousWriterExited: previous => confirmed(program, 'exited', previous)
          });
          if (!lease) return undefined;
          const scopeEnvironment = provider === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home };
          let spawned = false;
          const verifyLaunch = async () => {
            const current = await describe();
            return !spawned && Boolean(current && JSON.stringify(current) === JSON.stringify(descriptor)) && await lease.verify();
          };
          const result: NonNullable<Awaited<ReturnType<VerifiedLaunch['open']>>> = {
            storageScope: scope.id, finish,
            native: {
              scopeEnvironment, protectedHistoryRoots: roots, verifyLaunch,
              async verifyAccount(account) {
                return typeof account === 'object' && account !== null &&
                  (account as Record<string, unknown>)['email'] === descriptor.accountEmail;
              },
              async lookupRootSession(id, cwd) {
                return provider === 'claude' && cwd === ws.scratchRoot && await lookupClaudeRootSession(scope.scope, cwd, id);
              },
              supervisedProcess: {
                executable: descriptor.executable,
                spawn(options) {
                  if (spawned || options.command !== descriptor.executable || !options.cwd ||
                      !ws.workspaceRoots.includes(options.cwd)) throw new Error('Native history writer launch refused.');
                  spawned = true;
                  return spawn(program, ['run', ...writerArgs(writer), provider, home, scope.scope,
                    descriptor.executable, descriptor.sha256, descriptor.confinement, descriptor.accountBinding,
                    descriptor.credentialRevision, descriptor.storageNamespace, '--', ...options.args], {
                    cwd: options.cwd, env: { ...options.env, ...scopeEnvironment }, stdio: 'pipe',
                    ...(options.signal ? { signal: options.signal } : {})
                  });
                }
              }
            }
          };
          handedOff = true;
          return result;
        } finally {
          if (!handedOff) await finish();
        }
      }
    };
  }
  return { admit, protectFresh, lifecycle,
    async recover() { await Promise.all(homes.map(recoverHome)); } };
}
