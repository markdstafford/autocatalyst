import { query as _query } from '@anthropic-ai/claude-agent-sdk';
import type {
  EffortLevel,
  Options,
  SDKMessage,
  SDKResultMessage,
  SdkPluginConfig,
  Settings,
  SettingSource,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { Meter, Counter, Histogram } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/api';
import type { LoggerProvider } from '@opentelemetry/api-logs';
import { performance } from 'node:perf_hooks';
import type pino from 'pino';
import type {
  AgentProfile,
  AgentPluginConfig,
  AgentRoute,
  AgentRunContentBlock,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunner,
  AgentSettingSource,
  AgentSkillRef,
  AgentThinking,
} from '../../types/ai.js';
import { createLogger } from '../../core/logger.js';
import { materializeClaudeRuntimeSkillPlugins } from './claude-runtime-skill-materializer.js';
import { buildSandboxEnvironment } from '../sandbox-environment.js';
import { startAnthropicBetaHeaderFilterProxy, type AnthropicBetaHeaderFilterProxy } from './anthropic-beta-header-filter-proxy.js';

type QueryFn = typeof _query;

const MAX_STDERR_LINES = 50;

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|password|credential)\s*[=:]\s*\S+/gi,
  /ghp_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9_]+/g,
  /ghs_[A-Za-z0-9_]+/g,
  /sk-[A-Za-z0-9_-]+/g,
  /xox[bpras]-[A-Za-z0-9-]+/g,
  /xapp-[A-Za-z0-9-]+/g,
  /Authorization:\s*Bearer\s+\S+/gi,
  /ANTHROPIC_CUSTOM_HEADERS[^=]*=\s*api-key:\s*\S+/gi,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }
  return redacted;
}

export interface ClaudeSdkMessageDiagnostic {
  sdk_message_type: string;
  sdk_subtype?: string;
  content_block_types?: string[];
  tool_call_count?: number;
  tool_call_names?: string[];
  tool_result_count?: number;
  is_error?: boolean;
  usage_available?: boolean;
}

export function claudeSdkMessageDiagnostic(message: unknown): ClaudeSdkMessageDiagnostic {
  const msg = message as Record<string, unknown>;
  const type = typeof msg['type'] === 'string' ? msg['type'] : 'unknown';
  const result: ClaudeSdkMessageDiagnostic = { sdk_message_type: type };

  if (typeof msg['subtype'] === 'string') {
    result.sdk_subtype = msg['subtype'];
  }

  if (type === 'assistant') {
    const innerMsg = msg['message'] as Record<string, unknown> | undefined;
    const content = Array.isArray(innerMsg?.['content']) ? innerMsg!['content'] as unknown[] : [];
    result.content_block_types = content
      .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
      .map(b => typeof (b as Record<string, unknown>)['type'] === 'string' ? (b as Record<string, unknown>)['type'] as string : 'unknown');
    const toolUseBlocks = content.filter(
      (b): b is Record<string, unknown> => typeof b === 'object' && Boolean(b) && (b as Record<string, unknown>)['type'] === 'tool_use',
    );
    if (toolUseBlocks.length > 0) {
      result.tool_call_count = toolUseBlocks.length;
      result.tool_call_names = toolUseBlocks
        .map(b => typeof (b as Record<string, unknown>)['name'] === 'string' ? (b as Record<string, unknown>)['name'] as string : 'unknown');
    }
  }

  if (type === 'result') {
    result.is_error = typeof msg['is_error'] === 'boolean' ? msg['is_error'] : undefined;
    result.usage_available = Boolean(msg['usage']);
  }

  return result;
}

const AUTOMATED_ALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'LS',
  'MultiEdit',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
];

const AUTOMATED_PERMISSION_RULES = [
  'Bash(*)',
  'Edit(*)',
  'Glob(*)',
  'Grep(*)',
  'LS(*)',
  'MultiEdit(*)',
  'Read(*)',
  'Task(*)',
  'TodoWrite(*)',
  'WebFetch(*)',
  'WebSearch(*)',
  'Write(*)',
];

