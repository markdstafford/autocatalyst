import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkflow } from '../../src/core/config.js';

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
