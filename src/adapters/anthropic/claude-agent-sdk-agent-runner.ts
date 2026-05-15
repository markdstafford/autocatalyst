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
import { performance } from 'node:perf_hooks';
import type {
  AgentProfile,
  AgentPluginConfig,
  AgentRunContentBlock,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunner,
  AgentSettingSource,
  AgentSkillRef,
  AgentThinking,
} from '../../types/ai.js';
import { materializeClaudeRuntimeSkillPlugins } from './claude-runtime-skill-materializer.js';

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
}

export class ClaudeAgentSdkAgentRunner implements AgentRunner {
  private readonly queryFn: QueryFn;
  private readonly materializeRuntimeSkills: (refs: AgentSkillRef[]) => Promise<AgentPluginConfig[]>;
  private readonly _agentTurns: Counter;
  private readonly _adapterLatency: Histogram;
  private readonly _agentRunOutcome: Counter;
  private readonly _agentTokenUsage: Histogram;

  constructor(options?: ClaudeAgentSdkAgentRunnerOptions) {
    this.queryFn = options?.queryFn ?? _query;
    this.materializeRuntimeSkills = options?.materializeRuntimeSkills ?? materializeClaudeRuntimeSkillPlugins;
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
    const profile = await this.profileWithRuntimeSkillPlugins(request.profile);
    const startMs = performance.now();
    for await (const message of this.queryFn({
      prompt: request.prompt,
      options: makeClaudeAgentSdkOptions(request.working_directory, profile),
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

export function makeClaudeAgentSdkOptions(cwd: string, profile?: AgentProfile): Options {
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
      ...process.env,
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] ?? '128000',
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
