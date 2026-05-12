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
    credentials: [
      { name: 'api-key', type: 'api_key', value: 'test-key' },
    ],
    endpoints: [
      { name: 'direct-ep', protocol: 'anthropic', credential: 'api-key' },
      { name: 'agent-ep', protocol: 'anthropic', credential: 'api-key' },
    ],
    profiles: [
      { name: 'direct', endpoint: 'direct-ep', model: 'claude-haiku-4-5', runner: 'anthropic_direct' },
      { name: 'agent', endpoint: 'agent-ep', model: 'claude-sonnet-4-5', runner: 'claude_agent_sdk' },
    ],
    routing: {
      'artifact.create': 'agent',
      'artifact.revise': 'agent',
      'question.answer': 'agent',
      'implementation.run': 'agent',
      'issue.triage': 'agent',
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

  test('artifact creation prompt uses provider-neutral skill wording', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-artifact-prompt-'));
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

      await service.create(makeRequest(), workspace);

      expect(calls[0].prompt).toContain('Use the `mm:planning` skill');
      expect(calls[0].prompt).not.toContain('/mm:planning');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact creation prompt for idea includes Autocatalyst branch ownership policy and mm:planning override', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-idea-'));
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

      await service.create(makeRequest(), workspace);

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
      expect(calls[0].prompt).toContain('When using mm:planning, treat its Branch setup section as already complete.');
      expect(calls[0].prompt).toContain('Do not run git checkout -b feat/..., enhancement/..., or fix/...');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact creation prompt for bug intent includes branch ownership policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-bug-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ artifact_path: join(workspace, '.autocatalyst', 'triage', 'triage-bug-test.md') }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());

      await service.create(makeRequest(), workspace, undefined, 'bug');

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('artifact revision prompt includes branch ownership policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-revise-'));
    try {
      const artifactFilePath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      await mkdir(dirname(artifactFilePath), { recursive: true });
      await writeFile(artifactFilePath, 'original content', 'utf8');
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(artifactFilePath, 'revised content', 'utf8');
        await writeFile(resultPath, JSON.stringify({ comment_responses: [] }), 'utf8');
      });
      const service = new AgentRunnerArtifactAuthoringAgent(runner, makePolicy());

      await service.revise(makeFeedback(), [], artifactFilePath, workspace);

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt includes branch ownership policy', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-branch-policy-impl-'));
    try {
      const specPath = join(workspace, 'context-human', 'specs', 'feature-test.md');
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          summary: 'done',
          review_summary: { changes: ['a'], confirm: ['b'] },
          testing_steps: [`cd ${workspace}`],
          resolved_feedback_items: [],
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement(specPath, workspace);

      expect(calls[0].prompt).toContain('Autocatalyst owns git branch and PR management for this run.');
      expect(calls[0].prompt).toContain('Do not create branches, switch branches, or create worktrees.');
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

  test('implementation prompt names skills without slash commands', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-provider-neutral-prompt-'));
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

      expect(calls[0].prompt).toContain('superpowers:writing-plans');
      expect(calls[0].prompt).toContain('superpowers:subagent-driven-development');
      expect(calls[0].prompt).not.toContain('/superpowers:');
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

  test('parseImplementationResult accepts structured review_summary, testing_steps, and resolved_feedback_items', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-structured-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          summary: 'short fallback',
          review_summary: {
            changes: ['Added provider config', 'Wired runtime loader'],
            confirm: ['Provider is used for new runs', 'Old runs unaffected'],
          },
          testing_steps: ['cd /workspace', 'npm install', 'npm test'],
          resolved_feedback_items: [
            { id: 'block-abc', resolution_comment: 'Fixed via config loader' },
          ],
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      const result = await service.implement('/tmp/spec.md', workspace);

      expect(result.review_summary).toEqual({
        changes: ['Added provider config', 'Wired runtime loader'],
        confirm: ['Provider is used for new runs', 'Old runs unaffected'],
      });
      expect(result.testing_steps).toEqual(['cd /workspace', 'npm install', 'npm test']);
      expect(result.resolved_feedback_items).toEqual([
        { id: 'block-abc', resolution_comment: 'Fixed via config loader' },
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('parseImplementationResult tolerates omitted structured fields for backward compatibility', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-legacy-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          summary: 'Done',
          testing_instructions: 'npm test',
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      const result = await service.implement('/tmp/spec.md', workspace);

      expect(result.review_summary).toBeUndefined();
      expect(result.testing_steps).toBeUndefined();
      expect(result.resolved_feedback_items).toBeUndefined();
      expect(result.summary).toBe('Done');
      expect(result.testing_instructions).toBe('npm test');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('parseImplementationResult rejects resolved_feedback_items entries missing id or resolution_comment', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-invalid-resolved-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          resolved_feedback_items: [{ id: 'block-1' }], // missing resolution_comment
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await expect(service.implement('/tmp/spec.md', workspace)).rejects.toThrow(
        /resolved_feedback_items.*resolution_comment/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('parseImplementationResult rejects review_summary that is not an object', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-invalid-summary-'));
    try {
      const runner = fakeAgentRunner(async request => {
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          status: 'complete',
          review_summary: 'not an object',
        }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await expect(service.implement('/tmp/spec.md', workspace)).rejects.toThrow(
        /review_summary must be an object/i,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('implementation prompt requests review_summary, testing_steps, and resolved_feedback_items', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-prompt-structured-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());

      await service.implement('/tmp/spec.md', workspace);

      expect(calls[0].prompt).toContain('review_summary');
      expect(calls[0].prompt).toContain('testing_steps');
      expect(calls[0].prompt).toContain('resolved_feedback_items');
      expect(calls[0].prompt).toContain('changes');
      expect(calls[0].prompt).toContain('confirm');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('feedback implementation prompt instructs agent to preserve feedback IDs exactly', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ac-impl-feedback-prompt-'));
    try {
      const calls: AgentRunRequest[] = [];
      const runner = fakeAgentRunner(async request => {
        calls.push(request);
        const match = request.prompt.match(/Write the result to:\s*(.+)/i);
        const resultPath = match?.[1]?.trim();
        if (!resultPath) throw new Error('result path not found');
        await mkdir(dirname(resultPath), { recursive: true });
        await writeFile(resultPath, JSON.stringify({ status: 'complete', summary: 'Done' }), 'utf8');
      });
      const service = new AgentRunnerImplementationAgent(runner, makePolicy());
      const feedbackContext = '[FEEDBACK_ID: block-1]\nFix the crash\n[FEEDBACK_ID: block-2]\nUpdate config example';

      await service.implement('/tmp/spec.md', workspace, feedbackContext);

      // The prompt should instruct the agent to use IDs exactly as given
      expect(calls[0].prompt).toContain('FEEDBACK_ID');
      expect(calls[0].prompt).toContain('resolved_feedback_items');
      expect(calls[0].prompt).toMatch(/id.*exactly|use.*id.*as.*provided|preserve.*id/i);
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
