import { z } from 'zod';

import { runSchema } from './run.js';
import { runStepSchema } from './run-step.js';
import {
  runnerEventSchema,
  type RunnerAssistantTurnEvent,
  type RunnerToolActivityEvent,
  type RunnerProgressEvent,
  type RunnerNotificationEvent,
  type RunnerStepCheckpointEvent
} from './runner-events.js';
import { runnerTerminalStepResultSchema } from './step-results.js';

export const runEventsPath = '/v1/runs/:id/events' as const;
export const runEventsSuccessStatusCode = 200 as const;
export const runEventsMediaType = 'text/event-stream' as const;
export const runStateTransitionEventName = 'run_state_transition' as const;

export const runStateTransitionKindSchema = z.enum(['start', 'advance', 'revise', 'needs_input', 'cancel', 'fail']);

const runStateTransitionPayloadSchema = z.object({
  directive: runStateTransitionKindSchema,
  fromStep: z.string().min(1).optional(),
  toStep: z.string().min(1),
  reason: z.string().min(1).optional()
}).strict().superRefine((value, ctx) => {
  if (value.reason !== undefined && value.directive !== 'fail') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reason'],
      message: 'transition.reason is only allowed for fail directives.'
    });
  }
});

export const runStateTransitionEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal(runStateTransitionEventName),
  runId: z.string().min(1),
  transition: runStateTransitionPayloadSchema,
  run: runSchema,
  runStep: runStepSchema,
  tenant: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();

export type RunStateTransitionKind = z.infer<typeof runStateTransitionKindSchema>;
export type RunStateTransitionEvent = z.infer<typeof runStateTransitionEventSchema>;

export const runRecoveryEventName = 'run_recovery' as const;

/**
 * Emitted when a failed run is recovered and reopened. Carries the recovery decision —
 * the mode that actually ran, the materialization base kind, the re-dispatch step, and
 * the workspace provisioning outcome — alongside the reopened run and new open run step.
 */
export const runRecoveryEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal(runRecoveryEventName),
  runId: z.string().min(1),
  recovery: z.object({
    mode: z.enum(['resume', 'start_over']),
    baseKind: z.enum(['run_branch', 'current_default_branch']),
    reDispatchStep: z.string().min(1),
    provisioningOutcome: z.enum(['present', 'materialized', 'none'])
  }).strict(),
  run: runSchema,
  runStep: runStepSchema,
  tenant: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();

export type RunRecoveryEvent = z.infer<typeof runRecoveryEventSchema>;

// Non-terminal runner event schemas, reused from runner-events.ts.
// Index 0-4 are non-terminal; index 5 is runner_terminal_result.
const [
  runnerAssistantTurnEventSchema,
  runnerToolActivityEventSchema,
  runnerProgressEventSchema,
  runnerNotificationEventSchema,
  runnerStepCheckpointEventSchema
] = runnerEventSchema.options;

// Client-facing terminal result event. Carries the validated runner terminal step
// result (the structured one from step-results.ts), not the raw runner payload.
export const runnerTerminalResultClientEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal('runner_terminal_result'),
  runId: z.string().min(1),
  step: z.string().min(1),
  importance: z.enum(['low', 'normal', 'high']),
  createdAt: z.string().datetime(),
  result: runnerTerminalStepResultSchema,
  resultContract: z.object({
    step: z.string().min(1),
    schemaId: z.string().min(1)
  }).strict().optional()
}).strict();

export const runEventFrameNameSchema = z.enum([
  'run_state_transition',
  'run_recovery',
  'runner_assistant_turn',
  'runner_tool_activity',
  'runner_progress',
  'runner_notification',
  'runner_step_checkpoint',
  'runner_terminal_result'
]);

export const clientRunEventSchema = z.discriminatedUnion('type', [
  runStateTransitionEventSchema,
  runRecoveryEventSchema,
  runnerAssistantTurnEventSchema,
  runnerToolActivityEventSchema,
  runnerProgressEventSchema,
  runnerNotificationEventSchema,
  runnerStepCheckpointEventSchema,
  runnerTerminalResultClientEventSchema
]);

export const runEventReplayStatusSchema = z.enum(['ok', 'unknown_event_id', 'expired_event_id']);

export const runEventReplayResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), events: z.array(clientRunEventSchema).readonly() }).strict(),
  z.object({ status: z.literal('unknown_event_id'), lastEventId: z.string().min(1) }).strict(),
  z.object({ status: z.literal('expired_event_id'), lastEventId: z.string().min(1) }).strict()
]);

export type RunEventFrameName = z.infer<typeof runEventFrameNameSchema>;
export type RunnerTerminalResultClientEvent = z.infer<typeof runnerTerminalResultClientEventSchema>;
export type ClientRunEvent = z.infer<typeof clientRunEventSchema>;
export type ClientRunnerEvent =
  | RunnerAssistantTurnEvent
  | RunnerToolActivityEvent
  | RunnerProgressEvent
  | RunnerNotificationEvent
  | RunnerStepCheckpointEvent
  | RunnerTerminalResultClientEvent;
export type RunEventReplayStatus = z.infer<typeof runEventReplayStatusSchema>;
export type RunEventReplayResult = z.infer<typeof runEventReplayResultSchema>;

export function formatRunEventFrameName(event: Pick<ClientRunEvent, 'type'>): RunEventFrameName {
  return runEventFrameNameSchema.parse(event.type);
}
