import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentConnection, type ResolvedAgentRunnerProfile } from '@autocatalyst/execution';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeAgentAdapter } from './claude-agent-adapter.js';

const launchPath = process.env['AUTOCATALYST_LIVE_CLAUDE_NON_PERSISTENCE'];

async function directoryExists(directory: string): Promise<boolean> {
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory()) throw new Error('Expected an isolated history directory, not a link or file.');
  return true;
}

// The pinned CLI writes root and child transcripts as JSONL under projects/.
// Inspect both namespaces without reading transcript contents or following links.
async function transcripts(directory: string): Promise<number> {
  if (!await directoryExists(directory)) return 0;
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked history is not valid fixture evidence.');
    if (entry.isDirectory()) count += await transcripts(child);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) count++;
  }
  return count;
}

describe.skipIf(launchPath === undefined)('isolated Claude native non-persistence', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('executes a fresh turn without writing a transcript in either namespace', async () => {
    if (launchPath !== 'api_key' && launchPath !== 'subscription') {
      throw new Error('Select api_key or subscription for the Claude native fixture.');
    }
    const home = await realpath(homedir());
    const fixtureHome = process.env['AUTOCATALYST_CLAUDE_FIXTURE_HOME'];
    if (!fixtureHome || await realpath(fixtureHome) !== home || process.env['CLAUDE_CONFIG_DIR'] !== undefined) {
      throw new Error('Use a dedicated disposable HOME and unset CLAUDE_CONFIG_DIR before running the fixture.');
    }
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    const modelId = process.env['AUTOCATALYST_CLAUDE_FIXTURE_MODEL']?.trim();
    if (!modelId || (launchPath === 'api_key' && !apiKey)) {
      throw new Error('Set the fixture model and, for api_key, provide an authorized test credential.');
    }

    const defaultConfig = join(home, '.claude');
    const scopedConfig = join(home, '.autocatalyst-claude-fixture-scope');
    const configs = [defaultConfig, scopedConfig];
    const snapshot = () => Promise.all(configs.map(async config =>
      await directoryExists(config) ? transcripts(join(config, 'projects')) : 0));
    expect(await snapshot(), 'Start with empty project histories').toEqual([0, 0]);

    const sdkEntry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    const sdk = JSON.parse(await readFile(join(dirname(sdkEntry), 'package.json'), 'utf8')) as {
      version: string; claudeCodeVersion: string;
    };
    const nativeVersion = launchPath === 'subscription'
      ? /^\d+\.\d+\.\d+(?=\s|$)/u.exec(execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 }))?.[0]
      : sdk.claudeCodeVersion;
    expect(nativeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    console.info(`Claude non-persistence fixture: ${launchPath}, SDK ${sdk.version}, CLI ${nativeVersion}`);

    const scratchRoot = await mkdtemp(join(home, 'ac-claude-non-persistence-'));
    const adapter = createClaudeAgentAdapter({ authentication: launchPath });
    const profile: ResolvedAgentRunnerProfile = {
      mode: 'agent', providerKind: adapter.providerKind, adapterId: adapter.adapterId,
      profileName: 'claude-native-fixture', model: { model: modelId, provider: 'anthropic' },
      inferenceSettings: { reasoningEffort: 'low' }, connectionMechanism: 'process_environment',
      endpoint: launchPath === 'api_key' ? { baseUrl: 'https://api.anthropic.com' } : {}
    };

    async function turn(config: string | undefined, verifiedNonPersistence: boolean) {
      vi.stubEnv('CLAUDE_CONFIG_DIR', config);
      const nonce = randomUUID();
      const resultFile = `${nonce}.txt`;
      const run = { id: nonce, workKind: 'enhancement', currentStep: 'implementation.build', tenant: 'fixture' } as const;
      const telemetryContext = { runId: run.id, step: run.currentStep };
      const connection = await createAgentConnection({
        profile, telemetryContext,
        credentialReference: launchPath === 'api_key' ? { required: true, secretHandle: 'fixture' } : { required: false },
        credentialResolver: { resolveCredential: async () => apiKey }
      });
      try {
        const session = await adapter.startSession({
          profile, connection, telemetryContext,
          runInput: {
            nativeConversation: { mode: 'fresh_only', verifiedNonPersistence },
            environment: {
              context: {
                run, task: { prompt: `Do not use any tools. Reply with exactly this text: ${nonce}`,
                  inputs: { outputContract: { resultFile } } },
                workspaceIntent: { shape: 'none' }, // The fixture supplies the already materialized scratch root.
                secretBindings: [], toolPolicy: { allowedTools: [], workspaceScope: 'declared_workspace' },
                skills: { requested: [], resolved: [] },
                capabilityRequirements: {
                  shell: { kind: 'bash', required: false }, paths: { canonicalWorkspacePaths: true },
                  lsp: { requested: false }
                }
              },
              workspace: { shape: 'scratch_only', scratchRoot, workspaceRoots: [scratchRoot] },
              environment: {
                // The connection supplies an explicit child environment. Do not
                // let the bundled CLI fall back to the host account's home.
                variables: { HOME: home, ...(config ? { CLAUDE_CONFIG_DIR: config } : {}) },
                secretVariableNames: []
              },
              toolPolicy: { allowedTools: [], workspaceRoots: [scratchRoot] },
              skills: { requested: [], resolved: [] },
              capabilities: {
                shell: { kind: 'bash', available: false }, paths: { scratchRoot },
                lsp: { requested: false, available: false }
              }
            }
          }
        });
        try {
          let terminal = false;
          let tools = 0;
          for await (const event of session.events) {
            if (event.type === 'runner_terminal_result' && event.result.directive === 'advance') terminal = true;
            if (event.type === 'runner_tool_activity') tools++;
          }
          const reply = await readFile(join(scratchRoot, resultFile), 'utf8');
          if (!terminal || tools !== 0 || reply.trim() !== nonce || (await session.metadata).outcome !== 'succeeded') {
            throw new Error('Expected a successful tool-free reply to the current prompt.');
          }
        } finally {
          await session.close?.();
        }
      } catch {
        throw new Error('Native fixture turn failed; no non-persistence evidence was established.');
      } finally {
        await connection.close?.();
      }
    }

    const launchConfigs = [undefined, scopedConfig];
    for (const config of launchConfigs) {
      await turn(config, true);
      expect(await snapshot(), 'The non-persistent turn must leave both namespaces empty').toEqual([0, 0]);
    }
    for (const [index, config] of launchConfigs.entries()) {
      // Same launcher without the override must leave a transcript in the
      // expected namespace, or the absence check has not proved anything.
      const before = await snapshot();
      await turn(config, false);
      const control = await snapshot();
      expect(control.some((count, i) => i === index && count > (before[i] ?? 0)),
        'The shipped fresh control must leave a transcript in the selected namespace').toBe(true);
    }
  }, 240_000);
});
