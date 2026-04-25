import { composeBuiltInWorkflowRuntime, type ComposeWorkflowRuntimeOptions } from '../adapters/runtime-composition.js';
import type { bootstrapWorkflowRuntime } from './bootstrap.js';

export type { ComposeWorkflowRuntimeOptions };

export async function composeWorkflowRuntime(
  options: ComposeWorkflowRuntimeOptions,
): Promise<ReturnType<typeof bootstrapWorkflowRuntime>> {
  return composeBuiltInWorkflowRuntime(options);
}
