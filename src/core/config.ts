import { parse as parseYaml } from 'yaml';
import { existsSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import type { WorkflowConfig } from '../types/config.js';
import { generateDefaultWorkflow } from '../config/defaults.js';

interface ResolveResult {
  resolved: Record<string, unknown>;
  missing: string[];
}

export function resolveEnvVars(
  obj: Record<string, unknown>,
  env: Record<string, string | undefined>,
): ResolveResult {
  const missing: string[] = [];

  function resolveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      // First replace $$ with a placeholder
      const placeholder = '\x00DOLLAR\x00';
      let result = value.replace(/\$\$/g, placeholder);

      // Replace ${VAR} and $VAR patterns
      result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
        (_match, braced: string | undefined, bare: string | undefined) => {
          const varName = braced ?? bare!;
          const envValue = env[varName];
          if (envValue === undefined || envValue === '') {
            if (!missing.includes(varName)) {
              missing.push(varName);
            }
            return _match;
          }
          return envValue;
        },
      );

      // Restore literal $
      result = result.replace(new RegExp(placeholder, 'g'), '$');
      return result;
    }

    if (Array.isArray(value)) {
      return value.map(resolveValue);
    }

    if (value !== null && typeof value === 'object') {
      return resolveObject(value as Record<string, unknown>);
    }

    return value;
  }

  function resolveObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolveValue(val);
    }
    return result;
  }

  return { resolved: resolveObject(obj), missing };
}

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

export function validateConfig(config: WorkflowConfig): void {
  if (config.polling?.interval_ms !== undefined) {
    if (typeof config.polling.interval_ms !== 'number' || config.polling.interval_ms <= 0) {
      throw new Error('polling.interval_ms must be a positive number');
    }
  }

  if (config.workspace?.root !== undefined) {
    if (typeof config.workspace.root !== 'string' || config.workspace.root.trim() === '') {
      throw new Error('workspace.root must be a non-empty string');
    }
  }
}

export function redactConfig(
  config: Record<string, unknown>,
  resolvedValues: Record<string, string>,
): Record<string, unknown> {
  const secretValues = new Set(Object.values(resolvedValues).filter(v => v.length > 0));

  function redactValue(value: unknown): unknown {
    if (typeof value === 'string' && secretValues.has(value)) {
      return '[from env]';
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (value !== null && typeof value === 'object') {
      return redactObject(value as Record<string, unknown>);
    }
    return value;
  }

  function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = redactValue(val);
    }
    return result;
  }

  return redactObject(config);
}

export function bootstrapWorkflow(repoPath: string): boolean {
  const normalizedPath = resolve(repoPath);
  const workflowPath = join(normalizedPath, 'WORKFLOW.md');

  if (existsSync(workflowPath)) {
    return false; // already exists
  }

  const repoName = basename(normalizedPath);
  const content = generateDefaultWorkflow(repoName);

  writeFileSync(workflowPath, content, 'utf-8');
  return true; // created
}
