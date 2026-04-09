import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow, resolveEnvVars, validateConfig, redactConfig } from '../../src/core/config.js';
import type { WorkflowConfig } from '../../src/types/config.js';

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, '../fixtures', name), 'utf-8');

describe('parseWorkflow', () => {
  it('parses valid YAML frontmatter and Markdown body', () => {
    const result = parseWorkflow(fixture('valid-workflow.md'));
    expect(result.config.polling?.interval_ms).toBe(5000);
    expect(result.config.workspace?.root).toBe('/tmp/workspaces');
    expect(result.promptTemplate).toContain('{{ repo_name }}');
  });

  it('preserves unknown keys', () => {
    const result = parseWorkflow(fixture('valid-workflow.md'));
    expect(result.config['custom_key']).toBe('custom_value');
  });

  it('handles empty frontmatter as config with defaults', () => {
    const result = parseWorkflow(fixture('empty-frontmatter.md'));
    expect(result.config).toEqual({});
    expect(result.promptTemplate).toContain('Just a prompt template.');
  });

  it('throws on file with no frontmatter', () => {
    expect(() => parseWorkflow(fixture('no-frontmatter.md'))).toThrow();
  });

  it('throws on duplicate YAML keys', () => {
    const content = '---\nkey: one\nkey: two\n---\nprompt';
    expect(() => parseWorkflow(content)).toThrow();
  });

  it('handles null values in YAML without crash', () => {
    const content = '---\npolling:\n  interval_ms: null\n---\nprompt';
    const result = parseWorkflow(content);
    expect(result.config.polling?.interval_ms).toBeNull();
  });
});

describe('resolveEnvVars', () => {
  it('resolves $VAR at start of string', () => {
    const result = resolveEnvVars({ key: '$HOME' }, { HOME: '/users/test' });
    expect(result.resolved.key).toBe('/users/test');
    expect(result.missing).toEqual([]);
  });

  it('resolves $VAR in middle of string', () => {
    const result = resolveEnvVars({ key: 'prefix-$VAR-suffix' }, { VAR: 'middle' });
    expect(result.resolved.key).toBe('prefix-middle-suffix');
  });

  it('resolves $VAR at end of string', () => {
    const result = resolveEnvVars({ key: 'hello-$VAR' }, { VAR: 'world' });
    expect(result.resolved.key).toBe('hello-world');
  });

  it('resolves ${VAR} with braces', () => {
    const result = resolveEnvVars({ key: '${MY_VAR}' }, { MY_VAR: 'value' });
    expect(result.resolved.key).toBe('value');
  });

  it('resolves $$ as literal $', () => {
    const result = resolveEnvVars({ key: 'price: $$5' }, {});
    expect(result.resolved.key).toBe('price: $5');
  });

  it('resolves multiple $VAR in one string', () => {
    const result = resolveEnvVars({ key: '$HOST:$PORT' }, { HOST: 'localhost', PORT: '3000' });
    expect(result.resolved.key).toBe('localhost:3000');
  });

  it('does not resolve $VAR in non-string values', () => {
    const result = resolveEnvVars({ count: 42, flag: true }, {});
    expect(result.resolved.count).toBe(42);
    expect(result.resolved.flag).toBe(true);
  });

  it('does not recursively resolve', () => {
    const result = resolveEnvVars({ key: '$FIRST' }, { FIRST: '$SECOND', SECOND: 'final' });
    expect(result.resolved.key).toBe('$SECOND');
  });

  it('treats empty env var as missing', () => {
    const result = resolveEnvVars({ key: '$EMPTY' }, { EMPTY: '' });
    expect(result.missing).toEqual(['EMPTY']);
  });

  it('collects all missing variables', () => {
    const result = resolveEnvVars({ a: '$ONE', b: '$TWO' }, {});
    expect(result.missing).toContain('ONE');
    expect(result.missing).toContain('TWO');
  });

  it('deduplicates repeated missing variables', () => {
    const result = resolveEnvVars({ a: '$X', b: '$X' }, {});
    expect(result.missing).toEqual(['X']);
  });

  it('resolves nested objects recursively', () => {
    const result = resolveEnvVars(
      { slack: { token: '$TOKEN', channel: 'general' } },
      { TOKEN: 'xoxb-123' },
    );
    expect((result.resolved.slack as Record<string, string>).token).toBe('xoxb-123');
    expect((result.resolved.slack as Record<string, string>).channel).toBe('general');
  });
});

