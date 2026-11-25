import type { ClientRunEvent } from '@autocatalyst/api-contract';

type EventByType = { [Event in ClientRunEvent as Event['type']]: Event };

export const activityEventText: { [Type in keyof EventByType]: (event: EventByType[Type]) => string | null } = {
  run_state_transition: () => null,
  run_recovery: ({ recovery }) => recovery.mode === 'resume' ? 'Recovery: Resume' : 'Recovery: Start over',
  runner_assistant_turn: ({ message }) => message.content.split(/\r\n?|\n/u, 1)[0] ?? '',
  runner_tool_activity: ({ tool }) => `${tool.name} · ${tool.action} · ${tool.status}`,
  runner_progress: ({ progress }) => {
    switch (progress.kind) {
      case 'plan': return progress.title;
      case 'task_progress': return `${progress.label} ${progress.completed} of ${progress.total}`;
      case 'intent': return progress.summary;
    }
  },
  runner_notification: ({ notification }) => `${notification.severity}: ${notification.message}`,
  runner_step_checkpoint: ({ checkpoint }) => checkpoint.name,
  runner_terminal_result: ({ result }) => {
    const detail = result.question ?? result.reason;
    return detail === undefined ? result.directive : `${result.directive}: ${detail}`;
  }
};

export function formatActivityEvent<Type extends keyof EventByType>(event: EventByType[Type] & { type: Type }): string | null {
  return activityEventText[event.type](event);
}
