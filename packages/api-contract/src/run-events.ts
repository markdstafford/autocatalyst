import { z } from 'zod';

import { runSchema } from './run.js';
import { runStepSchema } from './run-step.js';

export const runEventsPath = '/v1/runs/:id/events' as const;
export const runEventsSuccessStatusCode = 200 as const;
export const runEventsMediaType = 'text/event-stream' as const;
export const runStateTransitionEventName = 'run_state_transition' as const;

export const runStateTransitionKindSchema = z.enum(['start', 'advance', 'revise', 'needs_input', 'cancel', 'fail']);

export const runStateTransitionEventSchema = z.object({
  id: z.string().min(1),
  type: z.literal(runStateTransitionEventName),
  runId: z.string().min(1),
  transition: z.object({
    directive: runStateTransitionKindSchema,
    fromStep: z.string().min(1).optional(),
    toStep: z.string().min(1)
  }).strict(),
  run: runSchema,
  runStep: runStepSchema,
  tenant: z.string().min(1),
  createdAt: z.string().datetime()
}).strict();

export type RunStateTransitionKind = z.infer<typeof runStateTransitionKindSchema>;
export type RunStateTransitionEvent = z.infer<typeof runStateTransitionEventSchema>;
