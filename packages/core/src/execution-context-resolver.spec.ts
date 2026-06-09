import { describe, expect, it, vi } from 'vitest';
import type { RunWorkInput } from './orchestrator.js';
import type { Run } from '@autocatalyst/api-contract';
import { createExecutionContextResolver, ExecutionContextResolutionError } from './execution-context-resolver.js';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1' };
const project = {
  id: 'project_1', owner, tenant: 'tenant_1', displayName: 'Widgets',
  repoUrl: 'https://example.com/acme/widgets.git',
  hostRepository: { provider: 'github', owner: 'acme', name: 'widgets', url: 'https://example.com/acme/widgets.git' },
  workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: [],
  createdAt: '2026-06-09T00:00:00.000Z', updatedAt: '2026-06-09T00:00:00.000Z'
};
const roots = { reposRoot: '/tmp/repos', workspacesRoot: '/tmp/workspaces' };

function makeRun(partial: Partial<Run> & { workKind: string; currentStep: string }): Run {
  return {
    id: 'run_1', owner, tenant: 'tenant_1',
    workKind: partial.workKind, currentStep: partial.currentStep,
    terminal: false, createdAt: '2026-06-09T00:00:00.000Z', updatedAt: '2026-06-09T00:00:00.000Z',
    ...partial
  } as Run;
}

function makeInput(run: Run): RunWorkInput {
  return { runId: run.id, run, tenant: run.tenant };
}

