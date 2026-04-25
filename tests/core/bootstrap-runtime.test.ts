import { describe, expect, it, vi } from 'vitest';
import { bootstrapWorkflowRuntime } from '../../src/core/bootstrap.js';
import type { LoadedConfig } from '../../src/types/config.js';

describe('bootstrapWorkflowRuntime', () => {
  it('creates the orchestrator, registers default commands, and returns a service', () => {
    const config: LoadedConfig = {
      config: {
        workspace: { root: '/tmp/ws' },
        slack: { bot_token: 'xoxb-test', app_token: 'xapp-test', channel_name: 'general' },
      },
      promptTemplate: 'Prompt',
      filePath: '/tmp/WORKFLOW.md',
    };

    const adapter = {
      start: vi.fn(),
      stop: vi.fn(),
      receive: async function* () {},
      resolveChannels: vi.fn(),
      reply: vi.fn(),
      replyError: vi.fn(),
      isConnected: vi.fn().mockReturnValue(true),
    };

    const runtime = bootstrapWorkflowRuntime(config, {
      adapter: adapter as never,
      workspaceManager: {} as never,
      artifactAuthoringAgent: {} as never,
      artifactPublisher: {} as never,
      intentClassifier: { classify: vi.fn().mockResolvedValue('ignore') },
      channelRepoMap: new Map(),
      isConnected: () => adapter.isConnected(),
    });

    expect(runtime.orchestrator).toBeDefined();
    expect(runtime.service).toBeDefined();
    expect(runtime.commandRegistry.has('run.status')).toBe(true);
    expect(runtime.commandRegistry.has('classify-intent')).toBe(true);
  });
});
