import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
import {
  AgentRunnerArtifactAuthoringAgent,
  AgentRunnerImplementationAgent,
  AgentRunnerIssueTriageAgent,
  AgentRunnerQuestionAnsweringAgent,
  IssueFilingService,
} from '../../../src/core/ai/agent-services.js';
import { DefaultAgentRoutingPolicy } from '../../../src/core/ai/routing-policy.js';
import type { AgentRunEvent, AgentRunRequest, AgentRunner } from '../../../src/types/ai.js';
import type { Request, ThreadMessage } from '../../../src/types/events.js';
import type { IssueManager } from '../../../src/types/issue-tracker.js';
import type { ArtifactCommentAnchorCodec } from '../../../src/types/publisher.js';

const conversation = { provider: 'slack', channel_id: 'C123', conversation_id: 'T123' };
const channel = { provider: 'slack', id: 'C123' };
const origin = { provider: 'slack', channel_id: 'C123', conversation_id: 'T123', message_id: 'M123' };

function makeRequest(content = 'Please build this'): Request {
  return {
    id: 'req-1',
    channel,
    conversation,
    origin,
    content,
    author: 'U123',
    received_at: '2026-04-25T00:00:00.000Z',
  };
}

function makeFeedback(content = 'Please revise this'): ThreadMessage {
  return {
    request_id: 'req-1',
    channel,
    conversation,
    origin,
    content,
    author: 'U123',
    received_at: '2026-04-25T00:00:00.000Z',
  };
}

function makePolicy(): DefaultAgentRoutingPolicy {
  return new DefaultAgentRoutingPolicy({
    defaults: {
      direct: { id: 'direct', provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      agent: { id: 'agent', provider: 'claude_agent_sdk', model: 'claude-sonnet-4-5', effort: 'medium' },
    },
  });
}

function fakeAgentRunner(onRun: (request: AgentRunRequest) => Promise<void>): AgentRunner {
  return {
    async *run(request: AgentRunRequest): AsyncIterable<AgentRunEvent> {
      await onRun(request);
      yield {
        type: 'assistant',
        content: [{ type: 'text', text: '[Relay] working' }],
      };
    },
  };
}

describe('AgentRunner-backed core AI services', () => {
  test('creates artifacts through AgentRunner using artifact route metadata', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-artifact-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, 'context-human', 'specs', 'feature-test.md') }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());
      const progress = vi.fn();

      const result = await service.create(makeRequest(), workspace, progress);

      expect(result.artifact_path).toContain('feature-test.md');
      expect(calls[0].route).toMatchObject({
        task: 'artifact.create',
        stage: 'new_thread',
        intent: 'idea',
        artifact_kind: 'feature_spec',
      });
      expect(calls[0].working_directory).toBe(workspace);
      expect(progress).toHaveBeenCalledWith('working');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('answers questions in the provided repo directory without creating a cloned workspace', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ac-question-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write it to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await access(dirname(resultPath));
        await writeFile(resultPath, JSON.stringify({ answer: 'There are 3 open issues.' }), 'utf8');
      });
      const service = new AgentRunnerQuestionAnsweringAgent(runner, makePolicy(), repo);

      await expect(service.answer('How many issues are there?')).resolves.toBe('There are 3 open issues.');
      expect(calls[0].route).toEqual({ task: 'question.answer' });
      expect(calls[0].working_directory).toBe(repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('delegates artifact comment anchor preservation to the configured publisher codec', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-artifact-revise-'));
    try {
      const artifactPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      const resultPathRegex = /Write the result to:\s*(.+)/i;
      const calls: AgentRunRequest[] = [];
      const codec: ArtifactCommentAnchorCodec = {
        extract: vi.fn().mockReturnValue([{ id: 'anchor-1', text: 'anchored text' }]),
        promptInstructions: vi.fn().mockReturnValue(['KEEP TEST ANCHORS']),
        preserve: vi.fn().mockReturnValue('PUBLISHED CONTENT WITH ANCHOR'),
        strip: vi.fn().mockReturnValue('LOCAL CONTENT WITHOUT ANCHOR'),
      };
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const resultPath = request.prompt.match(resultPathRegex)?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await mkdir(dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, 'agent revised content', 'utf8');
        await writeFile(resultPath, JSON.stringify({ comment_responses: [] }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy(), { commentAnchorCodec: codec });

      const result = await service.revise(makeFeedback(), [], artifactPath, workspace, 'published content with anchors');

      expect(codec.extract).toHaveBeenCalledWith('published content with anchors');
      expect(codec.promptInstructions).toHaveBeenCalledWith([{ id: 'anchor-1', text: 'anchored text' }]);
      expect(calls[0].prompt).toContain('KEEP TEST ANCHORS');
      expect(codec.preserve).toHaveBeenCalledWith('agent revised content', [{ id: 'anchor-1', text: 'anchored text' }]);
      expect(result.page_content).toBe('PUBLISHED CONTENT WITH ANCHOR');
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('LOCAL CONTENT WITHOUT ANCHOR');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('requires question answering to write the result file', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ac-question-'));
    try {
      const runner: AgentRunner = {
        async *run(): AsyncIterable<AgentRunEvent> {
          yield { type: 'assistant', content: [{ type: 'text', text: 'There are 4 open issues.' }] };
        },
      };
      const service = new AgentRunnerQuestionAnsweringAgent(runner, makePolicy(), repo);

      await expect(service.answer('How many issues are there?')).rejects.toThrow('result file not found');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('runs implementation through AgentRunner and parses canonical status', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Built it', testing_instructions: 'Run tests' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await expect(service.implement('/tmp/spec.md', workspace)).resolves.toMatchObject({
        status: 'complete',
        summary: 'Built it',
      });
      expect(calls[0].route).toEqual({ task: 'implementation.run' });
      expect(calls[0].working_directory).toBe(workspace);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt forbids force-adding and staging .autocatalyst files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-prompt-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done', testing_instructions: 'Run tests' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace);

      expect(calls[0].prompt).not.toMatch(/commit anything uncommitted/i);
      expect(calls[0].prompt).toMatch(/never use `git add --force`|never.*git add.*--force/i);
      expect(calls[0].prompt).toMatch(/never stage.*\.autocatalyst|do not stage.*\.autocatalyst/i);
      expect(calls[0].prompt).toContain('.autocatalyst/');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('uses issue triage agent output before creating issues through IssueManager', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-issue-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          items: [
            {
              proposed_title: 'Crash on login',
              proposed_body: 'The app crashes on login.',
              proposed_labels: ['bug'],
              duplicate_of: null,
            },
          ],
        }), 'utf8');
      });
      const triageAgent = new AgentRunnerIssueTriageAgent(runner, makePolicy());
      const issueManager: Pick<IssueManager, 'create'> = {
        create: vi.fn().mockResolvedValue({ number: 42, url: 'https://example.test/42' }),
      };
      const service = new IssueFilingService(issueManager, triageAgent);

      await expect(service.file(makeRequest('Crash on login'), workspace)).resolves.toMatchObject({
        status: 'complete',
        filed_issues: [{ number: 42, title: 'Crash on login', action: 'filed' }],
      });
      expect(issueManager.create).toHaveBeenCalledWith(workspace, 'Crash on login', 'The app crashes on login.', ['bug']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
