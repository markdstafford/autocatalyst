import { z } from 'zod';

import { jsonValueSchema } from './domain-value-objects.js';
import { projectSchema } from './project.js';

export const executionRunContextSchema = z.object({
  id: z.string().min(1),
  workKind: z.string().min(1),
  currentStep: z.string().min(1),
  tenant: z.string().min(1)
}).strict();

export const executionTaskContextSchema = z.object({
  prompt: z.string().min(1),
  inputs: z.record(jsonValueSchema)
}).strict();

export const workspaceRootRefsSchema = z.object({
  reposRoot: z.string().min(1),
  workspacesRoot: z.string().min(1)
}).strict();

export const workspaceProvisioningIntentSchema = z.object({
  project: projectSchema,
  roots: workspaceRootRefsSchema,
  topicSlug: z.string().min(1),
  shortRunId: z.string().min(1),
  defaultBranch: z.string().min(1).optional()
}).strict();

export const workspaceIntentSchema = z.discriminatedUnion('shape', [
  z.object({ shape: z.literal('none') }).strict(),
  z.object({ shape: z.literal('scratch_only'), provisioning: workspaceProvisioningIntentSchema }).strict(),
  z.object({ shape: z.literal('two_roots'), provisioning: workspaceProvisioningIntentSchema }).strict()
]);

export const secretBindingSchema = z.object({
  handle: z.string().min(1),
  envName: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u)
}).strict();

export const toolPolicySchema = z.object({
  allowedTools: z.array(z.string().min(1)),
  workspaceScope: z.literal('declared_workspace')
}).strict();

export const skillIntentSchema = z.object({
  requested: z.array(z.string().min(1)),
  plugins: z.array(z.string().min(1)).optional()
}).strict();

export const capabilityRequirementsSchema = z.object({
  shell: z.object({
    kind: z.literal('bash'),
    required: z.boolean()
  }).strict(),
  paths: z.object({
    canonicalWorkspacePaths: z.boolean()
  }).strict(),
  lsp: z.object({
    requested: z.boolean()
  }).strict()
}).strict();

export const executionContextSchema = z.object({
  run: executionRunContextSchema,
  task: executionTaskContextSchema,
  workspaceIntent: workspaceIntentSchema,
  secretBindings: z.array(secretBindingSchema),
  toolPolicy: toolPolicySchema,
  skills: skillIntentSchema,
  capabilityRequirements: capabilityRequirementsSchema
}).strict();

export type ExecutionRunContext = z.infer<typeof executionRunContextSchema>;
export type ExecutionTaskContext = z.infer<typeof executionTaskContextSchema>;
export type WorkspaceRootRefs = z.infer<typeof workspaceRootRefsSchema>;
export type WorkspaceProvisioningIntent = z.infer<typeof workspaceProvisioningIntentSchema>;
export type WorkspaceIntent = z.infer<typeof workspaceIntentSchema>;
export type SecretBinding = z.infer<typeof secretBindingSchema>;
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type SkillIntent = z.infer<typeof skillIntentSchema>;
export type CapabilityRequirements = z.infer<typeof capabilityRequirementsSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
