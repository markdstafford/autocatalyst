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

export const issueReferenceSubmissionSchema = z.object({
  kind: z.literal('issue_reference'),
  body: z.string().min(1),
  issue: z.object({ number: z.number().int().min(1) }).strict()
}).strict();

export const freeFormSubmissionSchema = z.object({
  kind: z.literal('free_form'),
  body: z.string().min(1),
  workKind: createRunWorkKindSchema.optional(),
  trackedIssue: trackedIssueSchema.optional()
}).strict();

export const explicitWorkSubmissionSchema = z.object({
  kind: z.enum(['question', 'list_to_file']),
  body: z.string().min(1),
  workKind: createRunWorkKindSchema,
  trackedIssue: trackedIssueSchema.optional()
}).strict();

export const createConversationSubmissionSchema = z.discriminatedUnion('kind', [
  issueReferenceSubmissionSchema,
  freeFormSubmissionSchema,
  explicitWorkSubmissionSchema
]);

export const createConversationWithFirstRunRequestSchema = z.object({
  projectId: z.string().min(1),
  identity: z.string().min(1),
  channel: channelReferenceSchema.optional(),
  topic: z.object({ title: z.string().min(1) }).strict(),
  submission: createConversationSubmissionSchema
}).strict();

export const createConversationWithFirstRunResponseSchema = z.object({
  conversation: conversationSchema,
  topic: topicSchema,
  message: messageSchema.optional(),
  run: runSchema,
  runStep: runStepSchema
}).strict();

export type SubmissionKind = z.infer<typeof submissionKindSchema>;
export type IssueReferenceSubmission = z.infer<typeof issueReferenceSubmissionSchema>;
export type FreeFormSubmission = z.infer<typeof freeFormSubmissionSchema>;
export type ExplicitWorkSubmission = z.infer<typeof explicitWorkSubmissionSchema>;
export type CreateConversationSubmission = z.infer<typeof createConversationSubmissionSchema>;
export type CreateConversationWithFirstRunRequest = z.infer<typeof createConversationWithFirstRunRequestSchema>;
export type CreateConversationWithFirstRunResponse = z.infer<typeof createConversationWithFirstRunResponseSchema>;