describe('validateConfig', () => {
  it('passes for valid config with defaults', () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it('passes for valid config with explicit values', () => {
    expect(() => validateConfig({
      polling: { interval_ms: 5000 },
      workspace: { root: '/tmp/workspaces' },
    })).not.toThrow();
  });

  it('throws for negative interval_ms', () => {
    expect(() => validateConfig({
      polling: { interval_ms: -1 },
    })).toThrow(/interval_ms/);
  });

  it('throws for zero interval_ms', () => {
    expect(() => validateConfig({
      polling: { interval_ms: 0 },
    })).toThrow(/interval_ms/);
  });

  it('throws for non-number interval_ms', () => {
    expect(() => validateConfig({
      polling: { interval_ms: 'fast' as unknown as number },
    })).toThrow(/interval_ms/);
  });

  it('throws for empty workspace root', () => {
    expect(() => validateConfig({
      workspace: { root: '' },
    })).toThrow(/workspace.root/);
  });

  it('does not throw for unknown keys', () => {
    expect(() => validateConfig({
      custom: 'value',
      another_unknown: { nested: true },
    })).not.toThrow();
  });
});

describe('redactConfig', () => {
  it('replaces resolved env var values with [from env]', () => {
    const config = { slack: { token: 'xoxb-secret-123' }, polling: { interval_ms: 5000 } };
    const varValues = { SLACK_BOT_TOKEN: 'xoxb-secret-123' };
    const redacted = redactConfig(config, varValues);
    expect((redacted.slack as Record<string, string>).token).toBe('[from env]');
    expect((redacted.polling as Record<string, number>).interval_ms).toBe(5000);
  });

  it('leaves non-env values untouched', () => {
    const config = { channel: 'general', interval: 5000 };
    const redacted = redactConfig(config, {});
    expect(redacted.channel).toBe('general');
    expect(redacted.interval).toBe(5000);
  });

  it('handles nested objects', () => {
    const config = { outer: { inner: 'secret-value' } };
    const redacted = redactConfig(config, { SECRET: 'secret-value' });
    expect((redacted.outer as Record<string, string>).inner).toBe('[from env]');
  });
});

describe('validateConfig — slack', () => {
  it('passes when slack section is absent', () => {
    expect(() => validateConfig({})).not.toThrow();
  });

  it('passes with all required slack fields present', () => {
    expect(() => validateConfig({
      slack: { bot_token: 'xoxb-test', app_token: 'xapp-test', channel_name: 'my-channel' },
    })).not.toThrow();
  });

  it('throws when bot_token is missing', () => {
    expect(() => validateConfig({
      slack: { app_token: 'xapp-test', channel_name: 'my-channel' },
    })).toThrow(/slack\.bot_token/);
  });

  it('throws when bot_token is empty', () => {
    expect(() => validateConfig({
      slack: { bot_token: '', app_token: 'xapp-test', channel_name: 'my-channel' },
    })).toThrow(/slack\.bot_token/);
  });

  it('throws when app_token is missing', () => {
    expect(() => validateConfig({
      slack: { bot_token: 'xoxb-test', channel_name: 'my-channel' },
    })).toThrow(/slack\.app_token/);
  });

  it('throws when app_token is empty', () => {
    expect(() => validateConfig({
      slack: { bot_token: 'xoxb-test', app_token: '', channel_name: 'my-channel' },
    })).toThrow(/slack\.app_token/);
  });

  it('throws when channel_name is missing', () => {
    expect(() => validateConfig({
      slack: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
    })).toThrow(/slack\.channel_name/);
  });

  it('throws when channel_name is empty', () => {
    expect(() => validateConfig({
      slack: { bot_token: 'xoxb-test', app_token: 'xapp-test', channel_name: '' },
    })).toThrow(/slack\.channel_name/);
  });

  it('$VAR references in bot_token and app_token are resolved before validation', () => {
    const raw = {
      slack: { bot_token: '$AC_SLACK_BOT_TOKEN', app_token: '$AC_SLACK_APP_TOKEN', channel_name: 'ch' },
    };
    const { resolved } = resolveEnvVars(raw, {
      AC_SLACK_BOT_TOKEN: 'xoxb-real',
      AC_SLACK_APP_TOKEN: 'xapp-real',
    });
    // After resolution the values are real tokens; validateConfig should pass
    expect(() => validateConfig(resolved as WorkflowConfig)).not.toThrow();
    expect((resolved as WorkflowConfig).slack?.bot_token).toBe('xoxb-real');
    expect((resolved as WorkflowConfig).slack?.app_token).toBe('xapp-real');
  });

  it('defaults approval_emojis to ["thumbsup"] when absent', () => {
    const config: WorkflowConfig = {
      slack: { bot_token: 'xoxb-test', app_token: 'xapp-test', channel_name: 'ch' },
    };
    validateConfig(config);
    expect(config.slack?.approval_emojis).toEqual(['thumbsup']);
  });

  it('passes when approval_emojis is a non-empty array', () => {
    expect(() => validateConfig({
      slack: {
        bot_token: 'xoxb-test', app_token: 'xapp-test', channel_name: 'ch',
        approval_emojis: ['thumbsup', 'white_check_mark'],
      },
    })).not.toThrow();
  });

  it('throws when approval_emojis is an empty array', () => {
    expect(() => validateConfig({
      slack: {
        bot_token: 'xoxb-test', app_token: 'xapp-test', channel_name: 'ch',
        approval_emojis: [],
      },
    })).toThrow(/slack\.approval_emojis/);
  });
});

describe('redactConfig — slack tokens', () => {
  it('redacts bot_token and app_token values resolved from env', () => {
    const config = {
      slack: { bot_token: 'xoxb-secret', app_token: 'xapp-secret', channel_name: 'ch' },
    };
    const redacted = redactConfig(config, {
      AC_SLACK_BOT_TOKEN: 'xoxb-secret',
      AC_SLACK_APP_TOKEN: 'xapp-secret',
    });
    const slack = redacted.slack as Record<string, string>;
    expect(slack.bot_token).toBe('[from env]');
    expect(slack.app_token).toBe('[from env]');
    expect(slack.channel_name).toBe('ch');
  });
});
