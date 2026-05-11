// src/core/commands/set-status-command.ts
import type { CommandHandler } from '../../types/commands.js';
import type { Run, RunStage } from '../../types/runs.js';
import { VALID_RUN_STAGES } from '../../types/runs.js';

export interface SetStatusCommandDeps {
  findRunById: (requestId: string) => Run | undefined;
  overrideRunStage: (requestId: string, stage: RunStage) => 'updated' | 'not_found' | 'invalid_stage';
}

const VALID_STAGES_LIST = VALID_RUN_STAGES.join(', ');

export function createSetStatusHandler(deps: SetStatusCommandDeps): CommandHandler {
  return async (event, reply) => {
    const stage = (event.messageText ?? '').trim().toLowerCase();

    if (!stage) {
      await reply(
        `React to a message containing the target stage name. Valid stages: ${VALID_STAGES_LIST}.`,
      );
      return;
    }

    const requestId = event.inferred_context?.request_id;
    const run = requestId !== undefined ? deps.findRunById(requestId) : undefined;

    if (!run) {
      await reply(':ac-set-status: can only be used in a thread linked to an active run.');
      return;
    }

    if (!VALID_RUN_STAGES.includes(stage as RunStage)) {
      await reply(
        `Unknown stage "${stage}". Valid stages: ${VALID_STAGES_LIST}.`,
      );
      return;
    }

    const previousStage = run.stage;
    const result = deps.overrideRunStage(requestId!, stage as RunStage);

    if (result === 'updated') {
      await reply(
        `Run ${run.id.slice(0, 8)}... stage updated: ${previousStage} → ${stage}. Change persisted.`,
      );
    } else if (result === 'not_found') {
      await reply(':ac-set-status: can only be used in a thread linked to an active run.');
    } else {
      await reply(
        `Unknown stage "${stage}". Valid stages: ${VALID_STAGES_LIST}.`,
      );
    }
  };
}
