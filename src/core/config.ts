import { parse as parseYaml } from 'yaml';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import type { WorkflowConfig, LoadedConfig, ModelProvider, AnthropicAuthMethod } from '../types/config.js';
import { generateDefaultWorkflow } from '../config/defaults.js';

export interface ResolvedLlmSettings {
  provider: ModelProvider;
  auth: 'api_key' | 'sso' | 'iam';
  /** Set when provider=anthropic and auth=api_key */
  apiKey?: string;
  /** Set when provider=anthropic and auth=sso and a token was available at resolve time */
  ssoToken?: string;
  /**
   * True when provider=anthropic, auth=sso, and no token was present in the environment.
   * buildDirectModelRunner will call triggerSsoFlow before the first request.
   */
  requiresSsoFlow?: boolean;
  /** Set when provider=bedrock and llm_settings.aws_profile is configured */
  awsProfile?: string;
}

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

  if (config.channels !== undefined) {
    if (!Array.isArray(config.channels)) {
      throw new Error('channels must be an array');
    }
    for (const [index, channel] of config.channels.entries()) {
      if (typeof channel.provider !== 'string' || channel.provider.trim() === '') {
        throw new Error(`channels[${index}].provider must be a non-empty string`);
      }
      if (typeof channel.name !== 'string' || channel.name.trim() === '') {
        throw new Error(`channels[${index}].name must be a non-empty string`);
      }
      if (channel.workspace_root !== undefined && (typeof channel.workspace_root !== 'string' || channel.workspace_root.trim() === '')) {
        throw new Error(`channels[${index}].workspace_root must be a non-empty string`);
      }
      if (channel.config !== undefined && (typeof channel.config !== 'object' || channel.config === null || Array.isArray(channel.config))) {
        throw new Error(`channels[${index}].config must be an object`);
      }
    }
  }

  if (config.publishers !== undefined) {
    if (!Array.isArray(config.publishers)) {
      throw new Error('publishers must be an array');
    }
    for (const [index, publisher] of config.publishers.entries()) {
      if (typeof publisher.provider !== 'string' || publisher.provider.trim() === '') {
        throw new Error(`publishers[${index}].provider must be a non-empty string`);
      }
      if (publisher.artifacts !== undefined && !Array.isArray(publisher.artifacts)) {
        throw new Error(`publishers[${index}].artifacts must be an array`);
      }
      if (publisher.config !== undefined && (typeof publisher.config !== 'object' || publisher.config === null || Array.isArray(publisher.config))) {
        throw new Error(`publishers[${index}].config must be an object`);
      }
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

export function loadConfigFromPath(
  repoPath: string,
  env: Record<string, string | undefined>,
): LoadedConfig {
  const filePath = join(resolve(repoPath), 'WORKFLOW.md');

  if (!existsSync(filePath)) {
    throw new Error('WORKFLOW.md not found at ' + filePath);
  }

  const content = readFileSync(filePath, 'utf-8');
  const { config, promptTemplate } = parseWorkflow(content);
  const { resolved } = resolveEnvVars(config as Record<string, unknown>, env);
  validateConfig(resolved as WorkflowConfig);

  return {
    config: resolved as WorkflowConfig,
    promptTemplate,
    filePath,
  };
}

export function loadConfig(
  filePath: string,
  env: Record<string, string | undefined>,
): LoadedConfig {
  // Derive repoPath from filePath by stripping the filename
  const repoPath = filePath.replace(/\/WORKFLOW\.md$/, '') || '.';
  return loadConfigFromPath(repoPath, env);
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

export function repoNameFromUrl(repo_url: string): string {
  // Strip trailing .git, then normalize SSH colon separator to slash
  const normalized = repo_url.replace(/\.git$/, '').replace(/^[^@]+@[^:]+:/, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(-2).join('/') || 'unknown';
}

/**
 * Resolves the effective AWS profile to use, applying config-level override
 * precedence over the environment variable.
 *
 * Returns undefined when neither source provides a value, leaving existing
 * process.env['AWS_PROFILE'] (if any) unchanged.
 */
export function resolveAwsProfile(
  config: WorkflowConfig,
  env: Record<string, string | undefined>,
): string | undefined {
  if (typeof config.aws_profile === 'string' && config.aws_profile.trim() !== '') {
    return config.aws_profile.trim();
  }
  const envProfile = env['AWS_PROFILE'];
  if (typeof envProfile === 'string' && envProfile.trim() !== '') {
    return envProfile.trim();
  }
  return undefined;
}

/**
 * Resolves the effective LLM settings from WORKFLOW.md config and env vars.
 *
 * llm_settings is required in config. Throws with a clear error message if absent.
 *
 * For SSO with no token: returns { provider: 'anthropic', auth: 'sso', requiresSsoFlow: true }
 * rather than throwing. The SSO flow is triggered lazily in buildDirectModelRunner.
 *
 * Throws for structurally invalid combinations (wrong auth method for provider,
 * unknown provider/auth values, api_key auth with no key, absent llm_settings).
 */
export function resolveLlmSettings(
  config: WorkflowConfig,
  env: Record<string, string | undefined>,
): ResolvedLlmSettings {
  if (!config.llm_settings) {
    throw new Error(
      'llm_settings is required in WORKFLOW.md. Add a provider and auth block to configure the AI provider.',
    );
  }

  const { provider, auth: rawAuth, aws_profile } = config.llm_settings;

  if (provider === 'anthropic') {
    const auth: AnthropicAuthMethod = (rawAuth as AnthropicAuthMethod) ?? 'api_key';
    if (auth === 'api_key') {
      const apiKey = env['AC_ANTHROPIC_API_KEY']?.trim() || undefined;
      if (!apiKey) {
        throw new Error(
          'llm_settings.auth is "api_key" but AC_ANTHROPIC_API_KEY is not set or is empty',
        );
      }
      return { provider, auth, apiKey };
    }
    if (auth === 'sso') {
      const ssoToken = env['AC_ANTHROPIC_SSO_TOKEN']?.trim() || undefined;
      if (!ssoToken) {
        return { provider, auth, requiresSsoFlow: true };
      }
      return { provider, auth, ssoToken };
    }
    throw new Error(
      `Invalid auth method for provider "anthropic": "${rawAuth}". Valid values: api_key, sso`,
    );
  }

  if (provider === 'bedrock') {
    if (rawAuth !== undefined && rawAuth !== 'iam') {
      throw new Error(
        `Invalid auth method for provider "bedrock": "${rawAuth}". Only "iam" is valid (or omit to use the default credential chain)`,
      );
    }
    const awsProfile = aws_profile?.trim() || undefined;
    return { provider, auth: 'iam', awsProfile };
  }

  throw new Error(
    `Unknown llm_settings.provider: "${provider}". Valid values: anthropic, bedrock`,
  );
}
