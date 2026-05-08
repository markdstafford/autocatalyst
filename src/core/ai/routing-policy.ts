import type { AgentProfile, AgentRoute, AgentRoutingPolicy, AgentEffort, AgentThinking } from '../../types/ai.js';
import type { AiConfig, ProfileConfig, EndpointConfig, RunnerKind } from '../../types/config.js';
import type { ResolvedCredential } from '../config.js';

export class DefaultAgentRoutingPolicy implements AgentRoutingPolicy {
  private readonly config: AiConfig;

  constructor(config: AiConfig) {
    this.config = config;
  }

  resolve(route: AgentRoute): AgentProfile {
    const profileName = this.config.routing[route.task];
    if (!profileName) {
      throw new Error(`No routing entry for task '${route.task}'`);
    }
    const profile = this.config.profiles.find(p => p.name === profileName)!;
    const endpoint = this.config.endpoints.find(e => e.name === profile.endpoint)!;
    const credential = this.config.credentials.find(c => c.name === endpoint.credential) as ResolvedCredential | undefined;
    return buildAgentProfile(profile, endpoint, credential);
  }
}

function buildAgentProfile(
  profile: ProfileConfig,
  _endpoint: EndpointConfig,
  _credential: ResolvedCredential | undefined,
): AgentProfile {
  return {
    id: profile.name,
    provider: runnerToProvider(profile.runner),
    model: profile.model,
    effort: profile.anthropic?.effort as AgentEffort | undefined,
    thinking: profile.anthropic?.thinking as AgentThinking | undefined,
    plugins: profile.plugins,
  };
}

function runnerToProvider(runner: RunnerKind): string {
  switch (runner) {
    case 'anthropic_direct': return 'anthropic';
    case 'openai_direct': return 'openai';
    case 'claude_agent_sdk': return 'claude_agent_sdk';
    case 'openai_agents': return 'openai_agents';
  }
}
