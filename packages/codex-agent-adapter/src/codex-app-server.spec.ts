import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { runtimeSkillsCatalogRoot } from '@autocatalyst/execution';

import { codexAuthProbe, codexProcessEnvironment, codexSessionLaunch, openCodexAppServer } from './codex-app-server.js';
import type { CodexNativeEvent, CodexSessionLaunchOptions } from './codex-agent-adapter.js';

// A separate executable speaks the wire protocol. No native-session seam or paid model.
const fixture = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli ' + (process.env.AC_MODE === 'version' ? '0.0.0' : '0.160.1')); process.exit(); }
if (process.argv.includes('--sandbox') || process.env.OPENAI_API_KEY) process.exit(7);
let initialized = false, ready = false, sandbox;
function send(value) { process.stdout.write(JSON.stringify(value)+'\\n'); }
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const p=JSON.parse(line), v=p.params;
 const respond=result=>send({id:p.id,result});
 if (p.method === 'initialize') { initialized=true; respond({userAgent:'fixture'}); }
 else if (p.method === 'initialized') ready=true;
 else if (!initialized || !ready) process.exit(8);
 else if (p.method === 'account/read') respond({account:process.env.AC_MODE==='noauth'?null:{type:'chatgpt',planType:process.env.AC_MODE==='plan'?'free':'enterprise_cbp_usage_based'}});
 else if (p.method === 'config/read') respond({config:{mcp_servers:{personal:{command:'must-not-run'}}}});
 else if (p.method === 'thread/start') {
  if (fs.realpathSync(v.cwd) !== fs.realpathSync(process.cwd()) || v.approvalPolicy !== 'never' || v.allowProviderModelFallback !== false) process.exit(9);
  if (v.config['mcp_servers.personal.enabled'] !== false) process.exit(10);
  sandbox=v.sandbox;
  respond({thread:{id:'thread_fixture'},model:v.model,modelProvider:'openai',sandbox:{type:sandbox==='read-only'?'readOnly':'workspaceWrite'}});
 } else if (p.method === 'turn/start') {
  if (process.env.AC_MODE==='hang') return;
  if (v.input.some(i=>i.type==='skill')) fs.writeFileSync('skill-input.json',JSON.stringify(v.input));
  send({method:'item/started',params:{threadId:v.threadId,item:{type:'commandExecution'}}});
  send({method:'item/completed',params:{threadId:v.threadId,item:{type:'commandExecution'}}});
  send({method:'item/completed',params:{threadId:v.threadId,item:{type:'agentMessage',text:process.env.AC_MODE==='badjson'?'not JSON':'{"status":"satisfied","findings":[]}'}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:v.threadId,tokenUsage:{total:{inputTokens:5,outputTokens:3}}}});
  send({method:'turn/completed',params:{threadId:v.threadId,turn:{status:process.env.AC_MODE==='failed'?'failed':'completed'}}});
  respond({turn:{id:'turn_fixture'}});
 } else send({id:p.id,error:{code:-32601,message:'Unexpected method'}});
});
`;

async function withCli(action: (binary: string, cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'codex-wire-'));
  const binary = path.join(cwd, 'codex');
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
      for await (const event of codexSessionLaunch(binary)(launchOptions(cwd))) events.push(event);
      expect(events.map(event => event.type)).toEqual(['skills_delivered', 'tool_call', 'tool_call', 'agent_message', 'result']);
      expect(events.at(-1)?.structuredOutput).toEqual({ status: 'satisfied', findings: [] });
      expect(events.at(-1)?.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    });
  });
  it('passes a real runtime catalog SKILL.md through native skill input', async () => {
    await withCli(async (binary, cwd) => {
      const hostPath = path.join(runtimeSkillsCatalogRoot, 'assets/mm/writing-guidelines');
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
  it('strips API credentials from explicitly supplied process environment', () => {
    const env = codexProcessEnvironment({ OPENAI_API_KEY: 'do-not-forward', OPENAI_BASE_URL: 'https://invalid', CODEX_ACCESS_TOKEN: 'do-not-forward', KEEP: 'safe' });
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['OPENAI_BASE_URL']).toBeUndefined();
    expect(env['CODEX_ACCESS_TOKEN']).toBeUndefined();
    expect(env['KEEP']).toBe('safe');
  });
});
