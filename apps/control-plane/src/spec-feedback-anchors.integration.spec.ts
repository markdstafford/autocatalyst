import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunnerEvent } from '@autocatalyst/api-contract';
import {
  DefaultControlPlaneService,
  DefaultIssueReferenceIntakeResolver,
  DefaultOrchestrator,
  InMemoryRunEventBus,
  RunDispatchQueue,
  StaticIssueTrackerRegistry,
  assertSpecReviewGateCanAdvance,
  buildSpecAuthorContext,
  createExecutionContextResolver,
  createExecutionRunUnitOfWork,
  finalizeSpecApproval,
  hardcodedDevelopmentPrincipal,
  permissivePolicyDecisionPoint,
  resolveApproverAddressedFeedback,
  type FeedbackLifecycleDependencies,
  type SpecAuthoringServiceDependencies
} from '@autocatalyst/core';
import {
  createExecutionEntryPoint,
  createExecutionMaterializer,
  createSpecAuthorResultContract,
  SPEC_AUTHOR_SCHEMA_ID
} from '@autocatalyst/execution';
import type { Runner, RunnerCloseResult, RunnerRunInput } from '@autocatalyst/execution';
import {
  DrizzleConversationIngressRepository,
  createDrizzleDomainRepositories,
  createSqliteDatabase,
  migrateSqliteDatabase
} from '@autocatalyst/persistence';

import { loadSpecAuthorPromptInput, SpecAuthoringContextLoadError } from './spec-authoring-context-loader.js';

const execFileAsync = promisify(execFile);

async function git(args: readonly string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args as string[], { cwd, windowsHide: true });
  return result.stdout.trim();
}

function makePassThroughIntakeResolver(): DefaultIssueReferenceIntakeResolver {
  return new DefaultIssueReferenceIntakeResolver({ registry: new StaticIssueTrackerRegistry({}) });
}

