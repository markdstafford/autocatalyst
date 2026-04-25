import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseWorkflow, resolveEnvVars, validateConfig, redactConfig, resolveAwsProfile, repoNameFromUrl, loadConfigFromPath, loadConfig } from '../../src/core/config.js';
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
      { channels: [{ provider: 'chat', config: { token: '$TOKEN', channel: 'general' } }] },
      { TOKEN: 'secret-123' },
    );
    const channels = result.resolved.channels as Array<{ config: Record<string, string> }>;
    expect(channels[0].config.token).toBe('secret-123');
    expect(channels[0].config.channel).toBe('general');
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
      channels: [
        { provider: 'chat', name: 'product', workspace_root: '/tmp/product', config: { token: '$CHAT_TOKEN' } },
      ],
      publishers: [
        { provider: 'documents', artifacts: ['artifact'], config: { database_id: 'db-1' } },
      ],
    })).not.toThrow();
  });

  it('throws when channels is not an array', () => {
    expect(() => validateConfig({
      channels: { provider: 'chat' } as unknown as WorkflowConfig['channels'],
    })).toThrow(/channels must be an array/);
  });

  it('throws when channel provider is missing', () => {
    expect(() => validateConfig({
      channels: [{ provider: '', name: 'product' }],
    })).toThrow(/channels\[0\]\.provider/);
  });

  it('throws when channel name is missing', () => {
    expect(() => validateConfig({
      channels: [{ provider: 'chat', name: '' }],
    })).toThrow(/channels\[0\]\.name/);
  });

  it('throws when channel config is not an object', () => {
    expect(() => validateConfig({
      channels: [{ provider: 'chat', name: 'product', config: [] as unknown as Record<string, unknown> }],
    })).toThrow(/channels\[0\]\.config/);
  });

  it('throws when publishers is not an array', () => {
    expect(() => validateConfig({
      publishers: { provider: 'documents' } as unknown as WorkflowConfig['publishers'],
    })).toThrow(/publishers must be an array/);
  });

  it('throws when publisher provider is missing', () => {
    expect(() => validateConfig({
      publishers: [{ provider: '', artifacts: ['artifact'] }],
    })).toThrow(/publishers\[0\]\.provider/);
  });

  it('throws when publisher artifacts is not an array', () => {
    expect(() => validateConfig({
      publishers: [{ provider: 'documents', artifacts: 'artifact' as unknown as string[] }],
    })).toThrow(/publishers\[0\]\.artifacts/);
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
    const config = { channels: [{ provider: 'chat', config: { token: 'secret-123' } }], polling: { interval_ms: 5000 } };
    const varValues = { CHAT_TOKEN: 'secret-123' };
    const redacted = redactConfig(config, varValues);
    const channels = redacted.channels as Array<{ config: Record<string, string> }>;
    expect(channels[0].config.token).toBe('[from env]');
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

describe('resolveAwsProfile', () => {
  it('returns config value when config aws_profile is set and env AWS_PROFILE is not set', () => {
    const result = resolveAwsProfile({ aws_profile: 'my-profile' }, {});
    expect(result).toBe('my-profile');
  });

  it('returns env value when config aws_profile is not set and env AWS_PROFILE is set', () => {
    const result = resolveAwsProfile({}, { AWS_PROFILE: 'env-profile' });
    expect(result).toBe('env-profile');
  });

  it('returns config value when both config aws_profile and env AWS_PROFILE are set (config wins)', () => {
    const result = resolveAwsProfile({ aws_profile: 'config-profile' }, { AWS_PROFILE: 'env-profile' });
    expect(result).toBe('config-profile');
  });

  it('returns undefined when neither config aws_profile nor env AWS_PROFILE is set', () => {
    const result = resolveAwsProfile({}, {});
    expect(result).toBeUndefined();
  });

  it('treats empty string config aws_profile as absent and falls through to env value', () => {
    const result = resolveAwsProfile({ aws_profile: '' }, { AWS_PROFILE: 'env-profile' });
    expect(result).toBe('env-profile');
  });

  it('treats whitespace-only config aws_profile as absent', () => {
    const result = resolveAwsProfile({ aws_profile: '   ' }, {});
    expect(result).toBeUndefined();
  });

  it('trims leading and trailing whitespace from config aws_profile', () => {
    const result = resolveAwsProfile({ aws_profile: '  trimmed-profile  ' }, {});
    expect(result).toBe('trimmed-profile');
  });
});

describe('repoNameFromUrl', () => {
  it('HTTPS URL without .git', () => {
    expect(repoNameFromUrl('https://example.test/acme-org/autocatalyst')).toBe('acme-org/autocatalyst');
  });

  it('HTTPS URL with .git', () => {
    expect(repoNameFromUrl('https://example.test/acme-org/autocatalyst.git')).toBe('acme-org/autocatalyst');
  });

  it('SSH URL with .git', () => {
    expect(repoNameFromUrl('git@example.test:acme-org/autocatalyst.git')).toBe('acme-org/autocatalyst');
  });

  it('SSH URL without .git', () => {
    expect(repoNameFromUrl('git@example.test:acme-org/autocatalyst')).toBe('acme-org/autocatalyst');
  });

  it('URL with only one path segment falls back gracefully', () => {
    const result = repoNameFromUrl('https://selfhosted/repo');
    expect(result).toMatch(/repo/);
  });
});

describe('loadConfigFromPath', () => {
  it('returns parsed LoadedConfig for a valid repo path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
    try {
      const content = readFileSync(join(import.meta.dirname, '../fixtures', 'valid-workflow.md'), 'utf-8');
      writeFileSync(join(tempDir, 'WORKFLOW.md'), content, 'utf-8');
      const result = loadConfigFromPath(tempDir, {});
      expect(result.config.polling?.interval_ms).toBe(5000);
      expect(result.filePath).toBe(join(tempDir, 'WORKFLOW.md'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('throws with path in message when WORKFLOW.md is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
    rmSync(tempDir, { recursive: true, force: true }); // ensure directory doesn't exist
    expect(() => loadConfigFromPath(tempDir, {})).toThrow(tempDir);
  });

  it('throws with validation details when schema is invalid', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
    try {
      writeFileSync(join(tempDir, 'WORKFLOW.md'), '---\npolling:\n  interval_ms: -1\n---\nprompt\n', 'utf-8');
      expect(() => loadConfigFromPath(tempDir, {})).toThrow(/interval_ms/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loadConfig backward compatibility: same result as loadConfigFromPath', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lcp-test-'));
    try {
      const content = readFileSync(join(import.meta.dirname, '../fixtures', 'valid-workflow.md'), 'utf-8');
      writeFileSync(join(tempDir, 'WORKFLOW.md'), content, 'utf-8');
      const filePath = join(tempDir, 'WORKFLOW.md');
      const result1 = loadConfig(filePath, {});
      const result2 = loadConfigFromPath(tempDir, {});
      expect(result1.config).toEqual(result2.config);
      expect(result1.promptTemplate).toBe(result2.promptTemplate);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
