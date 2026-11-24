import { z } from 'zod';

import { runWorkKindSchema, waitingOnSchema } from './run.js';

const idSchema = z.string().min(1);

export const runWorkflowPath = '/v1/runs/:id/workflow' as const;
export const getRunWorkflowSuccessStatusCode = 200 as const;

export const runWorkflowResponseSchema = z.object({
  workflowId: idSchema.describe('Built-in workflow family ID. It is not a unique definition ID, version, or cache key.'),
  workKind: runWorkKindSchema,
  phases: z.array(z.object({
    id: idSchema,
    label: z.string().regex(/\S/),
    steps: z.array(idSchema)
  }).strict()),
  steps: z.array(z.object({
    id: idSchema,
    phase: idSchema.nullable(),
    kind: z.enum(['work', 'gate', 'pause', 'terminal']),
    waitingOn: waitingOnSchema,
    roles: z.array(z.enum(['implementer', 'reviewer'])),
    onPath: z.boolean()
  }).strict()),
  transitions: z.array(z.object({
    from: idSchema,
    directive: z.enum(['advance', 'revise', 'needs_input']),
    to: idSchema
  }).strict()).describe(
    'Explicit transition table edges. Cancel and fail lead from every nonterminal step to canceled and failed, respectively, and are not listed. ' +
    'Recover reopens a failed run using its stopped step and recovery mode. Set step moves a run back to a step it already reached. Both moves are outside the table.'
  )
}).strict();

export type RunWorkflowResponse = z.infer<typeof runWorkflowResponseSchema>;
