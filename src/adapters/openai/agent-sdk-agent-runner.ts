import type { AgentRoute, AgentSkillRef } from '../../types/ai.js';

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
