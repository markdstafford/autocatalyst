import { z } from 'zod';

import { artifactSchema } from './artifact.js';
import { specAuthorFrontmatterSchema } from './spec-authoring.js';

export const runSpecPath = '/v1/runs/:id/spec' as const;
export const getRunSpecSuccessStatusCode = 200 as const;

export const runSpecResponseSchema = z.object({
  artifact: artifactSchema,
  markdown: z.string(),
  frontmatter: specAuthorFrontmatterSchema
}).strict();

export type RunSpecResponse = z.infer<typeof runSpecResponseSchema>;
