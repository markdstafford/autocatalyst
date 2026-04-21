import type { CommandHandler } from '../../types/commands.js';
import type { Run } from '../../types/runs.js';

function findRun(runs: Map<string, Run>, requestId: string | undefined, idArg: string | undefined): Run | undefined {
  if (requestId) {
    return runs.get(requestId);
  }
  if (idArg) {
    // Try by request_id first, then by run.id
    const byRequestId = runs.get(idArg);
    if (byRequestId) return byRequestId;
    return [...runs.values()].find(r => r.id === idArg);
  }
  return undefined;
}

function formatTimeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function makeRunStatusHandler(runs: Map<string, Run>): CommandHandler {
  return async (event, reply) => {
    const requestId = event.inferred_context?.request_id;
    const idArg = event.args[0];

    if (!requestId && !idArg) {
      await reply('No run found in this thread. Use `:ac-run-list:` to see all active runs, or provide a run ID as an argument.');
      return;
    }

    const run = findRun(runs, requestId, idArg);
    if (!run) {
      await reply('no active run found with that ID. Use `:ac-run-list:` to see all active runs.');
      return;
    }

    const timeInStage = formatTimeSince(run.updated_at);
    const stageSuffix = run.stage === 'done' ? ' ✓ (complete)' : run.stage === 'failed' ? ' ✗ (failed)' : '';
    await reply(
      `*Run:* \`${run.id}\`\n*Stage:* \`${run.stage}\`${stageSuffix}\n*Intent:* \`${run.intent}\`\n*Time in stage:* ${timeInStage}`,
    );
  };
}

export function makeRunListHandler(runs: Map<string, Run>): CommandHandler {
  return async (_event, reply) => {
    const active = [...runs.values()].filter(r => r.stage !== 'done' && r.stage !== 'failed');
    if (active.length === 0) {
      await reply('No active runs.');
      return;
    }
    const lines = active.map(r => `• \`${r.id}\` — \`${r.stage}\` (${r.intent})`);
    await reply(`*Active runs (${active.length}):*\n${lines.join('\n')}`);
  };
}

export function makeRunCancelHandler(
  runs: Map<string, Run>,
  cancelRun: (requestId: string) => 'cancelled' | 'already_terminal' | 'not_found',
): CommandHandler {
  return async (event, reply) => {
    const requestId = event.inferred_context?.request_id;
    const idArg = event.args[0];

    if (!requestId && !idArg) {
      await reply('No run found in this thread. Provide a run ID as an argument or use this command inside a run thread.');
      return;
    }

    const run = findRun(runs, requestId, idArg);
    if (!run) {
      await reply('no active run found with that ID. Use `:ac-run-list:` to see active runs.');
      return;
    }

    const result = cancelRun(run.request_id);
    if (result === 'cancelled') {
      await reply(`Run \`${run.id}\` has been cancelled.`);
    } else if (result === 'already_terminal') {
      await reply(`Run \`${run.id}\` is no longer active (current stage: \`${run.stage}\`).`);
    } else {
      await reply('No active run found. Use `:ac-run-list:` to see active runs.');
    }
  };
}
