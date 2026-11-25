import type { AgentTokenUsage } from '@autocatalyst/execution';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { createReviewedSpecAuthorResultContract, runtimeSkillsCatalogRoot, type ResolvedAgentRunnerProfile } from '@autocatalyst/execution';

import { codexAuthProbe, codexProcessEnvironment, codexSessionLaunch, openCodexAppServer } from './codex-app-server.js';
import { codexAgentAdapterId, codexProviderKind, createCodexAgentAdapter, type CodexNativeEvent, type CodexSessionLaunchOptions } from './codex-agent-adapter.js';

// A separate executable speaks the wire protocol. No native-session seam or paid model.
const fixture = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli ' + (process.env.AC_MODE === 'version' ? '0.0.0' : '0.171.0')); process.exit(); }
if (process.argv.includes('--sandbox') || process.env.OPENAI_API_KEY) process.exit(7);
let initialized = false, ready = false, sandbox;
function send(value) { process.stdout.write(JSON.stringify(value)+'\\n'); }
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const p=JSON.parse(line), v=p.params;
 const respond=result=>send({id:p.id,result});
 if (p.method === 'initialize') { initialized=true; respond({userAgent:'fixture'}); }
 else if (p.method === 'initialized') ready=true;
 else if (!initialized || !ready) process.exit(8);
 else if (p.method === 'account/read') respond({account:process.env.AC_MODE==='noauth'?null:{type:'chatgpt',planType:process.env.AC_PLAN || (process.env.AC_MODE==='plan'?'free':'enterprise_cbp_usage_based')}});
 else if (p.method === 'config/read') respond({config:{mcp_servers:{personal:{command:'must-not-run'}}}});
 else if (p.method === 'thread/start') {
  if (fs.realpathSync(v.cwd) !== fs.realpathSync(process.cwd()) || v.approvalPolicy !== 'never' || v.allowProviderModelFallback !== false) process.exit(9);
  if (v.config['mcp_servers.personal.enabled'] !== false) process.exit(10);
  sandbox=v.sandbox;
  respond({thread:{id:'thread_fixture'},model:process.env.AC_MODE==='mismatch'?'unexpected':v.model,
    ...(process.env.AC_MODE==='absent' ? {} : {modelProvider:'openai'}),sandbox:{type:sandbox==='read-only'?'readOnly':'workspaceWrite'}});
 } else if (p.method === 'turn/start') {
  fs.writeFileSync('turn-started','yes');
  if (process.env.AC_MODE==='hang') return;
  const counters={inputTokens:100,cachedInputTokens:60,outputTokens:10,reasoningOutputTokens:4};
  if (process.env.AC_MODE==='reviewed-spec' &&
      (sandbox !== 'read-only' || v.sandboxPolicy.type !== 'readOnly' || v.sandboxPolicy.networkAccess !== false)) process.exit(11);
  if (v.input.some(i=>i.type==='skill')) fs.writeFileSync('skill-input.json',JSON.stringify(v.input));
  send({method:'item/started',params:{threadId:v.threadId,turnId:'turn_fixture',item:{type:'commandExecution'}}});
  send({method:'item/completed',params:{threadId:v.threadId,turnId:'turn_fixture',item:{type:'commandExecution'}}});
  send({method:'item/completed',params:{threadId:v.threadId,turnId:'turn_fixture',item:{type:'agentMessage',text:process.env.AC_MODE==='badjson'?'not JSON':(process.env.AC_SPEC_RESULT || '{"status":"satisfied","findings":[]}')}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:v.threadId,turnId:'turn_fixture',tokenUsage:{total:counters,last:counters}}});
  if (process.env.AC_MODE==='timeout-with-usage') { respond({turn:{id:'turn_fixture'}}); return; }
  send({method:'turn/completed',params:{threadId:v.threadId,turn:{id:'turn_fixture',status:process.env.AC_MODE==='failed'?'failed':'completed'}}});
  respond({turn:{id:'turn_fixture'}});
 } else send({id:p.id,error:{code:-32601,message:'Unexpected method'}});
});
`;

async function withCli(action: (binary: string, cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'codex-wire-'));
  const binary = path.join(cwd, 'codex.cjs');
  await writeFile(binary, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  try { await action(binary, cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

function launchOptions(cwd: string, mode = ''): CodexSessionLaunchOptions {
  return { cwd, prompt: 'Review', instructions: 'Return JSON.', model: 'test-model', sandbox: 'read-only',
    auth: { mode: 'enterprise_sign_in' }, env: { AC_MODE: mode }, workspaceRoots: [cwd],
    structuredResult: { schemaId: 'review', resultFile: 'review.json', mechanism: 'codex_app_server_structured_output' } };
}

describe('Codex app-server wire boundary', () => {
  it('uses version/initialize/account/thread/turn and retains notifications before the RPC reply', async () => {
    await withCli(async (binary, cwd) => {
      const events: CodexNativeEvent[] = [];
      let usage: AgentTokenUsage | undefined;
      for await (const event of codexSessionLaunch(binary)({ ...launchOptions(cwd), onUsage: (observed) => { usage = observed; } })) events.push(event);
      expect(events.map(event => event.type)).toEqual(['skills_delivered', 'tool_call', 'tool_call', 'agent_message', 'result']);
      expect(events.at(-1)?.structuredOutput).toEqual({ status: 'satisfied', findings: [] });
      expect(usage).toMatchObject({ tokens: { input: 100, output: 10, cacheRead: 60, cacheWrite: 0 },
        usage: { coverage: 'complete', totals: { freshInput: 40, cacheRead: 60, cacheWrite: 'not_applicable', output: 10, reasoningOutput: 4 },
          groups: [{ model: { provider: 'openai', model: 'test-model' }, requestInputTokens: 100 }] } });
    });
  });
  it.each(['absent', 'mismatch'])('does not start a turn when launch confirmation is %s', async (mode) => {
    await withCli(async (binary, cwd) => {
      await expect((async () => {
        for await (const event of codexSessionLaunch(binary)(launchOptions(cwd, mode))) void event;
      })()).rejects.toThrow();
      await expect(readFile(path.join(cwd, 'turn-started'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
  it('authors a reviewed spec through the native launcher under read-only, network-disabled permissions', async () => {
    await withCli(async (binary, repoRoot) => {
      const scratchRoot = path.join(repoRoot, 'scratch');
      await mkdir(scratchRoot);
      const workspaceRoots = [repoRoot, scratchRoot];
      const allowedTools = ['Read', 'Glob', 'Grep'];
      const skills = { requested: [], resolved: [] };
      const draft = {
        spec: {
          kind: 'feature_spec',
          slug: 'reviewed-draft',
          relativePath: 'context-human/specs/feature-reviewed-draft.md',
          frontmatter: {},
          body: '# Draft\n'
        },
        dispositions: []
      };
      const profile: ResolvedAgentRunnerProfile = {
        mode: 'agent',
        adapterId: codexAgentAdapterId,
        providerKind: codexProviderKind,
        profileName: 'test',
        model: { provider: 'openai', model: 'test-model' },
        inferenceSettings: {},
        endpoint: {},
        connectionMechanism: 'process_environment'
      };
      const adapter = createCodexAgentAdapter({ launchCodexSession: codexSessionLaunch(binary), probeCodexAuth: codexAuthProbe(binary) });
      const session = adapter.startSession({
        profile,
        connection: {
          profile,
          credentialResolved: false,
          createFetchTransport() { throw new Error('Codex uses the subprocess transport'); },
          createProcessLaunchConfig() {
            return {
              environment: { AC_MODE: 'reviewed-spec', AC_SPEC_RESULT: JSON.stringify(draft) },
              secretVariableNames: [], degradedCapabilities: [], redacted: {}
            };
          }
        },
        telemetryContext: { runId: 'run-1', step: 'spec.author', role: 'implementer' },
        structuredResultCapture: {
          step: 'spec.author',
          schemaId: 'autocatalyst.reviewed_spec_author.v1',
          schema: createReviewedSpecAuthorResultContract({ kind: 'feature_spec' }).schema,
          required: true,
          resultFile: 'author.json'
        },
        runInput: {
          environment: {
            context: {
              run: { id: 'run-1', tenant: 'test', workKind: 'feature', currentStep: 'spec.author' },
              task: { prompt: 'Return the draft as JSON.', inputs: {} },
              workspaceIntent: { shape: 'none' },
              secretBindings: [],
              toolPolicy: { allowedTools, workspaceScope: 'declared_workspace' },
              capabilityRequirements: { shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: true }, lsp: { requested: false } },
              skills
            },
            workspace: { shape: 'two_roots', repoRoot, scratchRoot, workspaceRoots, branchName: 'work', provisionedBaseRef: 'origin/main' },
            environment: { variables: {}, secretVariableNames: [] },
            toolPolicy: { allowedTools, workspaceRoots },
            capabilities: { shell: { kind: 'bash', available: true }, paths: { repoRoot, scratchRoot }, lsp: { requested: false, available: false } },
            skills
          }
        }
      });
      const events = [];
      for await (const event of session.events) events.push(event);
      expect(events.at(-1)).toMatchObject({ result: { directive: 'advance' } });
      expect(JSON.parse(await readFile(path.join(scratchRoot, 'author.json'), 'utf8'))).toEqual(draft);
    });
  });

  it('rejects a native launch whose policy does not permit shell', async () => {
    await withCli(async (binary, cwd) => {
      const options = { ...launchOptions(cwd), allowedTools: ['Read'] };
      await expect(codexSessionLaunch(binary)(options)[Symbol.asyncIterator]().next())
        .rejects.toMatchObject({ code: 'tool_policy_unsupported' });
    });
  });

  it('passes a real runtime catalog SKILL.md through native skill input', async () => {
    await withCli(async (binary, cwd) => {
      const hostPath = path.join(runtimeSkillsCatalogRoot, 'assets/mm/plugins/mm/skills/writing-guidelines');
      const options = { ...launchOptions(cwd), skills: [{ ref: 'mm:writing-guidelines', hostPath, sandboxPath: hostPath }] };
      for await (const event of codexSessionLaunch(binary)(options)) void event;
      const inputs = JSON.parse(await readFile(path.join(cwd, 'skill-input.json'), 'utf8'));
      expect(inputs).toContainEqual({ type: 'skill', name: 'mm:writing-guidelines', path: path.join(hostPath, 'SKILL.md') });
    });
  });
  it.each(['failed', 'badjson'])('rejects %s without reporting advance', async mode => {
    await withCli(async (binary, cwd) => {
      const events: CodexNativeEvent[] = [];
      await expect((async () => {
        for await (const event of codexSessionLaunch(binary)(launchOptions(cwd, mode))) events.push(event);
      })()).rejects.toThrow();
      expect(events.some(event => event.type === 'result')).toBe(false);
    });
  });
  it('checks the installed version before opening a session', async () => {
    await withCli(async (binary, cwd) => {
      await expect(openCodexAppServer({ binary, cwd, env: { AC_MODE: 'version' } })).rejects.toThrow();
    });
  });
  it.each([['noauth', 'missing_sign_in'], ['plan', 'disallowed_plan']])('fails closed for %s', async (mode, code) => {
    await withCli(async (binary, cwd) => {
      expect(await codexAuthProbe(binary)({ cwd, env: { AC_MODE: mode ?? '' } })).toEqual({ status: 'unauthenticated', code });
    });
  });
  it('times out and cancels a subprocess that never completes a turn', async () => {
    await withCli(async (binary, cwd) => {
      await expect((async () => {
        for await (const event of codexSessionLaunch(binary)({ ...launchOptions(cwd, 'hang'), timeoutMs: 300 })) void event;
      })()).rejects.toThrow();
      const cancellation = new AbortController();
      const launch = codexSessionLaunch(binary)({ ...launchOptions(cwd, 'hang'), signal: cancellation.signal });
      const pending = launch.next();
      cancellation.abort();
      await expect(pending).rejects.toThrow();
    });
  });
  it('retains owned counters when the turn times out without closure', async () => {
    await withCli(async (binary, cwd) => {
      let usage: AgentTokenUsage | undefined;
      await expect((async () => {
        for await (const event of codexSessionLaunch(binary)({ ...launchOptions(cwd, 'timeout-with-usage'), timeoutMs: 500,
          onUsage: (observed) => { usage = observed; } })) void event;
      })()).rejects.toMatchObject({ code: 'timeout' });
      expect(usage?.usage).toMatchObject({ coverage: 'partial', totals: { freshInput: 40, cacheRead: 60, output: 10 } });
    });
  });
  it('strips API credentials from explicitly supplied process environment', () => {
    const env = codexProcessEnvironment({ OPENAI_API_KEY: 'do-not-forward', OPENAI_BASE_URL: 'https://invalid', CODEX_ACCESS_TOKEN: 'do-not-forward', KEEP: 'safe' });
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['OPENAI_BASE_URL']).toBeUndefined();
    expect(env['CODEX_ACCESS_TOKEN']).toBeUndefined();
    expect(env['KEEP']).toBe('safe');
  });
});


describe('Codex Business authentication', () => {
  it.each(['team', 'business', 'self_serve_business_prolite'])('accepts the explicitly selected Business login (%s)', async plan => {
    await withCli(async (binary, cwd) => {
      expect(await codexAuthProbe(binary, 'business_sign_in')({ cwd, env: { AC_PLAN: plan } })).toEqual({ status: 'authenticated', accountType: 'business' });
      const options = { ...launchOptions(cwd), auth: { mode: 'business_sign_in' as const }, env: { AC_PLAN: plan, OPENAI_API_KEY: 'must-not-forward' } };
      const events: CodexNativeEvent[] = [];
      for await (const event of codexSessionLaunch(binary)(options)) events.push(event);
      expect(events.at(-1)?.type).toBe('result');
    });
  });
  it.each(['free', 'pro', 'enterprise'])('refuses to switch to another plan (%s)', async plan => {
    await withCli(async (binary, cwd) => {
      expect(await codexAuthProbe(binary, 'business_sign_in')({ cwd, env: { AC_PLAN: plan } })).toEqual({ status: 'unauthenticated', code: 'disallowed_plan' });
    });
  });
  it('preserves the Enterprise adapter restriction for existing profiles', async () => {
    await withCli(async (binary, cwd) => {
      expect(await codexAuthProbe(binary)({ cwd, env: { AC_PLAN: 'team' } })).toEqual({ status: 'unauthenticated', code: 'disallowed_plan' });
    });
  });
});
