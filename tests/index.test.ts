/**
 * Integration tests for src/index.ts startup modes.
 *
 * Testing top-level module execution requires vi.doMock() (non-hoisted) +
 * vi.resetModules() + dynamic import to re-execute the startup logic per test.
 *
 * The strategy: mock createLogger so we capture log records, then mock enough
 * of the dependency graph to reach the service.starting log line without
 * process.exit(). Downstream failures are caught via .catch(() => {}).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Helper: creates a temp dir with a valid WORKFLOW.md
function makeTempRepo(channelName = 'my-channel', workspaceRoot = '/tmp/ws') {
  const dir = mkdtempSync(join(tmpdir(), 'index-test-'));
  const content = `---\nslack:\n  bot_token: xoxb-test\n  app_token: xapp-test\n  channel_name: ${channelName}\nworkspace:\n  root: ${workspaceRoot}\n---\nPrompt template\n`;
  writeFileSync(join(dir, 'WORKFLOW.md'), content, 'utf-8');
  return dir;
}

function makeMinimalConfig(channelName: string) {
  return {
    config: {
      slack: { bot_token: 'xoxb-test', app_token: 'xapp-test', channel_name: channelName },
      workspace: { root: '/tmp/ws' },
    },
    promptTemplate: 'Prompt',
    filePath: '/tmp/WORKFLOW.md',
  };
}

describe('src/index.ts — startup modes', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];

  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('single --repo: service.starting logged with mode: "single-repo"', async () => {
    const dir = makeTempRepo('my-channel');
    const logRecords: Record<string, unknown>[] = [];

    try {
      const fakeLogger = {
        info: vi.fn().mockImplementation((obj: Record<string, unknown>) => { logRecords.push(obj); }),
        warn: vi.fn().mockImplementation((obj: Record<string, unknown>) => { logRecords.push(obj); }),
        error: vi.fn().mockImplementation((obj: Record<string, unknown>) => { logRecords.push(obj); }),
        debug: vi.fn(),
      };

      vi.doMock('../src/core/logger.js', () => ({
        createLogger: vi.fn().mockReturnValue(fakeLogger),
      }));

      vi.doMock('node:child_process', () => ({
        execSync: vi.fn().mockReturnValue('https://github.com/org/repo.git\n'),
      }));

      vi.doMock('../src/core/init.js', () => ({
        runInit: vi.fn().mockResolvedValue(undefined),
        configExists: vi.fn().mockReturnValue(true),
      }));

      vi.doMock('../src/core/config.js', () => ({
        loadConfig: vi.fn().mockReturnValue(makeMinimalConfig('my-channel')),
        loadConfigFromPath: vi.fn().mockReturnValue(makeMinimalConfig('my-channel')),
        resolveEnvVars: vi.fn().mockReturnValue({ resolved: makeMinimalConfig('my-channel').config, missing: [] }),
        redactConfig: vi.fn().mockReturnValue({}),
        resolveAwsProfile: vi.fn().mockReturnValue(undefined),
        repoNameFromUrl: vi.fn().mockReturnValue('org/repo'),
      }));

      const fakeAdapter = {
        resolveChannels: vi.fn().mockResolvedValue(undefined),
        getChannelId: vi.fn().mockReturnValue('C123'),
        getChannelRepoMap: vi.fn().mockReturnValue(new Map()),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        receive: async function* () {},
        isConnected: vi.fn().mockReturnValue(true),
      };

      vi.doMock('../src/adapters/slack/slack-adapter.js', () => ({
        SlackAdapter: vi.fn().mockImplementation(() => fakeAdapter),
      }));

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({ client: {}, start: vi.fn(), stop: vi.fn() })),
      }));

      vi.doMock('../src/core/workspace-manager.js', () => ({
        WorkspaceManagerImpl: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/core/run-store.js', () => ({
        FileRunStore: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/slack/thread-registry.js', () => ({
        ThreadRegistry: vi.fn().mockImplementation(() => ({})),
      }));

      const fakeOrchestrator = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getRuns: vi.fn().mockReturnValue(new Map()),
        getActiveRunCount: vi.fn().mockReturnValue(0),
        cancelRun: vi.fn(),
        getRunLogs: vi.fn(),
      };

      vi.doMock('../src/core/orchestrator.js', () => ({
        OrchestratorImpl: vi.fn().mockImplementation(() => fakeOrchestrator),
      }));

      vi.doMock('../src/core/command-registry.js', () => ({
        CommandRegistryImpl: vi.fn().mockImplementation(() => ({ register: vi.fn(), get: vi.fn(), list: vi.fn() })),
      }));

      vi.doMock('../src/core/commands/run-commands.js', () => ({
        makeRunStatusHandler: vi.fn().mockReturnValue(vi.fn()),
        makeRunListHandler: vi.fn().mockReturnValue(vi.fn()),
        makeRunCancelHandler: vi.fn().mockReturnValue(vi.fn()),
        makeRunLogsHandler: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/core/commands/meta-commands.js', () => ({
        makeHealthHandler: vi.fn().mockReturnValue(vi.fn()),
        makeHelpHandler: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/core/commands/classify-intent-command.js', () => ({
        makeClassifyIntentHandler: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/adapters/agent/spec-generator.js', () => ({
        AgentSDKSpecGenerator: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/slack/canvas-publisher.js', () => ({
        SlackCanvasPublisher: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/core/service.js', () => ({
        Service: vi.fn().mockImplementation(() => ({
          start: vi.fn(),
          stop: vi.fn().mockResolvedValue(undefined),
          stopped: new Promise(() => {}), // never resolves — keeps service "running"
          updateConfig: vi.fn(),
        })),
      }));

      vi.doMock('../src/core/config-watcher.js', () => ({
        ConfigWatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
      }));

      vi.doMock('../src/core/signals.js', () => ({
        registerSignalHandlers: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
        default: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('@aws-sdk/credential-providers', () => ({
        fromNodeProviderChain: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/adapters/agent/intent-classifier.js', () => ({
        AnthropicIntentClassifier: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/question-answerer.js', () => ({
        AgentSDKQuestionAnswerer: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/implementer.js', () => ({
        AgentSDKImplementer: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/pr-manager.js', () => ({
        GHPRManager: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/issue-manager.js', () => ({
        GHIssueManager: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/issue-filer.js', () => ({
        AgentSDKIssueFiler: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/notion-client.js', () => ({
        NotionClientImpl: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/notion-publisher.js', () => ({
        NotionPublisher: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/notion-feedback-source.js', () => ({
        NotionFeedbackSource: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/spec-committer.js', () => ({
        NotionSpecCommitter: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/implementation-feedback-page.js', () => ({
        NotionImplementationFeedbackPage: vi.fn().mockImplementation(() => ({})),
      }));

      process.argv = ['node', 'index.js', '--repo', dir];

      await import('../src/index.js').catch(() => {});

      const startingLog = logRecords.find(r => r['event'] === 'service.starting');
      expect(startingLog).toBeDefined();
      expect(startingLog!['mode']).toBe('single-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('multi --repo: loadConfigFromPath called once per repo path', async () => {
    const dir1 = makeTempRepo('ch-a');
    const dir2 = makeTempRepo('ch-b');

    try {
      const fakeLogger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      vi.doMock('../src/core/logger.js', () => ({
        createLogger: vi.fn().mockReturnValue(fakeLogger),
      }));

      vi.doMock('node:child_process', () => ({
        execSync: vi.fn().mockReturnValue('https://github.com/org/repo.git\n'),
      }));

      vi.doMock('../src/core/init.js', () => ({
        runInit: vi.fn().mockResolvedValue(undefined),
        configExists: vi.fn().mockReturnValue(true),
      }));

      let callCount = 0;
      const loadConfigFromPathSpy = vi.fn().mockImplementation(() => {
        callCount++;
        const channelName = callCount === 1 ? 'ch-a' : 'ch-b';
        return makeMinimalConfig(channelName);
      });

      vi.doMock('../src/core/config.js', () => ({
        loadConfig: vi.fn().mockReturnValue(makeMinimalConfig('ch-a')),
        loadConfigFromPath: loadConfigFromPathSpy,
        resolveEnvVars: vi.fn().mockReturnValue({ resolved: makeMinimalConfig('ch-a').config, missing: [] }),
        redactConfig: vi.fn().mockReturnValue({}),
        resolveAwsProfile: vi.fn().mockReturnValue(undefined),
        repoNameFromUrl: vi.fn().mockReturnValue('org/repo'),
      }));

      const fakeAdapter = {
        resolveChannels: vi.fn().mockResolvedValue(undefined),
        getChannelId: vi.fn().mockReturnValue('C1'),
        getChannelRepoMap: vi.fn().mockReturnValue(new Map([
          ['CA', { channel_id: 'CA', repo_url: 'url-a', workspace_root: '/tmp/ws' }],
          ['CB', { channel_id: 'CB', repo_url: 'url-b', workspace_root: '/tmp/ws' }],
        ])),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        receive: async function* () {},
        isConnected: vi.fn().mockReturnValue(true),
      };

      vi.doMock('../src/adapters/slack/slack-adapter.js', () => ({
        SlackAdapter: vi.fn().mockImplementation(() => fakeAdapter),
      }));

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({ client: {}, start: vi.fn(), stop: vi.fn() })),
      }));

      vi.doMock('../src/core/workspace-manager.js', () => ({
        WorkspaceManagerImpl: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/core/run-store.js', () => ({
        FileRunStore: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/slack/thread-registry.js', () => ({
        ThreadRegistry: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/core/orchestrator.js', () => ({
        OrchestratorImpl: vi.fn().mockImplementation(() => ({
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          getRuns: vi.fn().mockReturnValue(new Map()),
          getActiveRunCount: vi.fn().mockReturnValue(0),
          cancelRun: vi.fn(),
          getRunLogs: vi.fn(),
        })),
      }));

      vi.doMock('../src/core/command-registry.js', () => ({
        CommandRegistryImpl: vi.fn().mockImplementation(() => ({ register: vi.fn(), get: vi.fn(), list: vi.fn() })),
      }));

      vi.doMock('../src/core/commands/run-commands.js', () => ({
        makeRunStatusHandler: vi.fn().mockReturnValue(vi.fn()),
        makeRunListHandler: vi.fn().mockReturnValue(vi.fn()),
        makeRunCancelHandler: vi.fn().mockReturnValue(vi.fn()),
        makeRunLogsHandler: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/core/commands/meta-commands.js', () => ({
        makeHealthHandler: vi.fn().mockReturnValue(vi.fn()),
        makeHelpHandler: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/core/commands/classify-intent-command.js', () => ({
        makeClassifyIntentHandler: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/adapters/agent/spec-generator.js', () => ({
        AgentSDKSpecGenerator: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/slack/canvas-publisher.js', () => ({
        SlackCanvasPublisher: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/core/service.js', () => ({
        Service: vi.fn().mockImplementation(() => ({
          start: vi.fn(),
          stop: vi.fn().mockResolvedValue(undefined),
          stopped: new Promise(() => {}),
          updateConfig: vi.fn(),
        })),
      }));

      vi.doMock('../src/core/config-watcher.js', () => ({
        ConfigWatcher: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
      }));

      vi.doMock('../src/core/signals.js', () => ({
        registerSignalHandlers: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('@anthropic-ai/bedrock-sdk', () => ({
        default: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('@aws-sdk/credential-providers', () => ({
        fromNodeProviderChain: vi.fn().mockReturnValue(vi.fn()),
      }));

      vi.doMock('../src/adapters/agent/intent-classifier.js', () => ({
        AnthropicIntentClassifier: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/question-answerer.js', () => ({
        AgentSDKQuestionAnswerer: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/implementer.js', () => ({
        AgentSDKImplementer: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/pr-manager.js', () => ({
        GHPRManager: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/issue-manager.js', () => ({
        GHIssueManager: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/agent/issue-filer.js', () => ({
        AgentSDKIssueFiler: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/notion-client.js', () => ({
        NotionClientImpl: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/notion-publisher.js', () => ({
        NotionPublisher: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/notion-feedback-source.js', () => ({
        NotionFeedbackSource: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/spec-committer.js', () => ({
        NotionSpecCommitter: vi.fn().mockImplementation(() => ({})),
      }));

      vi.doMock('../src/adapters/notion/implementation-feedback-page.js', () => ({
        NotionImplementationFeedbackPage: vi.fn().mockImplementation(() => ({})),
      }));

      process.argv = ['node', 'index.js', '--repo', dir1, dir2];

      await import('../src/index.js').catch(() => {});

      expect(loadConfigFromPathSpy).toHaveBeenCalledTimes(2);
      expect(loadConfigFromPathSpy).toHaveBeenCalledWith(dir1, expect.any(Object));
      expect(loadConfigFromPathSpy).toHaveBeenCalledWith(dir2, expect.any(Object));
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
