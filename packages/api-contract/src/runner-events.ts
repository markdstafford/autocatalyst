import { z } from 'zod';

import { jsonValueSchema } from './domain-value-objects.js';

export const runnerEventTypeSchema = z.enum([
  'runner_assistant_turn',
  'runner_tool_activity',
  'runner_progress',
  'runner_notification',
  'runner_step_checkpoint',
  'runner_terminal_result'
]);

export const runnerEventImportanceSchema = z.enum(['low', 'normal', 'high']);
export const runnerTerminalDirectiveSchema = z.enum(['advance', 'needs_input', 'fail']);

const baseEventFields = {
  id: z.string(),
  runId: z.string(),
  step: z.string(),
  importance: runnerEventImportanceSchema,
  createdAt: z.string().datetime()
};

const runnerProgressTaskProgressSchema = z.object({
  kind: z.literal('task_progress'),
  label: z.string().min(1),
  completed: z.number().int().min(0),
  total: z.number().int().min(1)
}).strict();

const runnerProgressPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plan'),
    title: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1)
  }).strict(),
  runnerProgressTaskProgressSchema,
  z.object({
    kind: z.literal('intent'),
    summary: z.string().min(1),
    data: z.record(jsonValueSchema).optional()
  }).strict()
]).superRefine((value, ctx) => {
  if (value.kind === 'task_progress' && value.completed > value.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['completed'],
      message: 'completed must not exceed total.'
    });
  }
});

const runnerNotificationPayloadSchema = z.object({
  severity: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().min(1)
}).strict();

const runnerStepCheckpointPayloadSchema = z.object({
  durable: z.literal(true),
  name: z.string().min(1),
  data: z.record(jsonValueSchema)
}).strict();

const runnerTerminalResultPayloadSchema = z.object({
  directive: runnerTerminalDirectiveSchema,
  question: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
}).strict().superRefine((value, ctx) => {
  if (value.directive === 'needs_input' && value.reason !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'needs_input terminal results use question, not reason.' });
  }
  if (value.directive === 'fail' && value.question !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['question'], message: 'fail terminal results use reason, not question.' });
  }
});

export const runnerEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseEventFields,
    type: z.literal('runner_assistant_turn'),
    message: z.object({ role: z.string(), content: z.string() }).strict()
  }).strict(),
  z.object({
    ...baseEventFields,
    type: z.literal('runner_tool_activity'),
    tool: z.object({ name: z.string(), action: z.string(), status: z.string() }).strict()
  }).strict(),
  z.object({
    ...baseEventFields,
    type: z.literal('runner_progress'),
    progress: runnerProgressPayloadSchema
  }).strict(),
  z.object({
    ...baseEventFields,
    type: z.literal('runner_notification'),
    notification: runnerNotificationPayloadSchema
  }).strict(),
  z.object({
    ...baseEventFields,
    type: z.literal('runner_step_checkpoint'),
    checkpoint: runnerStepCheckpointPayloadSchema
  }).strict(),
  z.object({
    ...baseEventFields,
    type: z.literal('runner_terminal_result'),
    result: runnerTerminalResultPayloadSchema
  }).strict()
]);

export type RunnerEventType = z.infer<typeof runnerEventTypeSchema>;
export type RunnerEventImportance = z.infer<typeof runnerEventImportanceSchema>;
export type RunnerTerminalDirective = z.infer<typeof runnerTerminalDirectiveSchema>;
export type RunnerAssistantTurnEvent = Extract<z.infer<typeof runnerEventSchema>, { type: 'runner_assistant_turn' }>;
export type RunnerToolActivityEvent = Extract<z.infer<typeof runnerEventSchema>, { type: 'runner_tool_activity' }>;
export type RunnerProgressEvent = Extract<z.infer<typeof runnerEventSchema>, { type: 'runner_progress' }>;
export type RunnerNotificationEvent = Extract<z.infer<typeof runnerEventSchema>, { type: 'runner_notification' }>;
export type RunnerStepCheckpointEvent = Extract<z.infer<typeof runnerEventSchema>, { type: 'runner_step_checkpoint' }>;
export type RunnerTerminalResultEvent = Extract<z.infer<typeof runnerEventSchema>, { type: 'runner_terminal_result' }>;
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