export interface ClaudeAgentSdkAgentRunnerOptions {
  queryFn?: QueryFn;
  materializeRuntimeSkills?: (refs: AgentSkillRef[]) => Promise<AgentPluginConfig[]>;
  meter?: Meter;
  sandboxEnvTokens?: string[];
  logDestination?: pino.DestinationStream;
  loggerProvider?: LoggerProvider;
}

export class ClaudeAgentSdkAgentRunner implements AgentRunner {
  private readonly queryFn: QueryFn;
  private readonly materializeRuntimeSkills: (refs: AgentSkillRef[]) => Promise<AgentPluginConfig[]>;
  private readonly _agentTurns: Counter;
  private readonly _adapterLatency: Histogram;
  private readonly _agentRunOutcome: Counter;
  private readonly _agentTokenUsage: Histogram;
  private readonly sandboxEnvTokens: string[];
  private readonly logger: pino.Logger;
  private _betaFilterProxy: Promise<AnthropicBetaHeaderFilterProxy> | null = null;

  constructor(options?: ClaudeAgentSdkAgentRunnerOptions) {
    this.queryFn = options?.queryFn ?? _query;
    this.materializeRuntimeSkills = options?.materializeRuntimeSkills ?? materializeClaudeRuntimeSkillPlugins;
    this.sandboxEnvTokens = options?.sandboxEnvTokens ?? [];
    this.logger = createLogger('claude-agent-sdk', {
      destination: options?.logDestination,
      loggerProvider: options?.loggerProvider,
    });
    const meter = options?.meter ?? metrics.getMeter('autocatalyst');
    this._agentTurns = meter.createCounter('autocatalyst.agent.turns', {
      unit: '{turn}',
      description: 'Agent turns yielded',
    });
    this._adapterLatency = meter.createHistogram('autocatalyst.adapter.latency', {
      unit: 'ms',
      description: 'Latency of adapter operations',
    });
    this._agentRunOutcome = meter.createCounter('autocatalyst.agent.runs', {
      unit: '{run}',
      description: 'Agent runs completed, by outcome',
    });
    this._agentTokenUsage = meter.createHistogram('autocatalyst.agent.token_usage', {
      unit: '{token}',
      description: 'Token usage per agent run',
    });
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    const model = request.profile?.model ?? 'unknown';
    const sandboxEnv = buildSandboxEnvironment(this.sandboxEnvTokens);
    if (isGitHubDependentRoute(request.route) && !sandboxEnv['GH_TOKEN'] && !sandboxEnv['GITHUB_TOKEN']) {
      this.logger.warn(
        {
          event: 'sandbox.no_github_token',
          route_task: request.route.task,
        },
        `Sandbox route ${request.route.task} requires GitHub CLI authentication. Add AC_GH_TOKEN to sandbox.env_tokens in autocatalyst.yaml and set AC_GH_TOKEN before starting Autocatalyst.`,
      );
    }
    const profile = await this.profileWithRuntimeSkillPlugins(request.profile);
    const proxyBaseUrl = await this.betaFilterProxyUrl(profile);
    const effectiveProfile = proxyBaseUrl && profile
      ? { ...profile, base_url: proxyBaseUrl }
      : profile;
    const stderrLines: string[] = [];
    const sdkOptions = makeClaudeAgentSdkOptions(request.working_directory, effectiveProfile, this.sandboxEnvTokens);
    const options = {
      ...sdkOptions,
      ...(process.env['AUTOCATALYST_SDK_DEBUG'] ? { debug: true } : {}),
      stderr: (data: string) => {
        for (const line of data.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) stderrLines.push(trimmed);
        }
        if (stderrLines.length > MAX_STDERR_LINES) {
          stderrLines.splice(0, stderrLines.length - MAX_STDERR_LINES);
        }
      },
    };
    const startMs = performance.now();
    let outcome: 'success' | 'error' | 'incomplete' = 'success';
    let sdkMessageCount = 0;
    let assistantTurnCount = 0;
    let seenTerminalResult = false;
    let terminalDiagnostics: { stderr_excerpt_redacted?: string } | undefined;
    let terminalUsage: { input_tokens: number; output_tokens: number } | undefined;