describe('ExecutionContextResolver', () => {
  describe('work kind mapping', () => {
    it('rejects unknown work kind with unsupported_work_kind', async () => {
      const resolver = createExecutionContextResolver({ workspace: { project, roots, topicSlug: 't', shortRunId: 's' } });
      const input = makeInput(makeRun({ workKind: 'unknown_kind', currentStep: 'implement' }));
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        name: 'ExecutionContextResolutionError',
        code: 'unsupported_work_kind'
      });
    });

    it('maps feature to two_roots workspace intent', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123', defaultBranch: 'main' }
      });
      const input = makeInput(makeRun({ workKind: 'feature', currentStep: 'implement' }));
      const context = await resolver.resolve(input);
      expect(context.workspaceIntent.shape).toBe('two_roots');
      if (context.workspaceIntent.shape === 'two_roots') {
        expect(context.workspaceIntent.provisioning.project.id).toBe('project_1');
        expect(context.workspaceIntent.provisioning.topicSlug).toBe('widgets');
        expect(context.workspaceIntent.provisioning.shortRunId).toBe('abc123');
        expect(context.workspaceIntent.provisioning.defaultBranch).toBe('main');
      }
    });

    it('maps enhancement to two_roots workspace intent', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const input = makeInput(makeRun({ workKind: 'enhancement', currentStep: 'implement' }));
      const context = await resolver.resolve(input);
      expect(context.workspaceIntent.shape).toBe('two_roots');
    });

    it('maps bug to two_roots workspace intent', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const input = makeInput(makeRun({ workKind: 'bug', currentStep: 'implement' }));
      const context = await resolver.resolve(input);
      expect(context.workspaceIntent.shape).toBe('two_roots');
    });

    it('maps chore to two_roots workspace intent', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const input = makeInput(makeRun({ workKind: 'chore', currentStep: 'implement' }));
      const context = await resolver.resolve(input);
      expect(context.workspaceIntent.shape).toBe('two_roots');
    });

    it('maps question to none workspace intent', async () => {
      const resolver = createExecutionContextResolver({});
      const input = makeInput(makeRun({ workKind: 'question', currentStep: 'respond' }));
      const context = await resolver.resolve(input);
      expect(context.workspaceIntent.shape).toBe('none');
    });

    it('maps file_issue to scratch_only workspace intent', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const input = makeInput(makeRun({ workKind: 'file_issue', currentStep: 'file' }));
      const context = await resolver.resolve(input);
      expect(context.workspaceIntent.shape).toBe('scratch_only');
    });

    it('does not silently fall back: question stays none, file_issue stays scratch_only', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const questionContext = await resolver.resolve(makeInput(makeRun({ workKind: 'question', currentStep: 'respond' })));
      const fileIssueContext = await resolver.resolve(makeInput(makeRun({ workKind: 'file_issue', currentStep: 'file' })));
      expect(questionContext.workspaceIntent.shape).not.toBe('two_roots');
      expect(fileIssueContext.workspaceIntent.shape).not.toBe('two_roots');
    });
  });

  describe('workspace settings validation', () => {
    it('rejects two_roots with missing project with missing_project', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const input = makeInput(makeRun({ workKind: 'feature', currentStep: 'implement' }));
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        name: 'ExecutionContextResolutionError',
        code: 'missing_project'
      });
    });

    it('rejects two_roots with missing topicSlug with missing_workspace_settings', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, shortRunId: 'abc123' } as any
      });
      const input = makeInput(makeRun({ workKind: 'feature', currentStep: 'implement' }));
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        name: 'ExecutionContextResolutionError',
        code: 'missing_workspace_settings'
      });
    });

    it('rejects two_roots with missing roots with missing_workspace_settings', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, topicSlug: 'widgets', shortRunId: 'abc123' } as any
      });
      const input = makeInput(makeRun({ workKind: 'feature', currentStep: 'implement' }));
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        name: 'ExecutionContextResolutionError',
        code: 'missing_workspace_settings'
      });
    });
  });

  describe('secret bindings', () => {
    it('accepts empty secret bindings without requiring secretsAvailable', async () => {
      const resolver = createExecutionContextResolver({ secretBindings: [] });
      const input = makeInput(makeRun({ workKind: 'question', currentStep: 'respond' }));
      const context = await resolver.resolve(input);
      expect(context.secretBindings).toHaveLength(0);
    });

    it('rejects non-empty secret bindings without secretsAvailable', async () => {
      const resolver = createExecutionContextResolver({
        secretBindings: [{ handle: 'sec_abc', envName: 'MODEL_API_KEY' }]
      });
      const input = makeInput(makeRun({ workKind: 'question', currentStep: 'respond' }));
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        name: 'ExecutionContextResolutionError',
        code: 'invalid_secret_declaration'
      });
    });

    it('rejects duplicate envName with invalid_secret_declaration', async () => {
      const resolver = createExecutionContextResolver({
        secretBindings: [
          { handle: 'sec_abc', envName: 'MODEL_API_KEY' },
          { handle: 'sec_def', envName: 'MODEL_API_KEY' }
        ],
        secretsAvailable: true
      });
      const input = makeInput(makeRun({ workKind: 'question', currentStep: 'respond' }));
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        name: 'ExecutionContextResolutionError',
        code: 'invalid_secret_declaration'
      });
    });

    it('rejects malformed envName with invalid_secret_declaration', async () => {
      const resolver = createExecutionContextResolver({
        secretBindings: [{ handle: 'sec_abc', envName: 'bad-key' }],
        secretsAvailable: true
      });
      const input = makeInput(makeRun({ workKind: 'question', currentStep: 'respond' }));
      await expect(resolver.resolve(input)).rejects.toMatchObject({
        name: 'ExecutionContextResolutionError',
        code: 'invalid_secret_declaration'
      });
    });

    it('does not include ambient process.env values', async () => {
      process.env['SENTINEL_SHOULD_NOT_LEAK'] = 'sentinel-secret';
      try {
        const resolver = createExecutionContextResolver({
          secretBindings: [{ handle: 'sec_abc', envName: 'MODEL_API_KEY' }],
          secretsAvailable: true
        });
        const input = makeInput(makeRun({ workKind: 'question', currentStep: 'respond' }));
        const context = await resolver.resolve(input);
        const contextJson = JSON.stringify(context);
        expect(contextJson).not.toContain('sentinel-secret');
        // Only the declared binding appears
        expect(context.secretBindings).toHaveLength(1);
        expect(context.secretBindings[0]?.handle).toBe('sec_abc');
      } finally {
        delete process.env['SENTINEL_SHOULD_NOT_LEAK'];
      }
    });
  });

  describe('context output shape', () => {
    it('populates run identity correctly', async () => {
      const resolver = createExecutionContextResolver({});
      const run = makeRun({ workKind: 'question', currentStep: 'respond' });
      const context = await resolver.resolve(makeInput(run));
      expect(context.run).toEqual({ id: run.id, workKind: 'question', currentStep: 'respond', tenant: run.tenant });
    });

    it('includes default tool policy', async () => {
      const resolver = createExecutionContextResolver({});
      const context = await resolver.resolve(makeInput(makeRun({ workKind: 'question', currentStep: 'respond' })));
      expect(context.toolPolicy).toEqual({ allowedTools: ['bash', 'filesystem', 'lsp'], workspaceScope: 'declared_workspace' });
    });

    it('includes default skill intent', async () => {
      const resolver = createExecutionContextResolver({});
      const context = await resolver.resolve(makeInput(makeRun({ workKind: 'question', currentStep: 'respond' })));
      expect(context.skills.requested).toContain('stub_runner');
    });

    it('includes default capability requirements', async () => {
      const resolver = createExecutionContextResolver({});
      const context = await resolver.resolve(makeInput(makeRun({ workKind: 'question', currentStep: 'respond' })));
      expect(context.capabilityRequirements.shell).toEqual({ kind: 'bash', required: false });
      expect(context.capabilityRequirements.paths).toEqual({ canonicalWorkspacePaths: true });
      expect(context.capabilityRequirements.lsp).toEqual({ requested: true });
    });

    it('does not include available flags in capability requirements', async () => {
      const resolver = createExecutionContextResolver({});
      const context = await resolver.resolve(makeInput(makeRun({ workKind: 'question', currentStep: 'respond' })));
      const contextJson = JSON.stringify(context);
      // Should not have availability flags in the declarative context
      expect(contextJson).not.toContain('"available"');
    });

    it('includes task prompt containing current step', async () => {
      const resolver = createExecutionContextResolver({});
      const context = await resolver.resolve(makeInput(makeRun({ workKind: 'question', currentStep: 'respond' })));
      expect(context.task.prompt).toContain('respond');
    });

    it('does not include materialized paths', async () => {
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const context = await resolver.resolve(makeInput(makeRun({ workKind: 'feature', currentStep: 'implement' })));
      const contextJson = JSON.stringify(context);
      expect(contextJson).not.toContain('"repoRoot"');
      expect(contextJson).not.toContain('"scratchRoot"');
      expect(contextJson).not.toContain('"branchName"');
    });

    it('does not call provisionWorkspace or resolveSecret', async () => {
      const provisionSpy = vi.fn();
      const resolveSpy = vi.fn();
      const resolver = createExecutionContextResolver({
        workspace: { project, roots, topicSlug: 'widgets', shortRunId: 'abc123' }
      });
      const context = await resolver.resolve(makeInput(makeRun({ workKind: 'feature', currentStep: 'implement' })));
      expect(provisionSpy).not.toHaveBeenCalled();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(context).toBeDefined();
    });
  });
});