const owner = {
  id: 'principal_dev_human',
  kind: 'human' as const,
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

// A scripted spec-author runner that writes a round-dependent spec body so a request_changes revise
// pass moves one quoted passage and removes another — exercising offset repair and stale marking on
// the next read. No model is ever called.
const ROUND_ONE_BODY = [
  '# Feature: Feedback Anchors E2E',
  '',
  '## Overview',
  '',
  'The scope section is ambiguous and needs tightening before build.',
  '',
  '## Risks',
  '',
  'Delete this risky sentence in revision.',
  '',
  '## Task list',
  '',
  '- [ ] Implement feedback anchors'
].join('\n');

const ROUND_TWO_BODY = [
  '# Feature: Feedback Anchors E2E',
  '',
  '## Context',
  '',
  'A newly added context paragraph that pushes later passages to higher offsets.',
  '',
  '## Overview',
  '',
  'The scope section is ambiguous and needs tightening before build.',
  '',
  '## Task list',
  '',
  '- [ ] Implement feedback anchors'
].join('\n');

function makeScriptedSpecRunner(bodies: readonly string[]): Runner {
  let call = 0;
  return {
    async *run(input: RunnerRunInput): AsyncIterable<RunnerEvent> {
      const { environment } = input;
      const { run, task } = environment.context;
      const runId = run.id;
      const step = run.currentStep;

      if (step === 'spec.author') {
        const prompt = task.prompt;
        if (!prompt.includes('mm:planning') || !prompt.includes('step-result.json')) {
          throw new Error('Scripted runner requires the real spec-authoring prompt.');
        }
        const taskInputs = task.inputs as Record<string, unknown>;
        const scratchRoot = 'scratchRoot' in environment.workspace
          ? (environment.workspace as { scratchRoot: string }).scratchRoot
          : undefined;
        if (scratchRoot === undefined) throw new Error('Scripted runner requires a scratch root.');

        const outputContract = taskInputs['outputContract'] as Record<string, unknown> | undefined;
        const expectedKind = (outputContract?.['expectedKind'] as string | undefined) ?? 'feature_spec';
        const expectedPathPrefix = (outputContract?.['expectedPathPrefix'] as string | undefined) ?? 'context-human/specs/feature-';
        const slug = 'feedback-anchors-e2e';
        const body = bodies[Math.min(call, bodies.length - 1)] ?? bodies[bodies.length - 1];
        call += 1;

        const result = {
          kind: expectedKind,
          slug,
          relativePath: `${expectedPathPrefix}${slug}.md`,
          frontmatter: { created: '2026-06-12', last_updated: '2026-06-12', status: 'draft', specced_by: 'autocatalyst' },
          body
        };
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(scratchRoot, { recursive: true });
        await writeFile(path.join(scratchRoot, 'step-result.json'), JSON.stringify(result), 'utf8');
      }

      const createdAt = new Date().toISOString();
      yield { id: `evt_${runId}_${call}_progress`, type: 'runner_progress', runId, step, importance: 'normal', createdAt, progress: { kind: 'intent', summary: `scripted spec author for ${step}` } };
      yield { id: `evt_${runId}_${call}_terminal`, type: 'runner_terminal_result', runId, step, importance: 'high', createdAt: new Date().toISOString(), result: { directive: 'advance' } };
    },
    async close(): Promise<RunnerCloseResult> {
      return { status: 'closed' };
    }
  };
}

function cpIndexOf(markdown: string, quote: string): number {
  const cp = Array.from(markdown);
  const q = Array.from(quote);
  for (let i = 0; i <= cp.length - q.length; i += 1) {
    let ok = true;
    for (let j = 0; j < q.length; j += 1) {
      if (cp[i + j] !== q[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

describe('spec feedback anchors integration (production server, no model calls)', () => {
  let tempRoot: string;
  let upstreamPath: string;
  let reposRoot: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-fb-anchors-'));
    upstreamPath = path.join(tempRoot, 'upstream.git');
    const sourcePath = path.join(tempRoot, 'source');
    reposRoot = path.join(tempRoot, 'repos');
    workspacesRoot = path.join(tempRoot, 'workspaces');

    await git(['init', '--bare', upstreamPath]);
    await git(['clone', upstreamPath, sourcePath]);
    await git(['checkout', '-b', 'main'], sourcePath);
    await git(['config', 'user.name', 'Autocatalyst Test'], sourcePath);
    await git(['config', 'user.email', 'test@example.invalid'], sourcePath);
    await fs.writeFile(path.join(sourcePath, 'README.md'), '# Feedback Anchors Test\n', 'utf8');
    await git(['add', 'README.md'], sourcePath);
    await git(['commit', '-m', 'initial commit'], sourcePath);
    await git(['push', '-u', 'origin', 'main'], sourcePath);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], upstreamPath);

    await fs.mkdir(reposRoot, { recursive: true });
    await fs.mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it(
    'reads the spec, validates anchors, requests changes, repairs/stales anchors on read, resolves, and approves',
    async () => {
      const database = createSqliteDatabase({ path: ':memory:' });
      await migrateSqliteDatabase(database);
      try {
        const domainRepos = createDrizzleDomainRepositories(database);
        const conversationIngress = new DrizzleConversationIngressRepository(database);

        const upstreamUrl = `file://${upstreamPath}`;
        const project = await domainRepos.projects.create({
          owner,
          tenant: 'tenant_dev',
          displayName: 'Feedback Anchors Project',
          repoUrl: upstreamUrl,
          hostRepository: { provider: 'git', owner: 'acme', name: 'widgets', url: upstreamUrl },
          workspaceRootOverride: null,
          issueTrackerSetting: null,
          codeHostSetting: null,
          credentialRefs: []
        });

        const now = new Date().toISOString();
        const seedResult = await conversationIngress.createConversationTopicMessageAndRun({
          conversation: { projectId: project.id, owner, tenant: 'tenant_dev', identity: 'feedback-anchors', activeTopicId: null },
          topic: { owner, tenant: 'tenant_dev', title: 'Feedback Anchors Topic', kind: 'main' },
          message: { owner, tenant: 'tenant_dev', author: owner, direction: 'inbound', body: 'author a feature spec' },
          run: { owner, tenant: 'tenant_dev', workKind: 'feature', currentStep: 'spec.author', terminal: false },
          runStep: { phase: 'spec', step: 'spec.author', role: 'none', startedAt: now, endedAt: null, durationMs: null }
        });
        const runId = seedResult.run.id;

        const runner = makeScriptedSpecRunner([ROUND_ONE_BODY, ROUND_TWO_BODY]);

        const inMemoryFiles = new Map<string, string>();
        const sharedFilesystem = {
          writeFile: async (input: { workspaceRepoRoot: string; relativePath: string; contents: string }): Promise<void> => {
            inMemoryFiles.set(`${input.workspaceRepoRoot}::${input.relativePath}`, input.contents);
          },
          readFile: async (input: { workspaceRepoRoot: string; relativePath: string }): Promise<string> => {
            const value = inMemoryFiles.get(`${input.workspaceRepoRoot}::${input.relativePath}`);
            if (value === undefined) throw new Error(`File not found: ${input.relativePath}`);
            return value;
          }
        };

        const workspaceRootRegistry = new Map<string, string>();
        const contract = createSpecAuthorResultContract();
        const materializer = createExecutionMaterializer({ capabilities: { shellAvailable: false, lspAvailable: false } });
        const entryPoint = createExecutionEntryPoint({
          runner,
          materialize: async (context) => {
            const env = await materializer.materialize(context);
            if (env.workspace.shape === 'two_roots') workspaceRootRegistry.set(context.run.id, env.workspace.repoRoot);
            return env;
          },
          resultValidation: { mode: 'scratch_file', contract, step: 'spec.author', schemaId: SPEC_AUTHOR_SCHEMA_ID, resultFile: 'step-result.json' }
        });

        const unitOfWork = createExecutionRunUnitOfWork({
          execute: entryPoint,
          resolveContext: async (workInput) => {
            let specAuthorPrompt: string | undefined;
            let specAuthorTaskInputs: Record<string, unknown> | undefined;
            if (workInput.run.currentStep === 'spec.author' && (workInput.run.workKind === 'feature' || workInput.run.workKind === 'enhancement')) {
              try {
                const promptInput = await loadSpecAuthorPromptInput({ runId: workInput.runId, tenantId: workInput.tenant, repositories: domainRepos });
                const ctx = buildSpecAuthorContext(promptInput);
                specAuthorPrompt = ctx.prompt;
                specAuthorTaskInputs = ctx.taskInputs;
              } catch (error) {
                if (error instanceof SpecAuthoringContextLoadError) throw new Error(`spec_authoring_context_load_failed: ${error.code}`);
                throw error;
              }
            }
            return createExecutionContextResolver({
              workspace: (input) => ({ project, roots: { reposRoot, workspacesRoot }, topicSlug: 'feedback-anchors', shortRunId: input.run.id.slice(0, 8), defaultBranch: 'main' }),
              secretsAvailable: false,
              ...(specAuthorPrompt !== undefined ? { prompt: specAuthorPrompt } : {}),
              ...(specAuthorTaskInputs !== undefined ? { taskInputs: specAuthorTaskInputs } : {})
            }).resolve(workInput);
          },
          onEvent: () => {}
        });

        const eventBus = new InMemoryRunEventBus();
        const dispatchQueue = new RunDispatchQueue({ maxConcurrent: 2 });

        const feedbackLifecycle: FeedbackLifecycleDependencies = {
          feedback: domainRepos.feedback,
          ids: () => `id_${Math.random().toString(36).slice(2)}`,
          clock: () => new Date().toISOString()
        };

        const specAuthoringDependencies: SpecAuthoringServiceDependencies = {
          artifacts: domainRepos.artifacts,
          filesystem: sharedFilesystem,
          git: { commitFiles: vi.fn().mockResolvedValue({}) },
          clock: () => new Date().toISOString(),
          feedbackLifecycle
        };

        const orchestrator = new DefaultOrchestrator({
          runs: domainRepos.runs,
          conversationIngress,
          events: eventBus,
          dispatchQueue,
          unitOfWork,
          autoDispatch: { enabled: false },
          specAuthoringDependencies,
          feedbackLifecycleDependencies: feedbackLifecycle,
          resolveApproverAddressedFeedback,
          assertSpecReviewGateCanAdvance,
          finalizeSpecApproval,
          specApprovalFinalizerDependencies: {
            artifacts: domainRepos.artifacts,
            filesystem: sharedFilesystem,
            git: { commitFiles: vi.fn().mockResolvedValue({}) },
            clock: () => new Date().toISOString()
          },
          resolveWorkspaceContext: async ({ runId: rId }) => {
            const repoRoot = workspaceRootRegistry.get(rId);
            if (repoRoot === undefined) throw new Error(`Workspace root not found for run '${rId}'`);
            return { workspaceRepoRoot: repoRoot, workspaceHandle: rId };
          },
          runWorkspaceMetadata: domainRepos.runWorkspaceMetadata
        });

        const controlPlane = new DefaultControlPlaneService({
          orchestrator,
          runs: domainRepos.runs,
          runSteps: domainRepos.runSteps,
          events: eventBus,
          policy: permissivePolicyDecisionPoint,
          artifacts: domainRepos.artifacts,
          feedback: domainRepos.feedback,
          runWorkspaceMetadata: domainRepos.runWorkspaceMetadata,
          workspaceFilesystem: sharedFilesystem,
          feedbackLifecycle,
          projects: domainRepos.projects,
          issueReferenceIntakeResolver: makePassThroughIntakeResolver(),
          pullRequests: domainRepos.pullRequests,
          sessions: domainRepos.sessions
        });

        const asPrincipal = { principal: hardcodedDevelopmentPrincipal, tenant: 'tenant_dev' } as const;

        // 1. Author the spec and reach the review gate.
        await controlPlane.tick({ ...asPrincipal, runId });
        let run = await domainRepos.runs.findById(runId);
        expect(run?.currentStep).toBe('spec.human_review');

        // 2. Read the spec; compute real code-point offsets for the two quotes.
        const spec = await controlPlane.getRunSpec({ ...asPrincipal, runId });
        const artifactId = spec.artifact.id;
        const ambiguousAt = cpIndexOf(spec.markdown, 'ambiguous');
        const deleteSentence = 'Delete this risky sentence in revision.';
        const deleteAt = cpIndexOf(spec.markdown, deleteSentence);
        expect(ambiguousAt).toBeGreaterThan(-1);
        expect(deleteAt).toBeGreaterThan(-1);

        // 3. Post a valid anchored comment on "ambiguous".
        const movingComment = await controlPlane.createRunFeedback({
          ...asPrincipal,
          runId,
          request: { target: 'artifact', title: 'Tighten scope', body: 'Clarify this.', anchor: { kind: 'artifact_range', artifactId, from: ambiguousAt, to: ambiguousAt + 'ambiguous'.length, quotedText: 'ambiguous' } }
        });
        // Anchor on the sentence that will be removed.
        await controlPlane.createRunFeedback({
          ...asPrincipal,
          runId,
          request: { target: 'artifact', title: 'Drop risk', body: 'Remove this.', anchor: { kind: 'artifact_range', artifactId, from: deleteAt, to: deleteAt + deleteSentence.length, quotedText: deleteSentence } }
        });
        // 4. Post an unanchored (target-level) comment.
        await controlPlane.createRunFeedback({ ...asPrincipal, runId, request: { target: 'artifact', title: 'General', body: 'Overall looks close.' } });

        // 5. A wrong quoted text is rejected before any item is created.
        await expect(controlPlane.createRunFeedback({
          ...asPrincipal,
          runId,
          request: { target: 'artifact', title: 'Bad', body: 'Bad anchor.', anchor: { kind: 'artifact_range', artifactId, from: ambiguousAt, to: ambiguousAt + 5, quotedText: 'WRONGTEXT' } }
        })).rejects.toMatchObject({ code: 'invalid_feedback_anchor' });

        const before = await controlPlane.listRunFeedback({ ...asPrincipal, runId });
        expect(before.feedback).toHaveLength(3);

        // 6. Request changes → run leaves the gate; open items stay open.
        const rc = await controlPlane.replyToRun({ ...asPrincipal, runId, request: { kind: 'request_changes' } });
        expect(rc.classification.directive).toBe('revise');
        expect(rc.classification.createdFeedbackId).toBeUndefined();

        // 7. Re-author (round two) addresses the open comments and returns to the gate.
        await controlPlane.tick({ ...asPrincipal, runId });
        run = await domainRepos.runs.findById(runId);
        expect(run?.currentStep).toBe('spec.human_review');

        // 8. On the next read: the moved quote is repaired and the removed quote is stale (still listed).
        const after = await controlPlane.listRunFeedback({ ...asPrincipal, runId });
        const movedSpec = await controlPlane.getRunSpec({ ...asPrincipal, runId });
        const newAmbiguousAt = cpIndexOf(movedSpec.markdown, 'ambiguous');
        expect(newAmbiguousAt).toBeGreaterThan(ambiguousAt);

        const movedItem = after.feedback.find((f) => f.id === movingComment.id);
        expect(movedItem?.anchor).toMatchObject({ kind: 'artifact_range', from: newAmbiguousAt, to: newAmbiguousAt + 'ambiguous'.length });
        expect(movedItem?.anchor && 'stale' in movedItem.anchor).toBe(false);

        const staleItem = after.feedback.find((f) => f.anchor?.kind === 'artifact_range' && (f.anchor as { quotedText?: string }).quotedText === deleteSentence);
        expect(staleItem?.anchor).toMatchObject({ stale: true });
        expect(after.feedback).toHaveLength(3); // the stale item is still listed

        // Every open comment moved to addressed during the revision.
        expect(after.feedback.every((f) => f.status === 'addressed')).toBe(true);

        // 9. Resolve one comment as its originator.
        const resolved = await controlPlane.updateRunFeedback({ ...asPrincipal, runId, feedbackId: movingComment.id, request: { status: 'resolved' } });
        expect(resolved.status).toBe('resolved');

        // 10. Approve: approver-owned addressed items auto-resolve and the run advances past the gate.
        const approved = await controlPlane.replyToRun({ ...asPrincipal, runId, request: { kind: 'approve' } });
        expect(approved.classification.directive).toBe('advance');
        run = await domainRepos.runs.findById(runId);
        expect(run?.currentStep).not.toBe('spec.human_review');
        expect(run?.terminal).toBe(false);
      } finally {
        database.close();
      }
    },
    60000
  );
});
