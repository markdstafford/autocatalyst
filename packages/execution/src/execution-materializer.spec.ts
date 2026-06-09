import { describe, expect, it, vi } from 'vitest';

import type { ExecutionContext } from '@autocatalyst/api-contract';
import { createExecutionMaterializer } from './internal/execution-materializer.js';
import { ExecutionMaterializationError } from './materialized-environment.js';
import { WorkspaceProvisioningError } from './workspace.js';

// Ensure process.env sentinel is not set
delete process.env['SENTINEL_SHOULD_NOT_LEAK'];

const owner = { id: 'user_1', kind: 'user' as const, tenant: 'tenant_1' };
const project = {
  id: 'project_1',
  owner,
  tenant: 'tenant_1',
  displayName: 'Widgets',
  repoUrl: 'https://example.com/acme/widgets.git',
  hostRepository: { provider: 'github', owner: 'acme', name: 'widgets' },
  workspaceRootOverride: null,
  issueTrackerSetting: null,
  codeHostSetting: null,
  credentialRefs: [],
  createdAt: '2026-06-09T00:00:00.000Z',
  updatedAt: '2026-06-09T00:00:00.000Z'
};
const provisioning = {
  project,
  roots: { reposRoot: '/tmp/repos', workspacesRoot: '/tmp/workspaces' },
  topicSlug: 'widgets',
  shortRunId: 'abc123',
  defaultBranch: 'main'
};

