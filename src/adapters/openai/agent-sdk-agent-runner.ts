import { Agent, run as _run } from '@openai/agents';
import { SandboxAgent, type Capability } from '@openai/agents/sandbox';
import OpenAI from 'openai';
import { performance } from 'node:perf_hooks';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import type { AgentRunEvent, AgentRunRequest, AgentRunner, AgentRoute, AgentSkillRef } from '../../types/ai.js';
import { materializeOpenAIRuntimeSkills } from './openai-runtime-skill-materializer.js';

type RunFn = (agent: unknown, prompt: string) => AsyncIterable<unknown>;

export interface OpenAIAgentSdkAgentRunnerOptions {
  runFn?: RunFn;
  materializeSkills?: (refs: AgentSkillRef[]) => Promise<unknown[]>;
  meter?: Meter;
}

export function skillRefsForRoute(route: AgentRoute): AgentSkillRef[] {
  if (route.task === 'implementation.run') {
    return ['superpowers:writing-plans', 'superpowers:subagent-driven-development'];
  }
  if (route.task === 'issue.triage') {
    return ['mm:issue-triage'];
  }
  if (route.task === 'artifact.create') {
    if (route.intent === 'idea') return ['mm:planning'];
    if (route.intent === 'bug' || route.intent === 'chore') return ['mm:issue-triage'];
  }
  return [];
}

export class OpenAIAgentSdkAgentRunner implements AgentRunner {
  private readonly runFn: RunFn;
  private readonly materializeSkillsFn: (refs: AgentSkillRef[]) => Promise<unknown[]>;
  private readonly _agentTurns: Counter;
  private readonly _adapterLatency: Histogram;
  private readonly _agentRunOutcome: Counter;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string | undefined,
    private readonly defaultModel: string | undefined,
    options?: OpenAIAgentSdkAgentRunnerOptions,
  ) {
    this.runFn = options?.runFn ?? defaultRunFn;
    this.materializeSkillsFn = options?.materializeSkills ?? materializeOpenAIRuntimeSkills;
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
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
    const model = request.profile?.model ?? this.defaultModel ?? 'gpt-4o';
    const refs = skillRefsForRoute(request.route);
    const skillCapabilities = await this.materializeSkillsFn(refs);

    const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey: this.apiKey };
    if (this.baseUrl) {
      clientOptions.baseURL = this.baseUrl;
      clientOptions.defaultHeaders = { 'api-key': this.apiKey };
    }

    const baseInstructions = [
      'You are an AI agent for software development automation.',
      'Work in the provided working directory.',
      request.working_directory ? `Working directory: ${request.working_directory}` : '',
    ].filter(Boolean).join('\n');

    const agent = skillCapabilities.length > 0
      ? new SandboxAgent({
          name: 'autocatalyst-agent',
          model,
          instructions: baseInstructions,
          capabilities: skillCapabilities as Capability[],
        })
      : new Agent({
          name: 'autocatalyst-agent',
          model,
          instructions: baseInstructions,
        });

    const startMs = performance.now();
    let outcome: 'success' | 'error' = 'success';

    try {
      const stream = this.runFn(agent, request.prompt);
      for await (const event of stream) {
        const normalized = normalizeOpenAIEvent(event);
        if (normalized) {
          if (normalized.type === 'assistant') {
            this._agentTurns.add(1, { component: 'openai-agent-sdk', model });
          }
          yield normalized;
        }
      }
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      this._agentRunOutcome.add(1, { component: 'openai-agent-sdk', model, outcome });
      this._adapterLatency.record(performance.now() - startMs, {
        adapter: 'agent-sdk',
        operation: 'run',
        model,
      });
    }
  }
}

function defaultRunFn(agent: unknown, prompt: string): AsyncIterable<unknown> {
  // run() with stream: true returns Promise<StreamedRunResult> which is AsyncIterable<RunStreamEvent>
  return _run(agent as Agent, prompt, { stream: true }) as unknown as AsyncIterable<unknown>;
}

function normalizeOpenAIEvent(event: unknown): AgentRunEvent | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as Record<string, unknown>;

  // RunItemStreamEvent with name 'message_output_created' carries model text output.
  // item.type === 'message_output_item', item.rawItem.content has { type: 'output_text', text }
  if (e['type'] === 'run_item_stream_event' && e['name'] === 'message_output_created') {
    const text = extractTextFromMessageOutputItem(e['item']);
    if (text !== null) {
      return { type: 'assistant', content: [{ type: 'text', text }] };
    }
  }

  if (typeof e['type'] === 'string') {
    return { type: e['type'], ...e } as AgentRunEvent;
  }
  return null;
}

function extractTextFromMessageOutputItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const i = item as Record<string, unknown>;
  const rawItem = i['rawItem'] as Record<string, unknown> | undefined;
  if (!rawItem) return null;
  const content = rawItem['content'];
  if (!Array.isArray(content)) return null;
  const textBlock = (content as Record<string, unknown>[]).find(b => b['type'] === 'output_text');
  if (textBlock && typeof textBlock['text'] === 'string') return textBlock['text'];
  return null;
}
