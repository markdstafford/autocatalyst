import type { LoadedConfig } from '../types/config.js';
import type { CommandRegistry } from '../types/commands.js';
import type { IntentClassifier } from '../types/intent.js';
import { CommandRegistryImpl } from './command-registry.js';
import { registerDefaultCommands } from './commands/registry-setup.js';
import { OrchestratorImpl, type OrchestratorDeps } from './orchestrator.js';
import { Service } from './service.js';

export interface BootstrapWorkflowRuntimeDeps extends Omit<OrchestratorDeps, 'commandRegistry'> {
  commandRegistry?: OrchestratorDeps['commandRegistry'];
  intentClassifier: IntentClassifier;
  isConnected: () => boolean;
}

export function bootstrapWorkflowRuntime(
  config: LoadedConfig,
  deps: BootstrapWorkflowRuntimeDeps,
): {
  commandRegistry: CommandRegistry;
  orchestrator: OrchestratorImpl;
  service: Service;
} {
  const commandRegistry = deps.commandRegistry ?? new CommandRegistryImpl();
  const orchestrator = new OrchestratorImpl({
    ...deps,
    commandRegistry,
  });

  registerDefaultCommands(commandRegistry, {
    runs: orchestrator.getRuns(),
    cancelRun: requestId => orchestrator.cancelRun(requestId),
    getRunLogs: requestId => orchestrator.getRunLogs(requestId),
    isConnected: deps.isConnected,
    getActiveRunCount: () => orchestrator.getActiveRunCount(),
    intentClassifier: deps.intentClassifier,
  });

  const service = new Service(config, { orchestrator });
  return { commandRegistry, orchestrator, service };
}
