import { z } from 'zod';

import { channelReferenceSchema, trackedIssueSchema } from './domain-value-objects.js';
import { conversationSchema } from './conversation.js';
import { messageSchema } from './message.js';
import { createRunWorkKindSchema, runSchema } from './run.js';
import { runStepSchema } from './run-step.js';
import { topicSchema } from './topic.js';

export const conversationCollectionPath = '/v1/conversations' as const;
export const createConversationSuccessStatusCode = 201 as const;

export const submissionKindSchema = z.enum(['issue_reference', 'free_form', 'question', 'list_to_file']);

export const createConversationWithFirstRunRequestSchema = z.object({
  projectId: z.string().min(1),
  identity: z.string().min(1),
  channel: channelReferenceSchema.optional(),
  topic: z.object({ title: z.string().min(1) }).strict(),
  submission: z.object({
    kind: submissionKindSchema,
    body: z.string().min(1),
    workKind: createRunWorkKindSchema,
    trackedIssue: trackedIssueSchema.optional()
  }).strict()
}).strict();

export const createConversationWithFirstRunResponseSchema = z.object({
  conversation: conversationSchema,
  topic: topicSchema,
  message: messageSchema.optional(),
  run: runSchema,
  runStep: runStepSchema
}).strict();

export type SubmissionKind = z.infer<typeof submissionKindSchema>;
export type CreateConversationWithFirstRunRequest = z.infer<typeof createConversationWithFirstRunRequestSchema>;
export type CreateConversationWithFirstRunResponse = z.infer<typeof createConversationWithFirstRunResponseSchema>;