    this.logger.info(
      {
        event: 'agent.run_started',
        model,
        route_task: request.route.task,
        ...(request.route.stage ? { route_stage: request.route.stage } : {}),
        working_directory: request.working_directory,
      },
      'Claude Agent SDK run started',
    );

    try {
      for await (const message of this.queryFn({
        prompt: request.prompt,
        options,
      })) {
        sdkMessageCount++;
        if ((message as SDKMessage).type === 'result') {
          seenTerminalResult = true;
          const result = message as unknown as SDKResultMessage;
          terminalUsage = { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens };
          const sdkOutcome = result.is_error ? 'error' : 'success';
          this._agentRunOutcome.add(1, { component: 'claude-agent-sdk', model, outcome: sdkOutcome });
          this._agentTokenUsage.record(result.usage.input_tokens, {
            component: 'claude-agent-sdk', model, token_type: 'input',
          });
          this._agentTokenUsage.record(result.usage.output_tokens, {
            component: 'claude-agent-sdk', model, token_type: 'output',
          });
          if (result.is_error && stderrLines.length > 0) {
            this.logger.error(
              {
                event: 'sdk.stderr_on_error',
                route_task: request.route.task,
                model,
                stderr_excerpt: redactSecrets(stderrLines.join('\n')),
              },
              'Claude Code subprocess stderr captured on error exit',
            );
          }
          if (stderrLines.length > 0) {
            terminalDiagnostics = { stderr_excerpt_redacted: redactSecrets(stderrLines.slice(-20).join('\n')) };
          }
        }
        this.logger.debug(
          {
            event: 'agent.sdk_item',
            model,
            route_task: request.route.task,
            ...claudeSdkMessageDiagnostic(message),
          },
          'Claude Agent SDK item',
        );
        const event = normalizeSdkMessage(message as SDKMessage);
        if (event.type === 'assistant') {
          assistantTurnCount++;
          this._agentTurns.add(1, { component: 'claude-agent-sdk', model });
        }
        if ((message as SDKMessage).type === 'result' && terminalDiagnostics) {
          yield { ...event, diagnostics: terminalDiagnostics } as AgentRunEvent;
        } else {
          yield event;
        }
      }
      if (stderrLines.length > 0) {
        this.logger.debug(
          {
            event: 'sdk.stderr',
            route_task: request.route.task,
            model,
            stderr_line_count: stderrLines.length,
            stderr_excerpt: redactSecrets(stderrLines.slice(-5).join('\n')),
          },
          'Claude Code subprocess stderr',
        );
      }
    } catch (err) {
      outcome = 'error';
      this.logger.error(
        {
          event: 'agent.run_failed',
          model,
          route_task: request.route.task,
          error: String(err),
        },
        'Claude Agent SDK run failed',
      );
      throw err;
    } finally {
      if (!seenTerminalResult && outcome !== 'error') {
        outcome = 'incomplete';
        this.logger.warn(
          { event: 'agent.result_missing', model, route_task: request.route.task },
          'Claude Agent SDK completed without a terminal result message',
        );
      }
      this._adapterLatency.record(performance.now() - startMs, { adapter: 'agent-sdk', operation: 'query', model });
      this.logger.info(
        {
          event: 'agent.run_completed',
          model,
          route_task: request.route.task,
          outcome,
          latency_ms: Math.round(performance.now() - startMs),
          assistant_turn_count: assistantTurnCount,
          sdk_message_count: sdkMessageCount,
          input_tokens: terminalUsage?.input_tokens,
          output_tokens: terminalUsage?.output_tokens,
        },
        'Claude Agent SDK run completed',
      );
    }
  }

  private async betaFilterProxyUrl(profile: AgentProfile | undefined): Promise<string | null> {
    if (!profile?.base_url) return null;
    const stripBetaValues = profile.anthropic_beta_header_filter?.strip
      .map(value => value.trim())
      .filter(value => value.length > 0) ?? [];
    if (stripBetaValues.length === 0) return null;

    if (!this._betaFilterProxy) {
      const pending = startAnthropicBetaHeaderFilterProxy(profile.base_url, { stripBetaValues });
      this._betaFilterProxy = pending;
      pending.catch(() => {
        if (this._betaFilterProxy === pending) {
          this._betaFilterProxy = null;
        }
      });
    }
    const proxy = await this._betaFilterProxy;
    return proxy.baseUrl;
  }

  async close(): Promise<void> {
    if (this._betaFilterProxy) {
      try {
        const proxy = await this._betaFilterProxy;
        await proxy.close();
      } catch {
        // proxy never started successfully — nothing to close
      }
      this._betaFilterProxy = null;
    }
  }

  private async profileWithRuntimeSkillPlugins(profile: AgentProfile | undefined): Promise<AgentProfile | undefined> {
    if (!profile) return undefined;
    const requiredSkills = profile.required_skills ?? [];
    if (requiredSkills.length === 0) return profile;
    const runtimeSkillPlugins = await this.materializeRuntimeSkills(requiredSkills);
    return {
      ...profile,
      plugins: [
        ...(profile?.plugins ?? []),
        ...runtimeSkillPlugins,
      ],
    };
  }
}

