import { describe, it, expect } from 'vitest';
import type { WorkflowConfig, LoadedConfig } from '../../src/types/config.js';

describe('WorkflowConfig type', () => {
  it('accepts known fields with correct types', () => {
    const config: WorkflowConfig = {
      polling: { interval_ms: 30000 },
      workspace: { root: '~/.autocatalyst/workspaces/my-repo' },
    };
    expect(config.polling?.interval_ms).toBe(30000);
    expect(config.workspace?.root).toBe('~/.autocatalyst/workspaces/my-repo');
  });

  it('accepts unknown keys via index signature', () => {
    const config: WorkflowConfig = {
      polling: { interval_ms: 30000 },
      custom_provider: { channel: 'my-channel', token: '$CUSTOM_TOKEN' },
    };
    expect(config['custom_provider']).toBeDefined();
  });

  it('accepts aws_profile field', () => {
    const config: WorkflowConfig = {
      aws_profile: 'my-profile',
    };
    expect(config.aws_profile).toBe('my-profile');
  });

  it('accepts WorkflowConfig without aws_profile field', () => {
    const config: WorkflowConfig = {
      polling: { interval_ms: 5000 },
    };
    expect(config.aws_profile).toBeUndefined();
  });

  it('accepts provider-owned channel and publisher config blocks', () => {
    const config: WorkflowConfig = {
      channels: [
        { provider: 'chat', name: 'product', config: { token: '$CHAT_TOKEN' } },
      ],
      publishers: [
        { provider: 'documents', artifacts: ['artifact'], config: { database_id: 'db-review' } },
      ],
    };
    expect(config.channels?.[0]?.config?.token).toBe('$CHAT_TOKEN');
    expect(config.publishers?.[0]?.config?.database_id).toBe('db-review');
  });
});

describe('LoadedConfig type', () => {
  it('holds config, prompt template, and file path', () => {
    const loaded: LoadedConfig = {
      config: { polling: { interval_ms: 5000 } },
      promptTemplate: 'You are working on {{ repo_name }}',
      filePath: '/path/to/WORKFLOW.md',
    };
    expect(loaded.promptTemplate).toContain('repo_name');
    expect(loaded.filePath).toContain('WORKFLOW.md');
  });
});
