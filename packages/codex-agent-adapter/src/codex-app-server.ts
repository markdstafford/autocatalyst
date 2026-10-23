import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { ProviderConnectionError, ProviderProtocolError, UnsupportedProviderCapabilityError, runtimeSkillsCatalogRoot } from '@autocatalyst/execution';

import { CodexAuthenticationError, type CodexAuthProbe } from './codex-auth.js';
import type { CodexNativeEvent, CodexSessionLaunch } from './codex-agent-adapter.js';

export const CODEX_SUPPORTED_VERSION = '0.160.1';
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}
function failure(): ProviderConnectionError {
  return new ProviderConnectionError('process_launch_failed', 'Codex app-server protocol or process failed. Check the supported runtime and sign-in.');
}

/** Keep account authentication owned by Codex; never forward API credentials. */
export function codexProcessEnvironment(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (/^(?:OPENAI_|ANTHROPIC_|CODEX_.*(?:TOKEN|KEY)|ACCESS_TOKEN$)/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Version and JSON-RPC boundary used by auth, production turns and no-inference probes. */
export async function openCodexAppServer(options: {
  binary: string; cwd?: string; env?: Readonly<Record<string, string>>;
  timeoutMs?: number; signal?: AbortSignal;
}): Promise<CodexAppServerClient> {
  const env = codexProcessEnvironment(options.env);
  try {
    const version = await promisify(execFile)(options.binary, ['--version'], { env, timeout: 5_000, maxBuffer: 4096 });
    if (version.stdout.trim() !== `codex-cli ${CODEX_SUPPORTED_VERSION}`) throw failure();
  } catch { throw failure(); }
  if (options.signal?.aborted) throw failure();
  const client = new CodexAppServerClient(options.binary, env, options.cwd, options.timeoutMs ?? 30_000, options.signal);
  try {
    await client.rpc('initialize', { clientInfo: { name: 'autocatalyst', title: 'Autocatalyst', version: '0.1.0' } });
    client.notify('initialized', {});
    return client;
  } catch { client.close(); throw failure(); }
}

export class CodexAppServerClient {
  readonly #child;
  readonly #pending = new Map<number, { resolve(value: RecordValue): void; reject(error: Error): void }>();
  readonly #notifications: RecordValue[] = [];
  #wake: (() => void) | undefined;
  #id = 0;
  #error: Error | undefined;
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #abort: () => void;
  readonly #signal: AbortSignal | undefined;
  constructor(binary: string, env: NodeJS.ProcessEnv, cwd: string | undefined, timeoutMs: number, signal?: AbortSignal) {
    this.#child = spawn(binary, [
      'app-server', '--listen', 'stdio://',
      '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
      '--disable', 'plugins', '--disable', 'apps', '--disable', 'hooks',
      '--disable', 'multi_agent', '--disable', 'skill_mcp_dependency_install',
      '--enable', 'skip_host_skill_discovery', '-c', 'web_search="disabled"'
    ], { env, ...(cwd !== undefined ? { cwd } : {}), stdio: ['pipe', 'pipe', 'ignore'] });
    this.#child.stdin.on('error', () => this.#fail());
    this.#child.on('error', () => this.#fail());
    this.#child.on('close', () => this.#fail());
    const lines = createInterface({ input: this.#child.stdout });
    lines.on('line', (line) => {
      if (line.length > 4_000_000) { this.#fail(); return; }
      try {
        const packet = record(JSON.parse(line));
        if (typeof packet['id'] === 'number' && !packet['method']) {
          const pending = this.#pending.get(packet['id']);
          this.#pending.delete(packet['id']);
          if (packet['error']) pending?.reject(failure());
          else pending?.resolve(record(packet['result']));
        } else if (typeof packet['method'] === 'string') {
          // Never approve escalations, shell commands, edits, or dynamic tools.
          if (packet['id'] !== undefined) {
            this.#child.stdin.write(JSON.stringify({ id: packet['id'], error: { code: -32601, message: 'Interactive requests are disabled.' } }) + '\n');
            this.#fail();
          } else {
            if (this.#notifications.length >= 4096) { this.#fail(); return; }
            this.#notifications.push(packet); this.#wake?.();
          }
        }
      } catch { this.#fail(); }
    });
    this.#timer = setTimeout(() => this.#fail(), timeoutMs);
    this.#signal = signal;
    this.#abort = () => this.#fail();
    signal?.addEventListener('abort', this.#abort, { once: true });
  }
  #fail(): void {
    this.#error ??= failure();
    for (const pending of this.#pending.values()) pending.reject(this.#error);
    this.#pending.clear(); this.#wake?.();
    this.close();
  }
  notify(method: string, params: RecordValue): void {
    if (this.#error) throw this.#error;
    this.#child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  rpc(method: string, params: RecordValue): Promise<RecordValue> {
    if (this.#error) return Promise.reject(this.#error);
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async next(): Promise<RecordValue> {
    while (this.#notifications.length === 0) {
      if (this.#error) throw this.#error;
      await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
    const packet = this.#notifications.shift();
    this.#wake = undefined;
    return packet ?? {};
  }
  close(): void {
    clearTimeout(this.#timer);
    this.#signal?.removeEventListener('abort', this.#abort);
    if (this.#child.exitCode === null && !this.#child.killed) this.#child.kill();
  }
}

async function checkAccount(client: CodexAppServerClient): Promise<RecordValue> {
  const response = await client.rpc('account/read', { refreshToken: true });
  const account = record(response['account']);
  if (!account['type']) throw new CodexAuthenticationError('missing_sign_in', 'codex');
  if (account['type'] !== 'chatgpt') throw new CodexAuthenticationError('account_mismatch', 'codex');
  if (!['enterprise', 'enterprise_cbp_usage_based'].includes(String(account['planType']))) {
    throw new CodexAuthenticationError('disallowed_plan', 'codex');
  }
  // Custom upstreams would bypass the explicitly selected enterprise route.
  const config = record((await client.rpc('config/read', { includeLayers: false }))['config']);
  if (Object.keys(record(record(config['model_providers'])['openai'])).length > 0) throw failure();
  const isolation: RecordValue = {};
  for (const name of Object.keys(record(config['mcp_servers']))) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw failure();
    isolation[`mcp_servers.${name}.enabled`] = false;
  }
  return isolation;
}

export function codexAuthProbe(binary: string): CodexAuthProbe {
  return async (input) => {
    const client = await openCodexAppServer({ binary, env: input.env, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}), ...(input.signal !== undefined ? { signal: input.signal } : {}) });
    try { await checkAccount(client); return { status: 'authenticated', accountType: 'enterprise' }; }
    catch (error) {
      if (error instanceof CodexAuthenticationError) return { status: 'unauthenticated', code: error.authFailureCode };
      throw error;
    } finally { client.close(); }
  };
}

export function codexSandboxPolicy(sandbox: 'read-only' | 'workspace-write', roots: readonly string[]): RecordValue {
  return sandbox === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [...roots], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

export function codexSessionLaunch(binary: string): CodexSessionLaunch {
  return async function* (options): AsyncIterable<CodexNativeEvent> {
    if (options.allowedTools !== undefined && !options.allowedTools.includes('shell')) {
      throw new UnsupportedProviderCapabilityError('tool_policy_unsupported', 'Codex requires a tool policy permitting its native shell.');
    }
    const client = await openCodexAppServer({ binary, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}), timeoutMs: options.timeoutMs ?? 600_000,
      ...(options.signal !== undefined ? { signal: options.signal } : {}) });
    try {
      const isolation = await checkAccount(client);
      for (const skill of options.skills ?? []) {
        const actual = await realpath(skill.hostPath);
        const root = await realpath(runtimeSkillsCatalogRoot);
        if (!actual.startsWith(root + path.sep)) throw failure();
        await readFile(path.join(actual, 'SKILL.md'), 'utf8');
      }
      const response = await client.rpc('thread/start', {
        cwd: options.cwd, model: options.model, modelProvider: 'openai', allowProviderModelFallback: false,
        approvalPolicy: 'never', sandbox: options.sandbox, ephemeral: true,
        baseInstructions: options.instructions,
        config: { ...options.config, ...isolation, 'sandbox_workspace_write.writable_roots': options.workspaceRoots ?? [],
          'sandbox_workspace_write.network_access': false, 'sandbox_workspace_write.exclude_slash_tmp': true,
          'sandbox_workspace_write.exclude_tmpdir_env_var': true }
      });
      const thread = record(response['thread']);
      if (typeof thread['id'] !== 'string' || response['modelProvider'] !== 'openai' || response['model'] !== options.model) throw failure();
      const sandbox = record(response['sandbox']);
      const expected = options.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite';
      if (sandbox['type'] !== expected) throw failure();
      await client.rpc('turn/start', {
        threadId: thread['id'], sandboxPolicy: codexSandboxPolicy(options.sandbox, options.workspaceRoots ?? []), input: [
          { type: 'text', text: options.prompt, text_elements: [] },
          ...(options.skills ?? []).map(skill => ({ type: 'skill', name: skill.ref, path: path.join(skill.hostPath, 'SKILL.md') }))
        ]
      });
      yield { type: 'skills_delivered', refs: (options.skills ?? []).map(skill => skill.ref) };
      let finalText: string | undefined;
      let usage: { input_tokens?: number; output_tokens?: number } | undefined;
      while (true) {
        const packet = await client.next(); const params = record(packet['params']);
        if (params['threadId'] !== thread['id']) continue;
        if (packet['method'] === 'item/completed' || packet['method'] === 'item/started') {
          const item = record(params['item']);
          if (packet['method'] === 'item/completed' && item['type'] === 'agentMessage' && typeof item['text'] === 'string') {
            finalText = item['text']; yield { type: 'agent_message', content: finalText };
          } else if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(String(item['type']))) {
            yield { type: 'tool_call', tool: { name: String(item['type']) }, completed: packet['method'] === 'item/completed' };
          }
        } else if (packet['method'] === 'thread/tokenUsage/updated') {
          const total = record(record(params['tokenUsage'])['total']);
          if (typeof total['inputTokens'] === 'number' && typeof total['outputTokens'] === 'number') {
            usage = { input_tokens: total['inputTokens'], output_tokens: total['outputTokens'] };
          }
        } else if (packet['method'] === 'turn/completed') {
          if (record(params['turn'])['status'] !== 'completed') throw failure();
          if (finalText === undefined) throw new ProviderProtocolError('missing_structured_result', 'Codex completed without a final assistant message.');
          let structuredOutput: unknown;
          if (options.structuredResult !== undefined) {
            try { structuredOutput = JSON.parse(finalText); }
            catch { throw new ProviderProtocolError('structured_result_invalid', 'Codex final output is not JSON.'); }
          }
          yield { type: 'result', ...(structuredOutput !== undefined ? { structuredOutput } : {}),
            ...(usage !== undefined ? { usage } : {}), result: { directive: 'advance', output: finalText } };
          return;
        }
      }
    } catch (error) {
      if (error instanceof CodexAuthenticationError || error instanceof ProviderProtocolError || error instanceof ProviderConnectionError) throw error;
      throw failure();
    } finally { client.close(); }
  };
}
