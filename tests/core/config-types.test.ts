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
      slack: { channel: 'my-channel', bot_token: '$SLACK_BOT_TOKEN' },
    };
    expect(config['slack']).toBeDefined();
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

  it('notion block has specs_database_id and testing_guides_database_id (no parent_page_id)', () => {
    const config: WorkflowConfig = {
      notion: {
        integration_token: 'tok_abc',
        specs_database_id: 'db-specs-id',
        testing_guides_database_id: 'db-tg-id',
      },
    };
    expect(config.notion?.specs_database_id).toBe('db-specs-id');
    expect(config.notion?.testing_guides_database_id).toBe('db-tg-id');
    expect(config.notion?.integration_token).toBe('tok_abc');
    // @ts-expect-error parent_page_id should not exist
    expect(config.notion?.parent_page_id).toBeUndefined();
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