export function makeClaudeAgentSdkOptions(cwd: string, profile?: AgentProfile, sandboxEnvTokens: string[] = []): Options {
  const settingSources = settingSourcesForProfile(profile);
  return {
    cwd,
    additionalDirectories: [cwd],
    // Autocatalyst invokes this runner only from trusted, pre-routed agent services;
    // bypass mode keeps automated flows from blocking on interactive tool prompts.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: AUTOMATED_ALLOWED_TOOLS,
    tools: { type: 'preset', preset: 'claude_code' },
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settings: automatedSettings(cwd),
    env: {
      PATH: process.env['PATH'] ?? '',
      // HOME is required: Claude Code CLI resolves its own config, plugins, and keybindings
      // from ~/.claude. Without it the CLI cannot load user-level settings and will fail to
      // start. This is an explicit, documented exception to the sandbox-token allowlist —
      // it exposes only Claude Code's own configuration, not general host credential stores.
      HOME: process.env['HOME'] ?? '',
      ...buildSandboxEnvironment(sandboxEnvTokens),
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] ?? '128000',
      ...(profile?.api_key ? { ANTHROPIC_API_KEY: profile.api_key } : {}),
      ...(profile?.base_url ? { ANTHROPIC_BASE_URL: profile.base_url } : {}),
      ...(profile?.api_key && profile?.base_url ? { ANTHROPIC_CUSTOM_HEADERS: `api-key: ${profile.api_key}` } : {}),
    },
    ...(profile?.model ? { model: profile.model } : {}),
    thinking: thinkingForProfile(profile?.thinking),
    effort: (profile?.effort ?? 'high') as EffortLevel,
    settingSources: settingSources as SettingSource[],
    ...(profile?.plugins ? { plugins: profile.plugins as SdkPluginConfig[] } : {}),
  } as Options;
}

function automatedSettings(cwd: string): Settings {
  return {
    permissions: {
      defaultMode: 'bypassPermissions',
      allow: AUTOMATED_PERMISSION_RULES,
      additionalDirectories: [cwd],
    },
  };
}

function normalizeSdkMessage(message: SDKMessage): AgentRunEvent {
  if (message.type === 'assistant') {
    return {
      type: 'assistant',
      content: message.message.content as unknown as AgentRunContentBlock[],
    };
  }
  return { type: message.type };
}

function thinkingForProfile(thinking: AgentThinking | undefined): ThinkingConfig {
  if (!thinking || thinking === 'adaptive') return { type: 'adaptive' };
  if (thinking === 'disabled') return { type: 'disabled' };
  return {
    type: 'enabled',
    ...(thinking.budget_tokens !== undefined ? { budgetTokens: thinking.budget_tokens } : {}),
  };
}

function settingSourcesForProfile(profile: AgentProfile | undefined): AgentSettingSource[] {
  if (profile?.setting_sources) return [...profile.setting_sources];
  if (profile?.load_user_settings === true) return ['user', 'project'];
  return ['project'];
}

function isGitHubDependentRoute(route: AgentRoute): boolean {
  if (route.task === 'issue.triage') return true;
  if (route.task === 'artifact.create' && (route.intent === 'bug' || route.intent === 'chore')) return true;
  return false;
}
