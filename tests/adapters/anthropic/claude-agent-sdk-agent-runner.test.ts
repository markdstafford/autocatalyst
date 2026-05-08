import { describe, expect, test, vi } from 'vitest';
import { ClaudeAgentSdkAgentRunner } from '../../../src/adapters/anthropic/claude-agent-sdk-agent-runner.js';
import type { AgentRunEvent } from '../../../src/types/ai.js';

async function collect(events: AsyncIterable<AgentRunEvent>): Promise<AgentRunEvent[]> {
  const collected: AgentRunEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('ClaudeAgentSdkAgentRunner', () => {
  test('passes route profile values to Claude Agent SDK options with adaptive thinking', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } };
    });
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn });

    const events = await collect(runner.run({
      route: { task: 'implementation.run' },
      working_directory: '/tmp/workspace',
      prompt: 'implement',
      profile: {
        id: 'impl',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        thinking: 'adaptive',
        setting_sources: ['project'],
      },
    }));

    expect(events).toEqual([{ type: 'assistant', content: [{ type: 'text', text: 'done' }] }]);
    expect(queryFn).toHaveBeenCalledWith({
      prompt: 'implement',
      options: expect.objectContaining({
        cwd: '/tmp/workspace',
        model: 'claude-sonnet-4-5',
        effort: 'medium',
        thinking: { type: 'adaptive' },
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: expect.arrayContaining(['Bash', 'Write', 'Read', 'Edit']),
        settings: expect.objectContaining({
          permissions: expect.objectContaining({
            defaultMode: 'bypassPermissions',
            allow: expect.arrayContaining(['Bash(*)', 'Write(*)', 'Read(*)', 'Edit(*)']),
            additionalDirectories: ['/tmp/workspace'],
          }),
        }),
      }),
    });
  });

  test('materializes required skills as explicit plugins without user settings', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success' };
    });
    const materializeRuntimeSkills = vi.fn().mockResolvedValue([{ type: 'local' as const, path: '/plugins/mm-runtime' }]);
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, materializeRuntimeSkills });

    await collect(runner.run({
      route: { task: 'artifact.create', stage: 'new_thread', intent: 'idea', artifact_kind: 'feature_spec' },
      working_directory: '/tmp/workspace',
      prompt: '/mm:planning',
      profile: {
        id: 'artifact',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'high',
        required_skills: ['mm:planning'],
      },
    }));

    expect(materializeRuntimeSkills).toHaveBeenCalledWith(['mm:planning']);
    expect(queryFn).toHaveBeenCalledWith({
      prompt: '/mm:planning',
      options: expect.objectContaining({
        settingSources: ['project'],
        plugins: [{ type: 'local', path: '/plugins/mm-runtime' }],
        thinking: { type: 'adaptive' },
        effort: 'high',
        settings: expect.objectContaining({
          permissions: expect.objectContaining({
            allow: expect.arrayContaining(['Bash(*)', 'Write(*)']),
          }),
        }),
      }),
    });
  });

  test('does not pass plugins or load user settings when no skills are required', async () => {
    const queryFn = vi.fn().mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success' };
    });
    const materializeRuntimeSkills = vi.fn();
    const runner = new ClaudeAgentSdkAgentRunner({ queryFn, materializeRuntimeSkills });

    await collect(runner.run({
      route: { task: 'question.answer' },
      working_directory: '/tmp/workspace',
      prompt: 'answer',
      profile: {
        id: 'question',
        provider: 'claude_agent_sdk',
        model: 'claude-sonnet-4-5',
        effort: 'low',
        required_skills: [],
      },
    }));

    expect(materializeRuntimeSkills).not.toHaveBeenCalled();
    const call = queryFn.mock.calls[0][0];
    expect(call.options.settingSources).toEqual(['project']);
    expect(call.options).not.toHaveProperty('plugins');
  });
});
