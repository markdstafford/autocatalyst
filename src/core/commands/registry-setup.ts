import type { CommandRegistry } from '../../types/commands.js';
import type { Run, RunStage } from '../../types/runs.js';
import type { IntentClassifier } from '../../types/intent.js';
import { makeClassifyIntentHandler } from './classify-intent-command.js';
import { makeHealthHandler, makeHelpHandler } from './meta-commands.js';
import {
  makeRunCancelHandler,
  makeRunListHandler,
  makeRunLogsHandler,
  makeRunStatusHandler,
} from './run-commands.js';
import { createSetStatusHandler } from './set-status-command.js';

export interface DefaultCommandDeps {
  runs: Map<string, Run>;
  cancelRun: (requestId: string) => 'cancelled' | 'already_terminal' | 'not_found';
  getRunLogs: (requestId: string) => string[];
  isConnected: () => boolean;
  getActiveRunCount: () => number;
  intentClassifier: IntentClassifier;
  overrideRunStage: (requestId: string, stage: RunStage) => 'updated' | 'not_found' | 'invalid_stage';
}

export function registerDefaultCommands(registry: CommandRegistry, deps: DefaultCommandDeps): void {
  registry.register(
    'run.status',
    makeRunStatusHandler(deps.runs),
    'Show the current stage, intent, and time in stage for a run. Usage: `:ac-run-status:` (in thread) or `:ac-run-status: <run-id>`',
  );
  registry.register(
    'run.list',
    makeRunListHandler(deps.runs),
    'List all active runs. Usage: `:ac-run-list:`',
  );
  registry.register(
    'run.cancel',
    makeRunCancelHandler(deps.runs, deps.cancelRun),
    'Cancel an active run. Usage: `:ac-run-cancel:` (in thread) or `:ac-run-cancel: <run-id>`',
  );
  registry.register(
    'run.logs',
    makeRunLogsHandler(deps.runs, deps.getRunLogs),
    'Show the log tail for a run. Usage: `:ac-run-logs:` (in thread) or `:ac-run-logs: <run-id>`',
  );
  registry.register(
    'health',
    makeHealthHandler(deps.isConnected, deps.getActiveRunCount),
    'Check system health and active run count. Usage: `:ac-health:`',
  );
  registry.register(
    'help',
    makeHelpHandler(registry),
    'Show available commands. Usage: `:ac-help:` or `:ac-help: <command>`',
  );
  registry.register(
    'classify-intent',
    makeClassifyIntentHandler(deps.intentClassifier),
    'Test how a message would be classified. Usage: `:ac-classify-intent: <message>` or `:ac-classify-intent: <context> <message>`',
  );
  registry.register(
    'run.set-status',
    createSetStatusHandler({
      findRunById: (requestId: string) => deps.runs.get(requestId),
      overrideRunStage: deps.overrideRunStage,
    }),
    "Override a stuck run's stage. Usage: post the target stage name in a run thread, then react with `:ac-set-status:`",
  );
}