function makeContext(partial: Partial<ExecutionContext> & { workspaceIntent: ExecutionContext['workspaceIntent'] }): ExecutionContext {
  return {
    run: { id: 'run_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
    task: { prompt: 'Implement feature', inputs: {} },
    secretBindings: [],
    toolPolicy: { allowedTools: ['bash'], workspaceScope: 'declared_workspace' },
    skills: { requested: ['stub_runner'] },
    capabilityRequirements: {
      shell: { kind: 'bash', required: false },
      paths: { canonicalWorkspacePaths: true },
      lsp: { requested: true }
    },
    ...partial
  };
}

describe('createExecutionMaterializer', () => {
  describe('workspace materialization', () => {
    it('none shape: does not call provisionWorkspace, workspaceRoots is empty', async () => {
      const mockProvision = vi.fn();
      const materializer = createExecutionMaterializer({ provisionWorkspace: mockProvision });
      const context = makeContext({ workspaceIntent: { shape: 'none' } });

      const result = await materializer.materialize(context);

      expect(mockProvision).not.toHaveBeenCalled();
      expect(result.workspace).toEqual({ shape: 'none', workspaceRoots: [] });
    });

    it('scratch_only shape: calls provisioner and returns scratchRoot in workspaceRoots', async () => {
      const mockProvision = vi.fn().mockResolvedValue({
        shape: 'scratch_only',
        runId: 'run_1',
        workspaceRoot: '/tmp/workspaces/acme/widgets',
        runRoot: '/tmp/workspaces/acme/widgets/run_1',
        scratchRoot: '/tmp/workspaces/acme/widgets/run_1/scratch'
      });
      const materializer = createExecutionMaterializer({ provisionWorkspace: mockProvision });
      const context = makeContext({
        workspaceIntent: { shape: 'scratch_only', provisioning },
        run: { id: 'run_1', workKind: 'file_issue', currentStep: 'file', tenant: 'tenant_1' }
      });

      const result = await materializer.materialize(context);

      expect(mockProvision).toHaveBeenCalledOnce();
      expect(result.workspace.shape).toBe('scratch_only');
      if (result.workspace.shape === 'scratch_only') {
        expect(result.workspace.scratchRoot).toBe('/tmp/workspaces/acme/widgets/run_1/scratch');
        expect(result.workspace.workspaceRoots).toEqual(['/tmp/workspaces/acme/widgets/run_1/scratch']);
      }
    });

    it('two_roots shape: calls provisioner and returns both repoRoot and scratchRoot distinctly', async () => {
      const mockProvision = vi.fn().mockResolvedValue({
        shape: 'two_roots',
        runId: 'run_1',
        workspaceRoot: '/tmp/workspaces/acme/widgets',
        runRoot: '/tmp/workspaces/acme/widgets/run_1',
        repoRoot: '/tmp/workspaces/acme/widgets/run_1/repo',
        scratchRoot: '/tmp/workspaces/acme/widgets/run_1/scratch',
        hostRepositoryPath: '/tmp/repos/acme/widgets',
        branchName: 'feature/widgets-abc123'
      });
      const materializer = createExecutionMaterializer({ provisionWorkspace: mockProvision });
      const context = makeContext({ workspaceIntent: { shape: 'two_roots', provisioning } });

      const result = await materializer.materialize(context);

      expect(mockProvision).toHaveBeenCalledOnce();
      expect(result.workspace.shape).toBe('two_roots');
      if (result.workspace.shape === 'two_roots') {
        expect(result.workspace.repoRoot).toBe('/tmp/workspaces/acme/widgets/run_1/repo');
        expect(result.workspace.scratchRoot).toBe('/tmp/workspaces/acme/widgets/run_1/scratch');
        expect(result.workspace.branchName).toBe('feature/widgets-abc123');
        expect(result.workspace.workspaceRoots).toEqual([
          '/tmp/workspaces/acme/widgets/run_1/repo',
          '/tmp/workspaces/acme/widgets/run_1/scratch'
        ]);
      }
    });

    it('workspace provisioning failure wrapped as workspace_provisioning_failed', async () => {
      const mockProvision = vi.fn().mockRejectedValue(
        new WorkspaceProvisioningError('scratch_creation_failed', 'Failed to create scratch directory.')
      );
      const materializer = createExecutionMaterializer({ provisionWorkspace: mockProvision });
      const context = makeContext({ workspaceIntent: { shape: 'scratch_only', provisioning } });

      await expect(materializer.materialize(context)).rejects.toMatchObject({
        name: 'ExecutionMaterializationError',
        code: 'workspace_provisioning_failed'
      });
    });
  });

  describe('secret resolution', () => {
    it('resolves declared secrets by handle and places them in environment.variables', async () => {
      const mockProvision = vi.fn().mockResolvedValue({ shape: 'none', runId: 'run_1' });
      const mockSecretResolver = { resolveSecret: vi.fn().mockResolvedValue('secret-value-123') };
      const materializer = createExecutionMaterializer({
        provisionWorkspace: mockProvision,
        secretResolver: mockSecretResolver
      });
      const context = makeContext({
        workspaceIntent: { shape: 'none' },
        secretBindings: [{ handle: 'sec_abc123', envName: 'MY_TOKEN' }]
      });

      const result = await materializer.materialize(context);

      expect(mockSecretResolver.resolveSecret).toHaveBeenCalledWith('sec_abc123');
      expect(result.environment.variables['MY_TOKEN']).toBe('secret-value-123');
      expect(result.environment.secretVariableNames).toContain('MY_TOKEN');
    });

    it('process.env.SENTINEL_SHOULD_NOT_LEAK is absent from materialized variables', async () => {
      process.env['SENTINEL_SHOULD_NOT_LEAK'] = 'should-not-appear';
      const materializer = createExecutionMaterializer();
      const context = makeContext({ workspaceIntent: { shape: 'none' } });

      const result = await materializer.materialize(context);

      expect(result.environment.variables).not.toHaveProperty('SENTINEL_SHOULD_NOT_LEAK');
      delete process.env['SENTINEL_SHOULD_NOT_LEAK'];
    });

    it('missing secret resolver with non-empty bindings throws secret_resolution_failed', async () => {
      const materializer = createExecutionMaterializer(); // no secretResolver
      const context = makeContext({
        workspaceIntent: { shape: 'none' },
        secretBindings: [{ handle: 'sec_abc', envName: 'MY_TOKEN' }]
      });

      await expect(materializer.materialize(context)).rejects.toMatchObject({
        name: 'ExecutionMaterializationError',
        code: 'secret_resolution_failed'
      });
    });

    it('secret resolution failure wrapped as secret_resolution_failed with handle detail', async () => {
      const mockSecretResolver = {
        resolveSecret: vi.fn().mockRejectedValue(new Error('Secret not found.'))
      };
      const materializer = createExecutionMaterializer({ secretResolver: mockSecretResolver });
      const context = makeContext({
        workspaceIntent: { shape: 'none' },
        secretBindings: [{ handle: 'sec_missing', envName: 'API_KEY' }]
      });

      await expect(materializer.materialize(context)).rejects.toMatchObject({
        name: 'ExecutionMaterializationError',
        code: 'secret_resolution_failed',
        details: { handle: 'sec_missing' }
      });
    });
  });

  describe('capability materialization', () => {
    it('shell and lsp availability set from options', async () => {
      const materializer = createExecutionMaterializer({
        capabilities: { shellAvailable: true, lspAvailable: true }
      });
      const context = makeContext({ workspaceIntent: { shape: 'none' } });

      const result = await materializer.materialize(context);

      expect(result.capabilities.shell).toEqual({ kind: 'bash', available: true });
      expect(result.capabilities.lsp.available).toBe(true);
    });

    it('defaults to unavailable capabilities when not specified', async () => {
      const materializer = createExecutionMaterializer();
      const context = makeContext({ workspaceIntent: { shape: 'none' } });

      const result = await materializer.materialize(context);

      expect(result.capabilities.shell.available).toBe(false);
      expect(result.capabilities.lsp.available).toBe(false);
    });

    it('lsp.requested is taken from context capabilityRequirements', async () => {
      const materializer = createExecutionMaterializer();
      const context = makeContext({
        workspaceIntent: { shape: 'none' },
        capabilityRequirements: {
          shell: { kind: 'bash', required: false },
          paths: { canonicalWorkspacePaths: true },
          lsp: { requested: false }
        }
      });

      const result = await materializer.materialize(context);

      expect(result.capabilities.lsp.requested).toBe(false);
    });

    it('paths.repoRoot and scratchRoot set from two_roots workspace', async () => {
      const mockProvision = vi.fn().mockResolvedValue({
        shape: 'two_roots',
        runId: 'run_1',
        workspaceRoot: '/tmp/ws',
        runRoot: '/tmp/ws/run_1',
        repoRoot: '/tmp/ws/run_1/repo',
        scratchRoot: '/tmp/ws/run_1/scratch',
        hostRepositoryPath: '/tmp/repos/acme/widgets',
        branchName: 'feature/test-abc123'
      });
      const materializer = createExecutionMaterializer({ provisionWorkspace: mockProvision });
      const context = makeContext({ workspaceIntent: { shape: 'two_roots', provisioning } });

      const result = await materializer.materialize(context);

      expect(result.capabilities.paths.repoRoot).toBe('/tmp/ws/run_1/repo');
      expect(result.capabilities.paths.scratchRoot).toBe('/tmp/ws/run_1/scratch');
    });

    it('paths.scratchRoot set from scratch_only workspace, no repoRoot', async () => {
      const mockProvision = vi.fn().mockResolvedValue({
        shape: 'scratch_only',
        runId: 'run_1',
        workspaceRoot: '/tmp/ws',
        runRoot: '/tmp/ws/run_1',
        scratchRoot: '/tmp/ws/run_1/scratch'
      });
      const materializer = createExecutionMaterializer({ provisionWorkspace: mockProvision });
      const context = makeContext({
        workspaceIntent: { shape: 'scratch_only', provisioning },
        run: { id: 'run_1', workKind: 'file_issue', currentStep: 'file', tenant: 'tenant_1' }
      });

      const result = await materializer.materialize(context);

      expect(result.capabilities.paths.scratchRoot).toBe('/tmp/ws/run_1/scratch');
      expect(result.capabilities.paths.repoRoot).toBeUndefined();
    });

    it('no paths set from none workspace', async () => {
      const materializer = createExecutionMaterializer();
      const context = makeContext({ workspaceIntent: { shape: 'none' } });

      const result = await materializer.materialize(context);

      expect(result.capabilities.paths.repoRoot).toBeUndefined();
      expect(result.capabilities.paths.scratchRoot).toBeUndefined();
    });
  });

  describe('returned MaterializedExecutionEnvironment', () => {
    it('toolPolicy includes allowedTools from context and workspaceRoots from workspace', async () => {
      const mockProvision = vi.fn().mockResolvedValue({
        shape: 'scratch_only',
        runId: 'run_1',
        workspaceRoot: '/tmp/ws',
        runRoot: '/tmp/ws/run_1',
        scratchRoot: '/tmp/ws/run_1/scratch'
      });
      const materializer = createExecutionMaterializer({ provisionWorkspace: mockProvision });
      const context = makeContext({
        workspaceIntent: { shape: 'scratch_only', provisioning },
        toolPolicy: { allowedTools: ['bash', 'filesystem'], workspaceScope: 'declared_workspace' },
        run: { id: 'run_1', workKind: 'file_issue', currentStep: 'file', tenant: 'tenant_1' }
      });

      const result = await materializer.materialize(context);

      expect(result.toolPolicy.allowedTools).toEqual(['bash', 'filesystem']);
      expect(result.toolPolicy.workspaceRoots).toEqual(['/tmp/ws/run_1/scratch']);
    });

    it('skills carried through from context', async () => {
      const materializer = createExecutionMaterializer();
      const context = makeContext({
        workspaceIntent: { shape: 'none' },
        skills: { requested: ['stub_runner', 'code_reviewer'], plugins: ['some-plugin'] }
      });

      const result = await materializer.materialize(context);

      expect(result.skills.requested).toEqual(['stub_runner', 'code_reviewer']);
      expect(result.skills.plugins).toEqual(['some-plugin']);
    });

    it('original context is preserved in result', async () => {
      const materializer = createExecutionMaterializer();
      const context = makeContext({ workspaceIntent: { shape: 'none' } });

      const result = await materializer.materialize(context);

      expect(result.context).toBe(context);
    });
  });
});
