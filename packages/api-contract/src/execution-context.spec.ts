import { describe, expect, it } from 'vitest';
import { executionContextSchema } from './execution-context.js';

const owner = { id: 'user_1', kind: 'human' as const, tenantId: 'tenant_1' };
const project = {
  id: 'project_1', owner, tenant: 'tenant_1', displayName: 'Widgets', repoUrl: 'https://example.com/acme/widgets.git',
  hostRepository: { provider: 'github', owner: 'acme', name: 'widgets', url: 'https://example.com/acme/widgets.git' },
  workspaceRootOverride: null, issueTrackerSetting: null, codeHostSetting: null, credentialRefs: [],
  createdAt: '2026-06-09T00:00:00.000Z', updatedAt: '2026-06-09T00:00:00.000Z'
};
const base = {
  run: { id: 'run_1', workKind: 'feature', currentStep: 'implement', tenant: 'tenant_1' },
  task: { prompt: 'Implement feature', inputs: { trackedIssue: { number: 21 } } },
  secretBindings: [{ handle: 'sec_test_handle', envName: 'MODEL_API_KEY' }],
  toolPolicy: { allowedTools: ['bash', 'filesystem'], workspaceScope: 'declared_workspace' as const },
  skills: { requested: ['implementation'], plugins: ['stub'] },
  capabilityRequirements: {
    shell: { kind: 'bash' as const, required: false },
    paths: { canonicalWorkspacePaths: true },
    lsp: { requested: true }
  }
};
const provisioning = { project, roots: { reposRoot: 'repos-main', workspacesRoot: 'workspaces-main' }, topicSlug: 'widgets', shortRunId: 'abc123', defaultBranch: 'main' };

describe('execution context contract', () => {
  it('validates no-workspace context', () => {
    const context = { ...base, workspaceIntent: { shape: 'none' as const } };
    expect(executionContextSchema.parse(context)).toEqual(context);
  });

  it('validates scratch-only and two-root intents with provisioning inputs', () => {
    expect(executionContextSchema.parse({ ...base, workspaceIntent: { shape: 'scratch_only', provisioning } }).workspaceIntent.shape).toBe('scratch_only');
    expect(executionContextSchema.parse({ ...base, workspaceIntent: { shape: 'two_roots', provisioning } }).workspaceIntent.shape).toBe('two_roots');
  });

  it('rejects materialized workspace paths, plaintext secret values, and availability flags', () => {
    expect(() => executionContextSchema.parse({ ...base, workspaceIntent: { shape: 'two_roots', provisioning }, repoRoot: '/tmp/repo' })).toThrow();
    expect(() => executionContextSchema.parse({ ...base, workspaceIntent: { shape: 'none' }, secretBindings: [{ handle: 'sec_test_handle', envName: 'MODEL_API_KEY', value: 'plaintext' }] })).toThrow();
    expect(() => executionContextSchema.parse({ ...base, workspaceIntent: { shape: 'none' }, capabilityRequirements: { ...base.capabilityRequirements, shell: { kind: 'bash', required: false, available: true } } })).toThrow();
  });
});
