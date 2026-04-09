import { parse as parseYaml } from 'yaml';
import type { WorkflowConfig } from '../types/config.js';

interface ParseResult {
  config: WorkflowConfig;
  promptTemplate: string;
}

export function parseWorkflow(content: string): ParseResult {
  const fencePattern = /^---\s*\n([\s\S]*?)---\s*\n([\s\S]*)$/;
  const match = content.match(fencePattern);

  if (!match) {
    throw new Error('WORKFLOW.md must contain YAML frontmatter delimited by ---');
  }

  const [, yamlContent, markdownBody] = match;

  const config = yamlContent.trim() === ''
    ? {} as WorkflowConfig
    : parseYaml(yamlContent, { uniqueKeys: true, strict: true }) as WorkflowConfig ?? {};

  return {
    config,
    promptTemplate: markdownBody.trimStart(),
  };
}
