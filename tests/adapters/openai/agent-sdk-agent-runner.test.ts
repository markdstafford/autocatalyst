import { describe, expect, test } from 'vitest';
import { skillRefsForRoute } from '../../../src/adapters/openai/agent-sdk-agent-runner.js';

describe('skillRefsForRoute', () => {
  test('artifact.create / intent:idea → mm:planning', () => {
    expect(skillRefsForRoute({ task: 'artifact.create', intent: 'idea' }))
      .toEqual(['mm:planning']);
  });

  test('artifact.create / intent:bug → mm:issue-triage', () => {
    expect(skillRefsForRoute({ task: 'artifact.create', intent: 'bug' }))
      .toEqual(['mm:issue-triage']);
  });

  test('artifact.create / intent:chore → mm:issue-triage', () => {
    expect(skillRefsForRoute({ task: 'artifact.create', intent: 'chore' }))
      .toEqual(['mm:issue-triage']);
  });

  test('issue.triage → mm:issue-triage', () => {
    expect(skillRefsForRoute({ task: 'issue.triage' }))
      .toEqual(['mm:issue-triage']);
  });

  test('implementation.run → writing-plans + subagent-driven-development', () => {
    expect(skillRefsForRoute({ task: 'implementation.run' }))
      .toEqual(['superpowers:writing-plans', 'superpowers:subagent-driven-development']);
  });

  test('question.answer → no skills', () => {
    expect(skillRefsForRoute({ task: 'question.answer' })).toEqual([]);
  });

  test('artifact.revise → no skills', () => {
    expect(skillRefsForRoute({ task: 'artifact.revise' })).toEqual([]);
  });

  test('intent.classify → no skills', () => {
    expect(skillRefsForRoute({ task: 'intent.classify' })).toEqual([]);
  });

  test('pr.title_generate → no skills', () => {
    expect(skillRefsForRoute({ task: 'pr.title_generate' })).toEqual([]);
  });

  test('artifact.create with no intent → no skills', () => {
    expect(skillRefsForRoute({ task: 'artifact.create' })).toEqual([]);
  });
});
