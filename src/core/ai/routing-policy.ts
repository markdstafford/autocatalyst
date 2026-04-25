import type { AgentProfile, AgentRoute, AgentRoutingPolicy, AgentTaskKind } from '../../types/ai.js';

export interface AgentRouteMatch {
  task: AgentTaskKind;
  stage?: AgentRoute['stage'];
  intent?: AgentRoute['intent'];
  artifact_kind?: AgentRoute['artifact_kind'];
}

export interface AgentRouteRegistration {
  match: AgentRouteMatch;
  profile: AgentProfile;
}

export interface DefaultAgentRoutingPolicyOptions {
  defaults: {
    direct: AgentProfile;
    agent: AgentProfile;
  };
  routes?: AgentRouteRegistration[];
}

export class DefaultAgentRoutingPolicy implements AgentRoutingPolicy {
  private readonly defaults: DefaultAgentRoutingPolicyOptions['defaults'];
  private readonly routes: AgentRouteRegistration[];

  constructor(options: DefaultAgentRoutingPolicyOptions) {
    this.defaults = {
      direct: cloneProfile(options.defaults.direct),
      agent: cloneProfile(options.defaults.agent),
    };
    this.routes = (options.routes ?? []).map(route => ({
      match: { ...route.match },
      profile: cloneProfile(route.profile),
    }));
  }

  resolve(route: AgentRoute): AgentProfile {
    const exact = this.routes.find(registration => routeMatches(registration.match, route));
    if (exact) return cloneProfile(exact.profile);
    return cloneProfile(defaultProfileForTask(route.task, this.defaults));
  }
}

function routeMatches(match: AgentRouteMatch, route: AgentRoute): boolean {
  if (match.task !== route.task) return false;
  if (match.stage !== undefined && match.stage !== route.stage) return false;
  if (match.intent !== undefined && match.intent !== route.intent) return false;
  if (match.artifact_kind !== undefined && match.artifact_kind !== route.artifact_kind) return false;
  return true;
}

function defaultProfileForTask(
  task: AgentTaskKind,
  defaults: DefaultAgentRoutingPolicyOptions['defaults'],
): AgentProfile {
  if (task === 'intent.classify') return defaults.direct;
  return defaults.agent;
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    setting_sources: profile.setting_sources ? [...profile.setting_sources] : undefined,
    plugins: profile.plugins ? profile.plugins.map(plugin => ({ ...plugin })) : undefined,
  };
}
