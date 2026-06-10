// Provider-neutral progress tool schemas used by the stub/tool seam only.
// Real provider runners would translate their tool calls into these inputs and
// then re-emit them as runner_progress / runner_notification events.
import { z } from 'zod';
import { runnerEventImportanceSchema } from '@autocatalyst/api-contract';

export const runnerProgressToolNameSchema = z.enum(['update_plan', 'report_progress', 'notify']);

export const updatePlanToolInputSchema = z.object({
  title: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1)
}).strict();

export const reportProgressToolInputSchema = z.object({
  label: z.string().min(1).optional(),
  completed: z.number().int().min(0).optional(),
  total: z.number().int().min(1).optional(),
  summary: z.string().min(1).optional()
}).strict();

export const notifyToolInputSchema = z.object({
  message: z.string().min(1),
  severity: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  importance: runnerEventImportanceSchema.optional()
}).strict();

export type RunnerProgressToolName = z.infer<typeof runnerProgressToolNameSchema>;
export type UpdatePlanToolInput = z.infer<typeof updatePlanToolInputSchema>;
export type ReportProgressToolInput = z.infer<typeof reportProgressToolInputSchema>;
export type NotifyToolInput = z.infer<typeof notifyToolInputSchema>;
