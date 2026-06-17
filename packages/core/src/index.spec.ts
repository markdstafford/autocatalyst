import { describe, expect, it } from 'vitest';

import { IssueTrackerError, StaticIssueTrackerRegistry } from './index.js';
import {
  buildProviderAdapterKey,
  composeConfiguredProviders,
  createExtensionRegistryCatalog,
  createProbeResource,
  defaultExtensionRegistryCatalog,
  emptyProviderAdapterMap,
  getHealth,
  validateProviderConfigurationAgainstRegistry,
  DefaultOrchestrator,
  OrchestratorError,
  DefaultControlPlaneService,
  ControlPlaneServiceError,
  InMemoryRunEventBus,
  RunDispatchQueue
} from './index.js';
import type { ProjectRepository, RunRepository, PullRequestRepository, ControlPlaneService, RunUnitOfWork } from './index.js';

describe('core barrel', () => {
  it('exports core service behavior', () => {
    expect(getHealth).toBeTypeOf('function');
    expect(createProbeResource).toBeTypeOf('function');
  });

  it('exports extension registry behavior', () => {
    expect(createExtensionRegistryCatalog).toBeTypeOf('function');
    expect(defaultExtensionRegistryCatalog.list()).toEqual([]);
    expect(validateProviderConfigurationAgainstRegistry).toBeTypeOf('function');
  });

  it('exports provider composition behavior', () => {
    expect(buildProviderAdapterKey('model_runner', 'fake')).toBe(JSON.stringify(['model_runner', 'fake']));
    expect(emptyProviderAdapterMap.size).toBe(0);
    expect(composeConfiguredProviders).toBeTypeOf('function');
  });

  it('exports domain repository interface types for TypeScript consumers', () => {
    const projectRepository = undefined as unknown as ProjectRepository;
    const runRepository = undefined as unknown as RunRepository;
    const pullRequestRepository = undefined as unknown as PullRequestRepository;
    expect(projectRepository).toBeUndefined();
    expect(runRepository).toBeUndefined();
    expect(pullRequestRepository).toBeUndefined();
  });

  it('exports orchestrator service APIs', () => {
    expect(DefaultOrchestrator).toBeTypeOf('function');
    expect(OrchestratorError).toBeTypeOf('function');
    expect(DefaultControlPlaneService).toBeTypeOf('function');
    expect(ControlPlaneServiceError).toBeTypeOf('function');
    expect(InMemoryRunEventBus).toBeTypeOf('function');
    expect(RunDispatchQueue).toBeTypeOf('function');
  });

  it('exports orchestrator service interface types for TypeScript consumers', () => {
    const controlPlaneService = undefined as unknown as ControlPlaneService;
    const runUnitOfWork = undefined as unknown as RunUnitOfWork;
    expect(controlPlaneService).toBeUndefined();
    expect(runUnitOfWork).toBeUndefined();
  });

  it('exports spec authoring and feedback gate APIs', async () => {
    const core = await import('./index.js');
    expect(core.completeSpecAuthoring).toBeTypeOf('function');
    expect(core.createArtifactFeedback).toBeTypeOf('function');
    expect(core.assertSpecReviewGateCanAdvance).toBeTypeOf('function');
    expect(core.finalizeSpecApproval).toBeTypeOf('function');
  });

  it('exports reviewed role dispatcher contract version', async () => {
    const core = await import('./index.js');
    expect(core.reviewedRoleDispatcherContractVersion).toBe('reviewed-role-dispatcher.v1');
  });

  it('exports default reviewer workspace policy', async () => {
    const core = await import('./index.js');
    expect(core.defaultReviewerWorkspacePolicy).toMatchObject({ fileAccess: 'read_only', gitAccess: 'read_only' });
    expect(core.defaultReviewerWorkspacePolicy.forbiddenGitActions).toEqual(
      expect.arrayContaining(['commit', 'push', 'merge', 'checkout', 'switch', 'reset', 'rebase'])
    );
  });

  it('exports tracker error and registry construction', () => {
    expect(new IssueTrackerError('tracker_not_configured', 'No tracker configured.').code).toBe('tracker_not_configured');
    expect(new StaticIssueTrackerRegistry({}).get('github')).toBeNull();
  });
});
