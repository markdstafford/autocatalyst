import type { ExecutionContext } from '@autocatalyst/api-contract';
import type { ExecutionSecretResolver } from '../secret-resolver.js';
import type { MaterializedExecutionEnvironment } from '../materialized-environment.js';
import { ExecutionMaterializationError } from '../materialized-environment.js';
import { provisionWorkspace as defaultProvisionWorkspace, summarizeWorkspaceCause } from '../workspace.js';

export interface ExecutionMaterializerOptions {
  readonly secretResolver?: ExecutionSecretResolver;
  readonly provisionWorkspace?: typeof defaultProvisionWorkspace;
  readonly capabilities?: {
    readonly shellAvailable?: boolean;
    readonly lspAvailable?: boolean;
  };
}

export interface ExecutionMaterializer {
  materialize(context: ExecutionContext): Promise<MaterializedExecutionEnvironment>;
}

export function createExecutionMaterializer(options: ExecutionMaterializerOptions = {}): ExecutionMaterializer {
  const doProvision = options.provisionWorkspace ?? defaultProvisionWorkspace;

  return {
    async materialize(context: ExecutionContext): Promise<MaterializedExecutionEnvironment> {
      const intent = context.workspaceIntent;

      // 1. Workspace materialization
      let workspace: MaterializedExecutionEnvironment['workspace'];

      if (intent.shape === 'none') {
        workspace = { shape: 'none', workspaceRoots: [] };
      } else {
        const { provisioning } = intent;
        const provisionRequest = {
          runId: context.run.id,
          runKind: context.run.workKind as Parameters<typeof defaultProvisionWorkspace>[0]['runKind'],
          reposRoot: provisioning.roots.reposRoot,
          workspacesRoot: provisioning.roots.workspacesRoot,
          roots: provisioning.roots,
          topicSlug: provisioning.topicSlug,
          shortRunId: provisioning.shortRunId,
          project: provisioning.project,
          ...(provisioning.defaultBranch !== undefined ? { defaultBranch: provisioning.defaultBranch } : {})
        };

        let result: Awaited<ReturnType<typeof defaultProvisionWorkspace>>;
        try {
          result = await doProvision(provisionRequest);
        } catch (error) {
          throw new ExecutionMaterializationError(
            'workspace_provisioning_failed',
            'Workspace provisioning failed.',
            { cause: summarizeWorkspaceCause(error) }
          );
        }

        if (intent.shape === 'scratch_only') {
          if (result.shape !== 'scratch_only') {
            throw new ExecutionMaterializationError(
              'workspace_provisioning_failed',
              `Expected scratch_only provisioning result but got '${result.shape}'.`
            );
          }
          workspace = {
            shape: 'scratch_only',
            scratchRoot: result.scratchRoot,
            workspaceRoots: [result.scratchRoot]
          };
        } else {
          // two_roots
          if (result.shape !== 'two_roots') {
            throw new ExecutionMaterializationError(
              'workspace_provisioning_failed',
              `Expected two_roots provisioning result but got '${result.shape}'.`
            );
          }
          workspace = {
            shape: 'two_roots',
            repoRoot: result.repoRoot,
            scratchRoot: result.scratchRoot,
            branchName: result.branchName,
            workspaceRoots: [result.repoRoot, result.scratchRoot]
          };
        }
      }

      // 2. Secret resolution
      const secretBindings = context.secretBindings;
      const variables: Record<string, string> = {};
      const secretVariableNames: string[] = [];

      if (secretBindings.length > 0) {
        if (options.secretResolver === undefined) {
          throw new ExecutionMaterializationError(
            'secret_resolution_failed',
            'Secret bindings declared but no secret resolver is available.'
          );
        }

        for (const binding of secretBindings) {
          try {
            const value = await options.secretResolver.resolveSecret(binding.handle);
            variables[binding.envName] = value;
            secretVariableNames.push(binding.envName);
          } catch (error) {
            // Map known resolution codes to static sanitized messages; never include
            // the resolver's raw error.message which may contain secret material.
            const knownCode =
              error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              typeof (error as { code: unknown }).code === 'string'
                ? (error as { code: string }).code
                : undefined;
            const sanitizedReason =
              knownCode === 'missing_secret' ? 'Secret not found.'
              : knownCode === 'locked' ? 'Secret store is locked.'
              : knownCode === 'undecryptable' ? 'Secret could not be decrypted.'
              : knownCode === 'unavailable' ? 'Secret is unavailable.'
              : 'Secret resolution failed.';
            throw new ExecutionMaterializationError(
              'secret_resolution_failed',
              `Failed to resolve secret for handle '${binding.handle}': ${sanitizedReason}`,
              { handle: binding.handle }
            );
          }
        }
      }

      // 3. Capabilities
      const repoRoot = workspace.shape === 'two_roots' ? workspace.repoRoot : undefined;
      const scratchRoot = (workspace.shape === 'scratch_only' || workspace.shape === 'two_roots')
        ? workspace.scratchRoot
        : undefined;

      const capabilities: MaterializedExecutionEnvironment['capabilities'] = {
        shell: { kind: 'bash', available: options.capabilities?.shellAvailable ?? false },
        lsp: {
          requested: context.capabilityRequirements.lsp.requested,
          available: options.capabilities?.lspAvailable ?? false
        },
        paths: {
          ...(repoRoot !== undefined ? { repoRoot } : {}),
          ...(scratchRoot !== undefined ? { scratchRoot } : {})
        }
      };

      // 4. Return MaterializedExecutionEnvironment
      const skills: MaterializedExecutionEnvironment['skills'] =
        context.skills.plugins !== undefined
          ? { requested: context.skills.requested, plugins: context.skills.plugins }
          : { requested: context.skills.requested };

      return {
        context,
        workspace,
        environment: {
          variables,
          secretVariableNames
        },
        toolPolicy: {
          allowedTools: context.toolPolicy.allowedTools,
          workspaceRoots: workspace.workspaceRoots
        },
        skills,
        capabilities
      };
    }
  };
}
