import { describe, it, expect } from 'vitest';
import { generateDefaultWorkflow } from '../../src/config/defaults.js';
import { parseWorkflow } from '../../src/core/config.js';

describe('generateDefaultWorkflow', () => {
  it('generates valid YAML frontmatter + Markdown', () => {
    const content = generateDefaultWorkflow('my-repo');
    expect(() => parseWorkflow(content)).not.toThrow();
  });

  it('substitutes repo name in workspace root', () => {
    const content = generateDefaultWorkflow('amp-cli');
    const result = parseWorkflow(content);
    expect(result.config.workspace?.root).toContain('amp-cli');
  });

  it('substitutes repo name in prompt template', () => {
    const content = generateDefaultWorkflow('amp-cli');
    const result = parseWorkflow(content);
    expect(result.promptTemplate).toContain('amp-cli');
  });

  it('includes default polling interval', () => {
    const content = generateDefaultWorkflow('my-repo');
    const result = parseWorkflow(content);
    expect(result.config.polling?.interval_ms).toBe(30000);
  });
});
