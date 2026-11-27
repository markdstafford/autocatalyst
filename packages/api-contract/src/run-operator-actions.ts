import { z } from 'zod';

import { runResourcePath, runSchema } from './run.js';

export const cancelRunPath = '/v1/runs/:id/cancel' as const;
export const archiveRunPath = '/v1/runs/:id/archive' as const;
export const unarchiveRunPath = '/v1/runs/:id/unarchive' as const;
export const setRunStepPath = '/v1/runs/:id/set-step' as const;
export const renameRunPath = runResourcePath;

export const emptyRunActionRequestSchema = z.object({}).strict();
export const setRunStepRequestSchema = z.object({ step: z.string().min(1) }).strict();
export const renameRunRequestSchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();
export const runActionResponseSchema = z.object({ run: runSchema }).strict();

export type SetRunStepRequest = z.infer<typeof setRunStepRequestSchema>;
export type RenameRunRequest = z.infer<typeof renameRunRequestSchema>;
export type RunActionResponse = z.infer<typeof runActionResponseSchema>;
