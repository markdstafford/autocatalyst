import { z } from 'zod';

export const specArtifactKindSchema = z.enum(['feature_spec', 'enhancement_spec']);
export const committedSpecStatusSchema = z.enum(['draft', 'approved', 'implementing', 'complete', 'superseded']);

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const githubUsernameOrServiceSchema = z.string().superRefine((value, ctx) => {
  if (value === 'autocatalyst') return;
  if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)) return;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a GitHub username or autocatalyst service identity.' });
});
const specSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const specRelativePathSchema = z.string()
  .regex(/^context-human\/specs\/(feature|enhancement)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u)
  .refine((value) => !value.startsWith('/') && !value.includes('..'), 'Spec relativePath must stay under context-human/specs.');

export const specAuthorFrontmatterSchema = z.object({
  created: dateOnlySchema,
  last_updated: dateOnlySchema,
  status: committedSpecStatusSchema,
  issue: z.number().int().positive().optional(),
  specced_by: githubUsernameOrServiceSchema,
  implemented_by: githubUsernameOrServiceSchema.optional(),
  supersedes: specSlugSchema.optional(),
  superseded_by: specSlugSchema.optional()
}).strict();

export const specAuthorResultSchema = z.object({
  kind: specArtifactKindSchema,
  slug: specSlugSchema,
  relativePath: specRelativePathSchema,
  frontmatter: specAuthorFrontmatterSchema,
  body: z.string().trim().min(1)
}).strict().superRefine((value, ctx) => {
  const expectedPrefix = value.kind === 'feature_spec' ? 'feature' : 'enhancement';
  const expectedPath = `context-human/specs/${expectedPrefix}-${value.slug}.md`;
  if (value.relativePath !== expectedPath) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['relativePath'], message: `Expected ${expectedPath}.` });
  }
});

export type SpecArtifactKind = z.infer<typeof specArtifactKindSchema>;
export type CommittedSpecStatus = z.infer<typeof committedSpecStatusSchema>;
export type SpecAuthorFrontmatter = z.infer<typeof specAuthorFrontmatterSchema>;
export type SpecAuthorResult = z.infer<typeof specAuthorResultSchema>;
