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

type QueryFn = typeof _query;

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
    const startMs = performance.now();
    for await (const message of this.queryFn({
      prompt: request.prompt,
      options: makeClaudeAgentSdkOptions(request.working_directory, profile, this.sandboxEnvTokens),
    })) {
      if ((message as SDKMessage).type === 'result') {
        const result = message as unknown as SDKResultMessage;
        const outcome = result.is_error ? 'error' : 'success';
        this._agentRunOutcome.add(1, { component: 'claude-agent-sdk', model, outcome });
        this._agentTokenUsage.record(result.usage.input_tokens, {
          component: 'claude-agent-sdk', model, token_type: 'input',
        });
        this._agentTokenUsage.record(result.usage.output_tokens, {
          component: 'claude-agent-sdk', model, token_type: 'output',
        });
      }
      const event = normalizeSdkMessage(message as SDKMessage);
      if (event.type === 'assistant') {
        this._agentTurns.add(1, { component: 'claude-agent-sdk', model });
      }
      yield event;
    }
    this._adapterLatency.record(performance.now() - startMs, {
      adapter: 'agent-sdk',
      operation: 'query',
      model,
    });
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
