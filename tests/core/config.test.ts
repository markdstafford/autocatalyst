import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow, resolveEnvVars, validateConfig } from '../../src/core/config.js';

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
      slack: { channel: 'general' },
      custom: 'value',
    })).not.toThrow();
  });
});
