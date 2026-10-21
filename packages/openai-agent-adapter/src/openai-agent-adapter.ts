import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Runner, OpenAIProvider, tool, MaxTurnsExceededError } from '@openai/agents';
import {
  SandboxAgent,
  Manifest,
  NoopSnapshotSpec,
  isNoopSnapshotSpec,
  localDir,
  skills as sdkSkills,
  filesystem as sdkFilesystem,
  shell as sdkShell,
  compaction as sdkCompaction
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import type { RunItem } from '@openai/agents';
import type { SandboxClient, SandboxSessionLike } from '@openai/agents/sandbox';
import OpenAI from 'openai';
import { z } from 'zod/v4';

import type {
  AgentProviderAdapter,
  AgentProviderSession,
  AgentProviderSessionInput,
  AgentProviderSessionMetadata,
  ProviderCapabilityDegradation,
  ProviderFetchTransport,
  ProviderRequest,
  ProviderSchemaProjection,
  StructuredAgentResultCapture
} from '@autocatalyst/execution';
import {
  assertSerializableStructuredResult,
  buildSafeAdapterFailureLogDetail,
  ClassifiedProviderFailureError,
  classifyProviderFailure,
  filterSafeClassificationDetails,
  notifyToolInputSchema,
  projectStepResultSchemaForProvider,
  ProviderProtocolError,
  reportProgressToolInputSchema,
  runtimeSkillsCatalogRoot,
  UnsupportedProviderCapabilityError,
  updatePlanToolInputSchema,
  writeScratchStepResultFile
} from '@autocatalyst/execution';
import { materializeOpenAISkillFiles, buildOpenAISkillDescriptors, type OpenAISkillDescriptor } from './skill-materialization.js';
import type { RunnerEvent } from '@autocatalyst/api-contract';

export const openaiProviderKind = 'openai' as const;
export const openaiAgentAdapterId = 'openai-agents-sdk' as const;

// ---------------------------------------------------------------------------
// Public seam types
// ---------------------------------------------------------------------------

export interface OpenAIWorkspaceSandboxConfig {
  readonly shape: 'none' | 'scratch_only' | 'two_roots';
  readonly workspaceRoots: readonly string[];
  readonly repoRoot?: string;
  readonly scratchRoot?: string;
  readonly resultRoot?: string;
}

/**
 * A sandbox session opened against the materialized workspace. This is the real
 * `@openai/agents/sandbox` session shape (`SandboxSessionLike`); the per-session
 * `UnixLocalSandboxClient` produces it and `Runner.run({ sandbox: { session } })`
 * consumes it.
 */
export type OpenAISandboxSession = SandboxSessionLike;

export interface OpenAISandboxClientFactoryInput {
  readonly workspace: OpenAIWorkspaceSandboxConfig;
  /** The validated NoopSnapshotSpec; bound to the client, never a process global. */
  readonly snapshot: NoopSnapshotSpec;
  /** Secret-stripped environment variables to seed the sandbox with. */
  readonly environment: Readonly<Record<string, string>>;
  readonly telemetryContext: AgentProviderSessionInput['telemetryContext'];
  /** Resolved skill host→sandbox directory mounts to include in the sandbox manifest. */
  readonly skillMounts?: ReadonlyArray<{ readonly hostPath: string; readonly sandboxPath: string }>;
}

export interface OpenAISandboxClientHandle {
  /** The real (or fake) sandbox client used to create the session. */
  readonly client: SandboxClient;
  /** The session opened against the materialized workspace. */
  readonly session: OpenAISandboxSession;
  /** Manifest used to open the session, after any provider-specific root staging. */
  readonly manifest?: Manifest;
  close?(): Promise<void> | void;
}

export type OpenAISandboxClientFactory = (
  input: OpenAISandboxClientFactoryInput
) => OpenAISandboxClientHandle | Promise<OpenAISandboxClientHandle>;

/**
 * Drives a single agent run. The default implementation constructs a real
 * `SandboxAgent` and a per-session `Runner` bound to an `OpenAIProvider` (which
 * is itself bound to the per-session fetch transport), then yields the real
 * `RunItem`s and final `RunResult`. Tests inject a fake to feed canned
 * RunItem-shaped events without driving the model.
 */
export interface OpenAIRunSessionInput {
  readonly prompt: string;
  readonly model: string;
  readonly instructions: string;
  readonly tools: ReturnType<typeof tool>[];
  readonly manifest: Manifest;
  readonly session: OpenAISandboxSession;
  /** OpenAIProvider bound to the per-session fetch transport. Never a global. */
  readonly modelProvider: OpenAIProvider;
  readonly modelSettings: Readonly<Record<string, unknown>>;
  readonly structuredResult?: OpenAIStructuredResultConfiguration;
  /** Loaded continuity state from the previous run turn. Never contains sandbox identifiers. */
  readonly modelMemoryState?: OpenAIResponsesContinuityState;
  /**
   * Runtime skills loaded natively via the SDK `skills()` capability (SKILL.md
   * content surfaced to the model as real skills), instead of relying on the
   * model to read mounted files.
   */
  readonly skillDescriptors?: readonly OpenAISkillDescriptor[];
}

export interface OpenAIRunOutcome {
  readonly items: AsyncIterable<RunItem> | Iterable<RunItem>;
  /**
   * The terminal result of the run. `directive` maps to the canonical terminal
   * directive; `output` (if present) is written to the step-result file.
   */
  readonly result: Promise<{
    readonly directive: 'advance' | 'needs_input' | 'fail';
    readonly output?: unknown;
    readonly question?: string;
    readonly reason?: string;
    readonly tokenUsage?: { readonly input: number; readonly output: number };
    /** Continuity state to persist for the next run turn. Never contains sandbox identifiers. */
    readonly responsesContinuity?: OpenAIResponsesContinuityState;
  }>;
}

export type OpenAIRunAgentSession = (input: OpenAIRunSessionInput) => OpenAIRunOutcome | Promise<OpenAIRunOutcome>;

export interface OpenAIAgentAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface OpenAIAgentAdapterOptions {
  /** Override the default real-SDK sandbox client/session factory (tests inject a fake). */
  readonly sandboxClientFactory?: OpenAISandboxClientFactory;
  /** Override the default real-SDK run driver (tests inject canned RunItems). */
  readonly runAgentSession?: OpenAIRunAgentSession;
  /** Base directory under which the local sandbox materializes workspaces. Defaults to os tmp. */
  readonly sandboxWorkspaceBaseDir?: string;
  readonly clock?: () => string;
  readonly eventIdGenerator?: () => string;
  readonly logger?: OpenAIAgentAdapterLogger;
}

export interface OpenAIResponsesContinuityState {
  readonly conversationId?: string;
  readonly previousResponseId?: string;
}

export interface OpenAIStructuredResultConfiguration {
  readonly capture: StructuredAgentResultCapture;
  readonly projection: ProviderSchemaProjection & {
    readonly target: 'openai_agents_output_type';
    readonly mechanism: 'openai_output_type';
  };
}

export function createOpenAIStructuredResultConfiguration(
  capture: StructuredAgentResultCapture
): OpenAIStructuredResultConfiguration {
  const projection = projectStepResultSchemaForProvider({
    schemaId: capture.schemaId,
    schema: capture.schema,
    target: 'openai_agents_output_type'
  });
  // projection.target is always 'openai_agents_output_type' for this target
  return {
    capture,
    projection: projection as ProviderSchemaProjection & {
      readonly target: 'openai_agents_output_type';
      readonly mechanism: 'openai_output_type';
    }
  };
}

function shouldUseOpenAIOutputType(
  structuredResult: OpenAIStructuredResultConfiguration | undefined,
  role: AgentProviderSessionInput['telemetryContext']['role']
): boolean {
  if (structuredResult === undefined) return false;
  if (structuredResult.capture.step === 'spec.author') return false;
  if (structuredResult.capture.step === 'implementation.build' && role === 'reviewer') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// A finite session budget; exhaustion never starts a replacement paid session.
export const OPENAI_AGENT_MAX_TURNS = 250;

const PROGRESS_TOOL_NAMES = new Set(['update_plan', 'report_progress', 'notify']);
const execFileAsync = promisify(execFile);
const LOCAL_SANDBOX_EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules']);
const BASE_OPENAI_AGENT_INSTRUCTIONS = [
  'You are an AI agent for software development automation.',
  'Work in the provided sandbox workspace.',
  'Follow the user prompt for the current task.'
].join('\n');

// Inference settings the OpenAI Agents SDK plumbs through ModelSettings.
const SUPPORTED_INFERENCE_SETTINGS = new Set(['temperature', 'topP', 'maxOutputTokens']);
const OPTIONAL_AGENT_UNSUPPORTED_SETTINGS = ['reasoningEffort', 'seed', 'topK', 'streamingMode', 'parallelToolCalls'] as const;
const SAFE_SDK_DIAGNOSTIC_TOKENS = new Set(['MaxTurnsExceededError', 'max_turns_exceeded', 'APIError', 'AuthenticationError', 'RateLimitError', 'APIConnectionError', 'APIConnectionTimeoutError', 'ENOENT', 'EACCES', 'EPERM']);

// ---------------------------------------------------------------------------
// Inference settings mapping
// ---------------------------------------------------------------------------

interface OpenAIInferenceMapping {
  readonly mapped: Record<string, unknown>;
  readonly degraded: ProviderCapabilityDegradation[];
}

function safeSdkDiagnosticToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return SAFE_SDK_DIAGNOSTIC_TOKENS.has(value) ? value : undefined;
}

function buildSafeOpenAISdkErrorDiagnostic(err: unknown): Record<string, unknown> {
  if (err === null || typeof err !== 'object') return {};
  const shaped = err as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly type?: unknown;
    readonly constructor?: { readonly name?: unknown };
  };
  const sdkErrorName = safeSdkDiagnosticToken(shaped.name);
  const sdkErrorCode = safeSdkDiagnosticToken(shaped.code);
  const sdkErrorType = safeSdkDiagnosticToken(shaped.type);
  const sdkErrorConstructor = safeSdkDiagnosticToken(shaped.constructor?.name);
  return {
    ...(sdkErrorName !== undefined ? { sdkErrorName } : {}),
    ...(sdkErrorCode !== undefined ? { sdkErrorCode } : {}),
    ...(sdkErrorType !== undefined ? { sdkErrorType } : {}),
    ...(sdkErrorConstructor !== undefined && sdkErrorConstructor !== 'Error' ? { sdkErrorConstructor } : {}),
    ...(err instanceof MaxTurnsExceededError ? { sdkErrorName: 'MaxTurnsExceededError', maxTurns: OPENAI_AGENT_MAX_TURNS } : {})
  };
}

function mapInferenceSettings(profile: AgentProviderSessionInput['profile']): OpenAIInferenceMapping {
  const mapped: Record<string, unknown> = {};
  const degraded: ProviderCapabilityDegradation[] = [];
  const settings = profile.inferenceSettings as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    if (SUPPORTED_INFERENCE_SETTINGS.has(key)) {
      // ModelSettings uses maxTokens, not maxOutputTokens.
      mapped[key === 'maxOutputTokens' ? 'maxTokens' : key] = value;
    } else if ((OPTIONAL_AGENT_UNSUPPORTED_SETTINGS as readonly string[]).includes(key)) {
      degraded.push({
        capability: `inference_setting:${key}`,
        reason: `OpenAI agent adapter does not support ${key} in agent mode.`,
        required: false
      });
    }
  }
  return { mapped, degraded };
}

// ---------------------------------------------------------------------------
// Progress tool definitions
//
// The progress tools are *signaling* tools: the SDK executes them locally and
// returns a benign acknowledgement. The adapter intercepts the tool-call items
// (not the executor) and re-emits them as canonical runner_progress /
// runner_notification events. The executors only need to return something so the
// run loop can continue.
// ---------------------------------------------------------------------------

function createProgressTools(): ReturnType<typeof tool>[] {
  const ack = async (): Promise<string> => 'acknowledged';
  return [
    tool({
      name: 'update_plan',
      description: 'Replace the current plan with a list of safe plan items and statuses.',
      parameters: z.object({
        title: z.string(),
        steps: z.array(z.string())
      }),
      execute: ack
    }),
    tool({
      name: 'report_progress',
      description: 'Report task counts or a short safe progress intent summary.',
      parameters: z.object({
        label: z.string().nullable().optional(),
        completed: z.number().int().nullable().optional(),
        total: z.number().int().nullable().optional(),
        summary: z.string().nullable().optional()
      }),
      execute: ack
    }),
    tool({
      name: 'notify',
      description: 'Emit a safe notification for the run event stream.',
      parameters: z.object({
        message: z.string(),
        severity: z.enum(['debug', 'info', 'warn', 'error']).nullable().optional(),
        importance: z.enum(['low', 'normal', 'high']).nullable().optional()
      }),
      execute: ack
    })
  ];
}

// ---------------------------------------------------------------------------
// Event mapping helpers
// ---------------------------------------------------------------------------

interface EventContext {
  readonly runId: string;
  readonly step: string;
  readonly clock: () => string;
  readonly eventIdGenerator: () => string;
}

function baseEvent(ctx: EventContext): { id: string; runId: string; step: string; importance: 'normal'; createdAt: string } {
  return {
    id: ctx.eventIdGenerator(),
    runId: ctx.runId,
    step: ctx.step,
    importance: 'normal' as const,
    createdAt: ctx.clock()
  };
}

function parseArgs(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

function lowImportanceToolActivity(name: string, ctx: EventContext): RunnerEvent {
  return {
    ...baseEvent(ctx),
    type: 'runner_tool_activity',
    importance: 'low' as const,
    tool: { name, action: 'invoke', status: 'completed' }
  } as RunnerEvent;
}

interface PromptShapeDiagnostic {
  readonly promptChars: number;
  readonly instructionsChars: number;
  readonly instructionsStartWithPrompt: boolean;
  readonly instructionSuffixChars: number;
  readonly skillHintAppended: boolean;
  readonly structuredOutput: boolean;
}

function runtimeSkillDiagnosticNotification(input: {
  readonly requestedSkillRefs: readonly string[];
  readonly resolvedSkillRefs: readonly string[];
  readonly handoffMode: string;
  readonly referenceEntries?: readonly string[];
  readonly promptShape?: PromptShapeDiagnostic;
}, ctx: EventContext): RunnerEvent {
  const requested = input.requestedSkillRefs.length > 0 ? input.requestedSkillRefs.join(',') : 'none';
  const resolved = input.resolvedSkillRefs.length > 0 ? input.resolvedSkillRefs.join(',') : 'none';
  const references = input.referenceEntries !== undefined && input.referenceEntries.length > 0
    ? ` referenceEntries=${input.referenceEntries.join(';')}`
    : '';
  const promptShape = input.promptShape !== undefined
    ? ` promptShape=${input.promptShape.instructionsStartWithPrompt ? 'instructions_start_with_prompt' : 'instructions_distinct'} structuredOutput=${input.promptShape.structuredOutput ? 'true' : 'false'}`
    : '';
  return {
    ...baseEvent(ctx),
    type: 'runner_notification',
    importance: 'normal',
    notification: {
      severity: input.requestedSkillRefs.length > 0 && input.resolvedSkillRefs.length === 0 ? 'warn' : 'info',
      message: `Runtime skills: requested=${requested} resolved=${resolved} handoff=${input.handoffMode}${references}${promptShape}`
    }
  } as RunnerEvent;
}

function buildPromptShapeDiagnostic(input: {
  readonly prompt: string;
  readonly instructions: string;
  readonly skillHintAppended: boolean;
  readonly structuredOutput: boolean;
}): PromptShapeDiagnostic {
  const instructionsStartWithPrompt = input.instructions.startsWith(input.prompt);
  return {
    promptChars: input.prompt.length,
    instructionsChars: input.instructions.length,
    instructionsStartWithPrompt,
    instructionSuffixChars: instructionsStartWithPrompt
      ? input.instructions.length - input.prompt.length
      : 0,
    skillHintAppended: input.skillHintAppended,
    structuredOutput: input.structuredOutput
  };
}

function buildOpenAIAgentInstructions(skillHint: string): string {
  return skillHint.length > 0
    ? `${BASE_OPENAI_AGENT_INSTRUCTIONS}\n\n${skillHint}`
    : BASE_OPENAI_AGENT_INSTRUCTIONS;
}

function summarizeDescriptorReferenceEntries(descriptors: readonly OpenAISkillDescriptor[]): string[] {
  return descriptors.flatMap((descriptor) => {
    const referenceNames = Object.keys(descriptor.references ?? {}).sort();
    if (referenceNames.length === 0) return [];
    return `${descriptor.name}[${referenceNames.join(',')}]`;
  });
}

function mapProgressToolCall(name: string, rawArgs: unknown, ctx: EventContext): RunnerEvent | undefined {
  const args = parseArgs(rawArgs);

  if (name === 'notify') {
    const parsed = notifyToolInputSchema.safeParse(args);
    if (!parsed.success) return lowImportanceToolActivity(name, ctx);
    return {
      ...baseEvent(ctx),
      type: 'runner_notification',
      importance: parsed.data.importance ?? 'normal',
      notification: { severity: parsed.data.severity ?? 'info', message: parsed.data.message }
    } as RunnerEvent;
  }

  if (name === 'update_plan') {
    const parsed = updatePlanToolInputSchema.safeParse(args);
    if (!parsed.success) return lowImportanceToolActivity(name, ctx);
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'plan' as const, title: parsed.data.title, steps: parsed.data.steps }
    } as RunnerEvent;
  }

  // report_progress
  const parsed = reportProgressToolInputSchema.safeParse(args);
  if (!parsed.success) return lowImportanceToolActivity(name, ctx);
  const { label, completed, total, summary } = parsed.data;
  if (completed !== undefined && total !== undefined && label !== undefined) {
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'task_progress' as const, label, completed, total }
    } as RunnerEvent;
  }
  if (summary !== undefined) {
    return {
      ...baseEvent(ctx),
      type: 'runner_progress',
      importance: 'normal' as const,
      progress: { kind: 'intent' as const, summary }
    } as RunnerEvent;
  }
  return lowImportanceToolActivity(name, ctx);
}

function assistantText(rawItem: unknown): string {
  if (typeof rawItem !== 'object' || rawItem === null) return '';
  const content = (rawItem as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content as Array<Record<string, unknown>>) {
    if (block && block['type'] === 'output_text' && typeof block['text'] === 'string') {
      text += block['text'];
    }
  }
  return text;
}

/**
 * Maps a single native `RunItem` (from the real SDK) into a canonical
 * RunnerEvent, or undefined when the item carries no surfaced signal. Terminal
 * results are NOT produced here — the run driver returns a separate terminal
 * result so the adapter can enforce the single-terminal protocol.
 */
function mapRunItem(item: RunItem, ctx: EventContext): RunnerEvent | undefined {
  switch (item.type) {
    case 'message_output_item': {
      const text = assistantText(item.rawItem);
      if (text.length === 0) return undefined;
      return {
        ...baseEvent(ctx),
        type: 'runner_assistant_turn',
        message: { role: 'assistant', content: text }
      } as RunnerEvent;
    }

    case 'tool_call_item': {
      const raw = item.rawItem as { name?: unknown; arguments?: unknown; type?: unknown };
      const name = typeof raw.name === 'string' ? raw.name : '';
      if (PROGRESS_TOOL_NAMES.has(name)) {
        return mapProgressToolCall(name, raw.arguments, ctx);
      }
      return {
        ...baseEvent(ctx),
        type: 'runner_tool_activity',
        tool: { name: name.length > 0 ? name : 'unknown_tool', action: 'invoke', status: 'started' }
      } as RunnerEvent;
    }

    case 'tool_call_output_item': {
      const raw = item.rawItem as { name?: unknown; status?: unknown };
      const name = typeof raw.name === 'string' ? raw.name : '';
      // Progress tool acknowledgements were already surfaced on the call item.
      if (PROGRESS_TOOL_NAMES.has(name)) return undefined;
      const status = raw.status === 'incomplete' ? 'failed' : 'completed';
      return {
        ...baseEvent(ctx),
        type: 'runner_tool_activity',
        tool: { name: name.length > 0 ? name : 'unknown_tool', action: 'result', status }
      } as RunnerEvent;
    }

    // Reasoning, handoff, tool-approval, and tool-search items carry no
    // surfaced signal for the canonical stream.
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Result file helper
// ---------------------------------------------------------------------------

async function maybeWriteResultFile(
  env: AgentProviderSessionInput['runInput']['environment'],
  output: unknown
): Promise<void> {
  if (output === undefined || output === null) return;
  const workspace = env.workspace;
  const scratchRoot = 'scratchRoot' in workspace ? workspace.scratchRoot : undefined;
  if (scratchRoot === undefined) return;
  const target = path.join(scratchRoot, 'step-result.json');
  const content = typeof output === 'string' ? output : JSON.stringify(output);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  } catch {
    // Suppress raw filesystem errors that may carry host paths.
    throw new Error('OpenAI agent adapter failed to write the step result file.');
  }
}

async function writeStructuredResultFile(
  env: AgentProviderSessionInput['runInput']['environment'],
  structuredResult: OpenAIStructuredResultConfiguration,
  output: unknown
): Promise<void> {
  if (output === undefined || output === null) {
    throw new ProviderProtocolError(
      'missing_structured_result',
      'OpenAI structured output session advanced without a parsed structured result.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
    );
  }

  assertSerializableStructuredResult(output);

  const writeOutcome = await writeScratchStepResultFile({
    environment: env,
    resultFile: structuredResult.capture.resultFile,
    value: output
  });

  if (writeOutcome.status === 'failed') {
    throw new ProviderProtocolError(
      'structured_result_invalid',
      `OpenAI structured result write failed: ${writeOutcome.code}`,
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, code: writeOutcome.code }
    );
  }
}

function sandboxResultFileCandidates(
  workspace: OpenAIWorkspaceSandboxConfig,
  resultFile: string
): readonly string[] {
  const normalizedResultFile = resultFile.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidates: string[] = [];
  const scratchRoot = workspace.scratchRoot;
  if (scratchRoot !== undefined) {
    candidates.push(`/workspace/${path.basename(scratchRoot)}/${normalizedResultFile}`);
  }
  candidates.push(`/workspace/scratch/${normalizedResultFile}`);
  candidates.push(`/workspace/${normalizedResultFile}`);
  candidates.push(normalizedResultFile);
  return [...new Set(candidates)];
}

async function writeStructuredResultFromFinalOutput(
  env: AgentProviderSessionInput['runInput']['environment'],
  structuredResult: OpenAIStructuredResultConfiguration,
  output: unknown
): Promise<void> {
  const parsed = parseStructuredResultFromFinalOutput(output);
  await writeStructuredResultFile(env, structuredResult, parsed);
}

function parseStructuredResultFromFinalOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output;

  const trimmed = output.trim();
  const candidates = [
    trimmed,
    ...[...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]?.trim() ?? ''),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  ].filter((candidate) => candidate.length > 0);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next safe extraction shape; raw output is never logged.
    }
  }

  throw new ProviderProtocolError(
    'structured_result_invalid',
    'OpenAI structured-output-free session advanced with non-JSON final output.',
    { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
  );
}

async function copyStructuredResultFileFromSandbox(
  env: AgentProviderSessionInput['runInput']['environment'],
  workspace: OpenAIWorkspaceSandboxConfig,
  session: OpenAISandboxSession,
  structuredResult: OpenAIStructuredResultConfiguration,
  diagnostic?: (detail: Record<string, unknown>) => void
): Promise<void> {
  // Record metadata only; never log file or model contents.
  diagnostic?.({ captureStage: "sandbox_read_start", readableSession: session.readFile !== undefined });
  if (session.readFile === undefined) {
    throw new ProviderProtocolError(
      'missing_structured_result',
      'OpenAI structured output session advanced without a readable agent-authored result file.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
    );
  }

  let fileText: string | undefined;
  for (const candidate of sandboxResultFileCandidates(workspace, structuredResult.capture.resultFile)) {
    try {
      const content = await session.readFile({ path: candidate });
      fileText = typeof content === 'string' ? content : new TextDecoder().decode(content);
      diagnostic?.({ captureStage: 'sandbox_read_ok', candidate, byteCount: fileText.length });
      break;
    } catch (err) {
      const error = err as { code?: unknown };
      diagnostic?.({ captureStage: 'sandbox_read_failed', candidate, ...buildSafeOpenAISdkErrorDiagnostic(err), ...(safeSdkDiagnosticToken(error.code) ? { code: error.code } : {}) });
      // Try the next sandbox-visible location. The final error below stays path-safe.
    }
  }

  if (fileText === undefined) {
    throw new ProviderProtocolError(
      'missing_structured_result',
      'OpenAI structured output session advanced without an agent-authored result file.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new ProviderProtocolError(
      'structured_result_invalid',
      'OpenAI agent-authored result file did not contain valid JSON.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, code: 'result_json_invalid' }
    );
  }

  const writeOutcome = await writeScratchStepResultFile({
    environment: env,
    resultFile: structuredResult.capture.resultFile,
    value: parsed
  });

  if (writeOutcome.status === 'failed') {
    throw new ProviderProtocolError(
      'structured_result_invalid',
      `OpenAI agent-authored result file write failed: ${writeOutcome.code}`,
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, code: writeOutcome.code }
    );
  }
}

async function copyStructuredResultFileFromSandboxOrFinalOutput(
  env: AgentProviderSessionInput['runInput']['environment'],
  workspace: OpenAIWorkspaceSandboxConfig,
  session: OpenAISandboxSession,
  structuredResult: OpenAIStructuredResultConfiguration,
  output: unknown,
  diagnostic?: (detail: Record<string, unknown>) => void
): Promise<void> {
  try {
    await copyStructuredResultFileFromSandbox(env, workspace, session, structuredResult, diagnostic);
  } catch (err) {
    if (err instanceof ProviderProtocolError && err.code === 'missing_structured_result') {
      diagnostic?.({ captureStage: 'final_output_fallback', outputType: typeof output, ...(typeof output === 'string' ? { outputChars: output.length } : {}) });
      await writeStructuredResultFromFinalOutput(env, structuredResult, output);
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workspace mapping & containment
// ---------------------------------------------------------------------------

function mapWorkspaceForSandbox(input: AgentProviderSessionInput): OpenAIWorkspaceSandboxConfig {
  const workspace = input.runInput.environment.workspace;
  if (workspace.shape === 'two_roots') {
    return {
      shape: 'two_roots',
      workspaceRoots: [...workspace.workspaceRoots],
      repoRoot: workspace.repoRoot,
      scratchRoot: workspace.scratchRoot,
      resultRoot: workspace.scratchRoot
    };
  }
  if (workspace.shape === 'scratch_only') {
    return {
      shape: 'scratch_only',
      workspaceRoots: [...workspace.workspaceRoots],
      scratchRoot: workspace.scratchRoot,
      resultRoot: workspace.scratchRoot
    };
  }
  return { shape: 'none', workspaceRoots: [] };
}

function assertWorkspaceRootsDoNotEscape(workspace: OpenAIWorkspaceSandboxConfig): void {
  const rootsSet = new Set(workspace.workspaceRoots);
  const pathsToCheck: Array<string | undefined> = [workspace.repoRoot, workspace.scratchRoot, workspace.resultRoot];
  for (const p of pathsToCheck) {
    if (p !== undefined && !rootsSet.has(p)) {
      throw new UnsupportedProviderCapabilityError(
        'workspace_containment_violation',
        `Workspace path "${p}" is not within the declared workspace roots.`,
        { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'workspace_roots' }
      );
    }
  }
}

/**
 * Builds the sandbox Manifest that materializes the run's workspace roots into
 * the local sandbox. Each declared root becomes a `localDir` entry, and each is
 * granted via `extraPathGrants` so `UnixLocalSandboxClient` may copy it from its
 * host location into the session workspace (the SDK otherwise restricts
 * local_dir sources to its own base directory).
 *
 * Optional `skillMounts` are appended as additional read-only `localDir` entries
 * so that the staged skill directories are visible inside the sandbox.
 */
function buildWorkspaceManifest(
  workspace: OpenAIWorkspaceSandboxConfig,
  environment: Readonly<Record<string, string>>,
  skillMounts: ReadonlyArray<{ readonly hostPath: string; readonly sandboxPath: string }> = [],
  workspaceReadOnly = false
): Manifest {
  const entries: Record<string, ReturnType<typeof localDir>> = {};
  const grants: Array<{ path: string; readOnly: boolean }> = [];
  for (const root of workspace.workspaceRoots) {
    const logicalName = path.basename(root) || 'root';
    entries[logicalName] = localDir({ src: root });
    grants.push({ path: root, readOnly: workspaceReadOnly });
  }
  for (const mount of skillMounts) {
    // Use a stable key derived from the sandbox path, preserving the path
    // structure relative to the manifest root so the sandbox places files at
    // the exact path the agent is told to look in.
    const MANIFEST_ROOT = '/workspace';
    const logicalName = mount.sandboxPath.startsWith(`${MANIFEST_ROOT}/`)
      ? mount.sandboxPath.slice(MANIFEST_ROOT.length + 1)
      : mount.sandboxPath.replace(/^\//, '');
    entries[logicalName] = localDir({ src: mount.hostPath });
    grants.push({ path: mount.hostPath, readOnly: true });
  }
  const environmentInit: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    environmentInit[key] = value;
  }
  return new Manifest({
    root: '/workspace',
    entries,
    environment: environmentInit,
    extraPathGrants: grants
  });
}

interface MaterializedOpenAIWorkspace {
  readonly workspace: OpenAIWorkspaceSandboxConfig;
  cleanup(): Promise<void>;
}

async function copyWorkspaceRootForLocalSandbox(source: string, destination: string): Promise<void> {
  // A worktree's .git file points outside its root. Copying that pointer would
  // let sandbox git commands mutate host refs despite NoopSnapshotSpec.
  const gitEntry = await lstat(path.join(source, '.git')).catch(() => undefined);
  const linkedWorktree = gitEntry?.isFile() === true;
  if (linkedWorktree) {
    await execFileAsync('git', ['clone', '--no-hardlinks', '--no-checkout', '--', source, destination]);
    await execFileAsync('git', ['-C', destination, 'reset', '--mixed', 'HEAD']);
  }
  await cp(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: async (src) => {
      if (LOCAL_SANDBOX_EXCLUDED_DIRECTORY_NAMES.has(path.basename(src))) return false;
      if (linkedWorktree && src === path.join(source, '.git')) return false;
      const info = await lstat(src);
      return !info.isSymbolicLink();
    }
  });
}

async function materializeWorkspaceForOpenAILocalSandbox(
  workspace: OpenAIWorkspaceSandboxConfig,
  workspaceBaseDir?: string
): Promise<MaterializedOpenAIWorkspace> {
  if (workspace.workspaceRoots.length === 0) {
    return {
      workspace,
      async cleanup(): Promise<void> {
        // No staged workspace was created.
      }
    };
  }

  const stageRoot = await mkdtemp(path.join(workspaceBaseDir ?? tmpdir(), 'autocatalyst-openai-sandbox-'));
  const remappedRoots = new Map<string, string>();

  try {
    for (const root of workspace.workspaceRoots) {
      const logicalName = path.basename(root) || 'root';
      const stagedRoot = path.join(stageRoot, logicalName);
      if ([...remappedRoots.values()].includes(stagedRoot)) {
        throw new Error('Workspace roots must have distinct logical names.');
      }
      await copyWorkspaceRootForLocalSandbox(root, stagedRoot);
      remappedRoots.set(root, stagedRoot);
    }
  } catch {
    await rm(stageRoot, { recursive: true, force: true });
    throw new UnsupportedProviderCapabilityError(
      'sandbox_client_unsupported', 'OpenAI workspace staging failed.',
      { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
    );
  }

  const remapRequiredRoot = (root: string): string => remappedRoots.get(root) ?? root;
  const { repoRoot, scratchRoot, resultRoot, workspaceRoots, ...workspaceRest } = workspace;

  return {
    workspace: {
      ...workspaceRest,
      workspaceRoots: workspaceRoots.map(remapRequiredRoot),
      ...(repoRoot !== undefined ? { repoRoot: remapRequiredRoot(repoRoot) } : {}),
      ...(scratchRoot !== undefined ? { scratchRoot: remapRequiredRoot(scratchRoot) } : {}),
      ...(resultRoot !== undefined ? { resultRoot: remapRequiredRoot(resultRoot) } : {})
    },
    async cleanup(): Promise<void> {
      await rm(stageRoot, { recursive: true, force: true });
    }
  };
}

// ---------------------------------------------------------------------------
// Transport bridge: ProviderFetchTransport -> WHATWG fetch for the OpenAI client
// ---------------------------------------------------------------------------

function bridgeTransportToFetch(transport: ProviderFetchTransport): typeof fetch {
  const bridged = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let resolvedUrl: string;
    let method: string;
    let headers: Record<string, string> = {};
    let body: unknown;

    if (url instanceof Request) {
      resolvedUrl = url.url;
      method = url.method;
      url.headers.forEach((value, key) => { headers[key] = value; });
      body = init?.body ?? (await url.clone().text());
    } else {
      resolvedUrl = url.toString();
      method = init?.method ?? 'GET';
      const initHeaders = init?.headers;
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => { headers[key] = value; });
      } else if (Array.isArray(initHeaders)) {
        for (const [key, value] of initHeaders as Array<[string, string]>) headers[key] = value;
      } else if (initHeaders) {
        headers = { ...(initHeaders as Record<string, string>) };
      }
      body = init?.body;
    }

    const request: ProviderRequest = {
      url: resolvedUrl,
      method,
      headers,
      ...(body !== undefined && body !== null ? { body } : {})
    };
    return transport.fetch(request);
  };
  return bridged as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Default (real-SDK) run driver
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The structural subset of the SDK's streaming RunResult that the adapter
 * consumes after iteration completes. The SDK's own `RunResult<_, SandboxAgent>`
 * does not round-trip under exactOptionalPropertyTypes, so we narrow to what we
 * actually read instead of naming it.
 */
interface StreamRunResultView {
  readonly finalOutput: unknown;
  readonly lastResponseId: string | undefined;
  readonly state: { readonly _context: { readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } } };
}

/**
 * The streamed run result combines the post-iteration StreamRunResultView fields
 * with the AsyncIterable interface for consuming events during the run.
 */
type StreamedRunnerRunView = StreamRunResultView & AsyncIterable<{
  readonly type: string;
  readonly item?: RunItem;
}>;

function isRunItemStreamEvent(event: { readonly type: string; readonly item?: RunItem }): event is { readonly type: 'run_item_stream_event'; readonly item: RunItem } {
  return event.type === 'run_item_stream_event' && event.item !== undefined;
}

function defaultRunAgentSession(input: OpenAIRunSessionInput): OpenAIRunOutcome {
  // When a structured result is configured, wrap the projection schema as a
  // JsonSchemaDefinition so the OpenAI Agents SDK enforces structured output.
  // The projection.schema is a plain JSON Schema object; JsonSchemaDefinition
  // wraps it with the required { type: 'json_schema', name, strict, schema } shape.
  // We cast through `unknown` because ProviderStructuredOutputSchema = unknown.
  const outputTypeOption =
    input.structuredResult !== undefined
      ? {
          outputType: {
            type: 'json_schema' as const,
            name: input.structuredResult.capture.schemaId.replace(/[^a-zA-Z0-9_-]/g, '_'),
            strict: true,
            schema: input.structuredResult.projection.schema as unknown as Record<string, unknown>
          }
        }
      : {};

  // Runtime skills need the SDK capability path to own the model-facing tool set.
  // Native capabilities supply the tools needed to read skills and execute their scripts.
  const hasRuntimeSkills = input.skillDescriptors !== undefined && input.skillDescriptors.length > 0;
  const capabilities = hasRuntimeSkills
    ? [
        sdkFilesystem(),
        sdkShell(),
        sdkCompaction(),
        sdkSkills({ skills: input.skillDescriptors.map((s) => ({ ...s })) })
      ]
    : [];
  const sandboxAgentConfig = {
    name: 'autocatalyst-openai-agent',
    model: input.model,
    instructions: input.instructions,
    ...(hasRuntimeSkills
      ? { capabilities }
      : {
          defaultManifest: input.manifest,
          tools: input.tools
        }),
    ...(Object.keys(input.modelSettings).length > 0 ? { modelSettings: input.modelSettings } : {}),
    ...outputTypeOption
  } as ConstructorParameters<typeof SandboxAgent>[0];

  const agent = new SandboxAgent(sandboxAgentConfig) as SandboxAgent;

  // Per-session Runner bound to the per-session model provider via RunConfig.
  // This is the ONLY place the model provider is set — never through any of the
  // SDK's process-global default setters.
  const runner = new Runner({ modelProvider: input.modelProvider, tracingDisabled: true });

  let resolveResult!: (value: OpenAIRunOutcome['result'] extends Promise<infer R> ? R : never) => void;
  let rejectResult!: (err: unknown) => void;
  const result: OpenAIRunOutcome['result'] = new Promise((resolve, reject) => {
    resolveResult = resolve as never;
    rejectResult = reject;
  });
  result.catch(() => undefined);

  async function* drive(): AsyncIterable<RunItem> {
    try {
      const continuityOptions = input.modelMemoryState !== undefined
        ? {
            ...(input.modelMemoryState.previousResponseId !== undefined ? { previousResponseId: input.modelMemoryState.previousResponseId } : {}),
            ...(input.modelMemoryState.conversationId !== undefined ? { conversationId: input.modelMemoryState.conversationId } : {})
          }
        : {};
      const stream = await runner.run(agent, input.prompt, { sandbox: { session: input.session }, stream: true, maxTurns: OPENAI_AGENT_MAX_TURNS, ...continuityOptions }) as unknown as StreamedRunnerRunView;

      for await (const event of stream) {
        if (isRunItemStreamEvent(event)) {
          yield event.item;
        }
      }

      const streamResult = stream as unknown as StreamRunResultView;
      const usage = streamResult.state._context.usage;
      const lastResponseId = streamResult.lastResponseId;
      const responsesContinuity: OpenAIResponsesContinuityState | undefined = lastResponseId !== undefined
        ? { previousResponseId: lastResponseId }
        : undefined;
      resolveResult({
        directive: 'advance',
        ...(streamResult.finalOutput !== undefined ? { output: streamResult.finalOutput } : {}),
        ...(usage
          ? { tokenUsage: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } }
          : {}),
        ...(responsesContinuity !== undefined ? { responsesContinuity } : {})
      });
    } catch (err) {
      const shaped = (err ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
      const classificationInput = {
        ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
        ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
        code: shaped.code,
        errorName: shaped.name,
        providerKind: openaiProviderKind
      };
      const reason = classifyProviderFailure(classificationInput);
      const safeDetails = {
        ...filterSafeClassificationDetails(classificationInput),
        ...buildSafeOpenAISdkErrorDiagnostic(err)
      };
      const classified: ClassifiedProviderFailureError = reason !== undefined
        ? new ClassifiedProviderFailureError(reason, safeDetails)
        : new ClassifiedProviderFailureError('runner_failed_before_terminal_result', safeDetails);
      rejectResult(classified);
      throw classified;
    }
  }

  return { items: drive(), result };
}

/**
 * Default sandbox client factory: builds a per-session UnixLocalSandboxClient
 * (with the validated NoopSnapshotSpec bound to it) and opens a session over the
 * manifest that materializes the run's workspace roots.
 *
 * Reviewer workspace immutability is enforced by two complementary mechanisms:
 *   1. extraPathGrants readOnly: true for reviewer sessions (set below via workspaceReadOnly).
 *   2. NoopSnapshotSpec (validated at session start): no snapshot is ever taken, so no
 *      in-sandbox writes can propagate back to the host workspace after the session closes.
 * Tests in openai-agent-adapter.spec.ts verify this invariant at the behavioral level.
 */
function makeDefaultSandboxClientFactory(workspaceBaseDir?: string): OpenAISandboxClientFactory {
  return async (factoryInput): Promise<OpenAISandboxClientHandle> => {
    const staged = await materializeWorkspaceForOpenAILocalSandbox(factoryInput.workspace, workspaceBaseDir);
    const manifest = buildWorkspaceManifest(
      staged.workspace,
      factoryInput.environment,
      factoryInput.skillMounts ?? [],
      factoryInput.telemetryContext.role === 'reviewer'
    );
    let client: UnixLocalSandboxClient;
    let session: SandboxSessionLike;
    try {
      client = new UnixLocalSandboxClient({
        ...(workspaceBaseDir !== undefined ? { workspaceBaseDir } : {}),
        snapshot: factoryInput.snapshot
      });
      session = await client.create(manifest);
    } catch {
      await staged.cleanup();
      throw new UnsupportedProviderCapabilityError(
        'sandbox_client_unsupported',
        'OpenAI local sandbox client could not open a session for the materialized workspace.',
        { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_local_sandbox_client' }
      );
    }
    return {
      client,
      session,
      manifest,
      async close(): Promise<void> {
        try {
          await session.close?.();
        } finally {
          await staged.cleanup();
        }
      }
    };
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAIAgentAdapter(
  options: OpenAIAgentAdapterOptions = {}
): AgentProviderAdapter {
  function safeLog(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
    if (options.logger === undefined) return;
    options.logger[level](event, {
      providerKind: openaiProviderKind,
      adapterId: openaiAgentAdapterId,
      ...fields
    });
  }

  function classifySdkError(err: unknown): ClassifiedProviderFailureError | undefined {
    const shaped = (err ?? {}) as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown };
    const classificationInput = {
      ...(typeof shaped.status === 'number' ? { status: shaped.status } : {}),
      ...(typeof shaped.statusCode === 'number' ? { statusCode: shaped.statusCode } : {}),
      code: shaped.code,
      errorName: shaped.name,
      providerKind: openaiProviderKind
    };
    const reason = classifyProviderFailure(classificationInput);
    return reason === undefined
      ? undefined
      : new ClassifiedProviderFailureError(reason, filterSafeClassificationDetails(classificationInput));
  }

  const sandboxClientFactory = options.sandboxClientFactory ?? makeDefaultSandboxClientFactory(options.sandboxWorkspaceBaseDir);
  const runAgentSession = options.runAgentSession ?? defaultRunAgentSession;
  const clock = options.clock ?? (() => new Date().toISOString());
  const eventIdGenerator = options.eventIdGenerator ?? (() => `evt_${Math.random().toString(36).slice(2)}`);

  return {
    providerKind: openaiProviderKind,
    adapterId: openaiAgentAdapterId,
    supportedConnectionMechanism: 'fetch_transport',

    async startSession(input: AgentProviderSessionInput): Promise<AgentProviderSession> {
      // 1. Per-session transport, bound to the per-session fetch transport.
      const transport = input.connection.createFetchTransport();

      // 2. Explicit NoopSnapshotSpec with validation (snapshot belongs on the client).
      const snapshot = new NoopSnapshotSpec();
      if (!isNoopSnapshotSpec(snapshot) || snapshot.type !== 'noop') {
        throw new UnsupportedProviderCapabilityError(
          'sandbox_snapshot_unsupported',
          'The @openai/agents SDK NoopSnapshotSpec instance failed validation. The snapshot type must be "noop".',
          { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId, capability: 'openai_agents_noop_snapshot' }
        );
      }

      // 3. Workspace mapping + containment.
      const workspace = mapWorkspaceForSandbox(input);
      assertWorkspaceRootsDoNotEscape(workspace);

      // 4. Secret-env stripping.
      const { variables, secretVariableNames } = input.runInput.environment.environment;
      const secretSet = new Set(secretVariableNames);
      const safeEnvironment: Record<string, string> = {};
      for (const [key, value] of Object.entries(variables)) {
        if (!secretSet.has(key)) safeEnvironment[key] = value;
      }

      // Build structured result configuration if capture is active.
      let structuredResult: OpenAIStructuredResultConfiguration | undefined;
      if (input.structuredResultCapture !== undefined) {
        structuredResult = createOpenAIStructuredResultConfiguration(input.structuredResultCapture);
      }
      const openAIOutputTypeStructuredResult = shouldUseOpenAIOutputType(structuredResult, input.telemetryContext.role)
        ? structuredResult
        : undefined;

      safeLog('info', 'openai_agent_session_start', {
        runId: input.telemetryContext.runId,
        phase: input.telemetryContext.phase,
        step: input.telemetryContext.step,
        role: input.telemetryContext.role,
        model: input.profile.model.model,
        connectionMechanism: input.profile.connectionMechanism,
        noopSnapshot: true,
        workspaceShape: workspace.shape,
        workspaceRootCount: workspace.workspaceRoots.length,
        ...(structuredResult !== undefined ? {
          schemaId: structuredResult.capture.schemaId,
          resultFile: structuredResult.capture.resultFile,
          resultCaptureMechanism: structuredResult.projection.mechanism
        } : {})
      });

      // 5. Materialize resolved runtime skills: sandbox mounts + a system-prompt
      //    hint (legacy), AND native SDK skill descriptors (SKILL.md content) so
      //    the model receives the skills natively rather than having to read files.
      const env = input.runInput.environment;
      const skillMaterialization = materializeOpenAISkillFiles(env.skills, runtimeSkillsCatalogRoot);
      const skillDescriptors = buildOpenAISkillDescriptors(env.skills, runtimeSkillsCatalogRoot);
      const instructions = buildOpenAIAgentInstructions(skillMaterialization.systemPromptHint);
      const promptShape = buildPromptShapeDiagnostic({
        prompt: input.runInput.environment.context.task.prompt,
        instructions,
        skillHintAppended: skillMaterialization.systemPromptHint.length > 0,
        structuredOutput: openAIOutputTypeStructuredResult !== undefined
      });
      const nativeSkillDescriptorsWithReferences = skillDescriptors
        .filter((descriptor) => descriptor.references !== undefined && Object.keys(descriptor.references).length > 0)
        .map((descriptor) => descriptor.name);
      const nativeSkillReferenceEntries = summarizeDescriptorReferenceEntries(skillDescriptors);
      safeLog('info', 'openai.adapter.runtime_skills_prepared', {
        runId: input.runInput.environment.context.run.id,
        step: input.runInput.environment.context.run.currentStep,
        role: input.telemetryContext.role,
        providerKind: input.profile.providerKind,
        adapterId: openaiAgentAdapterId,
        requestedSkillCount: env.skills.requested.length,
        requestedSkillRefs: [...env.skills.requested],
        resolvedSkillCount: env.skills.resolved.length,
        resolvedSkillRefs: env.skills.resolved.map((skill) => skill.ref),
        stagedSkillMountCount: skillMaterialization.mounts.length,
        stagedSkillSandboxPaths: skillMaterialization.mounts.map((mount) => mount.sandboxPath),
        nativeSkillDescriptorCount: skillDescriptors.length,
        nativeSkillDescriptorNames: skillDescriptors.map((descriptor) => descriptor.name),
        nativeSkillDescriptorsWithReferences,
        nativeSkillReferenceEntries,
        sdkHandoffMode: skillDescriptors.length > 0 ? 'native_skills' : 'default_manifest',
        progressToolsSuppressedForRuntimeSkills: skillDescriptors.length > 0,
        promptShape
      });
      if (env.skills.requested.length > 0 && env.skills.resolved.length === 0) {
        safeLog('warn', 'openai.adapter.runtime_skills_unresolved', {
          runId: input.runInput.environment.context.run.id,
          step: input.runInput.environment.context.run.currentStep,
          role: input.telemetryContext.role,
          providerKind: input.profile.providerKind,
          adapterId: openaiAgentAdapterId,
          requestedSkillRefs: [...env.skills.requested]
        });
      }

      // 6. Open the sandbox session over the materialized workspace (including skill mounts).
      let sandboxHandle: OpenAISandboxClientHandle;
      try {
        sandboxHandle = await sandboxClientFactory({
          workspace,
          snapshot,
          environment: safeEnvironment,
          telemetryContext: input.telemetryContext,
          skillMounts: skillMaterialization.mounts
        });
      } catch (err) {
        const classified = err instanceof ClassifiedProviderFailureError ? err : classifySdkError(err);
        const safeDetail = {
          ...buildSafeAdapterFailureLogDetail(err ?? {}, openaiProviderKind),
          ...(classified?.safeDetails ?? {}),
          ...buildSafeOpenAISdkErrorDiagnostic(err)
        };
        const failureCode = typeof safeDetail.code === 'string' ? safeDetail.code : undefined;
        safeLog('error', 'openai.adapter.sandbox_failed', {
          runId: input.telemetryContext.runId,
          step: input.telemetryContext.step,
          ...(classified !== undefined ? { failureReason: classified.failureReason } : {}),
          ...(failureCode !== undefined ? { failureCode } : {}),
          ...(structuredResult !== undefined ? {
            structuredResultCapture: true,
            schemaId: structuredResult.capture.schemaId,
            resultFile: structuredResult.capture.resultFile,
            resultCaptureMechanism: structuredResult.projection.mechanism
          } : {}),
          ...safeDetail
        });
        if (classified !== undefined) throw classified;
        throw err;
      }

      // 7. Per-session OpenAI client + model provider. The OpenAI client's fetch
      //    is bridged to the per-session ProviderFetchTransport, and the provider
      //    is passed to the per-session Runner — NEVER a global setter.
      //
      //    When proxyMode is 'required', the connection's fetch transport already
      //    rebases every request URL to the loopback proxy — do NOT pass the
      //    upstream baseURL to the OpenAI client (the transport owns URL routing).
      try {
      const endpoint = input.profile.endpoint as { baseUrl?: string; proxyMode?: string };
      const proxyModeRequired = endpoint.proxyMode === 'required';
      const openAIClient = new OpenAI({
        apiKey: 'sk-autocatalyst-transport-bound',
        ...(!proxyModeRequired && isNonEmptyString(endpoint.baseUrl) ? { baseURL: endpoint.baseUrl } : {}),
        fetch: bridgeTransportToFetch(transport)
      });
      // OpenAIProvider's `openAIClient` is typed via its own (import-mode)
      // resolution of `openai`; under NodeNext that is nominally distinct from
      // the default-mode `OpenAI` we instantiate here even though both resolve
      // to the same package. Borrow the provider's own expected type so the two
      // identities unify without widening to `any`.
      type OpenAIProviderOptions = NonNullable<ConstructorParameters<typeof OpenAIProvider>[0]>;
      type OpenAIProviderClient = NonNullable<OpenAIProviderOptions['openAIClient']>;
      const providerOptions: OpenAIProviderOptions = {
        openAIClient: openAIClient as unknown as OpenAIProviderClient,
        useResponses: true
      };
      const modelProvider = new OpenAIProvider(providerOptions);
      safeLog('info', 'openai.adapter.transport_selected', {
        runId: input.runInput.environment.context.run.id,
        step: input.runInput.environment.context.run.currentStep,
        role: input.telemetryContext.role,
        model: input.profile.model.model,
        transport: 'responses'
      });

      const inferenceMapping = mapInferenceSettings(input.profile);
      const tools = createProgressTools();

      // The manifest the run driver hands to the SandboxAgent mirrors the one the
      // client used to open the session, so defaultManifest matches the session
      // (including skill mounts). Reviewer sessions get read-only workspace roots
      // so the SandboxAgent cannot write outside the scratch root even if the agent
      // attempts file modifications.
      const manifest = buildWorkspaceManifest(
        workspace,
        safeEnvironment,
        skillMaterialization.mounts,
        input.telemetryContext.role === 'reviewer'
      );
      const runManifest = sandboxHandle.manifest ?? manifest;

      safeLog('info', 'openai.adapter.prompt_shape_prepared', {
        runId: input.runInput.environment.context.run.id,
        step: input.runInput.environment.context.run.currentStep,
        role: input.telemetryContext.role,
        promptShape
      });

      // Load continuity state from the previous turn (if model memory is configured).
      let modelMemoryState: OpenAIResponsesContinuityState | undefined;
      if (input.modelMemory !== undefined) {
        const snapshot = await input.modelMemory.store.load();
        if (
          snapshot !== null &&
          snapshot.providerKind === openaiProviderKind &&
          snapshot.adapterId === openaiAgentAdapterId
        ) {
          const state = snapshot.state as Record<string, unknown>;
          const prevId = typeof state['previousResponseId'] === 'string' ? state['previousResponseId'] : undefined;
          const convId = typeof state['conversationId'] === 'string' ? state['conversationId'] : undefined;
          if (prevId !== undefined || convId !== undefined) {
            modelMemoryState = {
              ...(prevId !== undefined ? { previousResponseId: prevId } : {}),
              ...(convId !== undefined ? { conversationId: convId } : {})
            };
          }
        }
      }

      const outcome = await runAgentSession({
        prompt: input.runInput.environment.context.task.prompt,
        model: input.profile.model.model,
        instructions,
        tools,
        manifest: runManifest,
        session: sandboxHandle.session,
        modelProvider,
        modelSettings: inferenceMapping.mapped,
        ...(skillDescriptors.length > 0 ? { skillDescriptors } : {}),
        ...(openAIOutputTypeStructuredResult !== undefined ? { structuredResult: openAIOutputTypeStructuredResult } : {}),
        ...(modelMemoryState !== undefined ? { modelMemoryState } : {})
      });

      let metadataResolve!: (value: AgentProviderSessionMetadata) => void;
      let metadataReject!: (err: unknown) => void;
      const metadataPromise = new Promise<AgentProviderSessionMetadata>((resolve, reject) => {
        metadataResolve = resolve;
        metadataReject = reject;
      });
      metadataPromise.catch(() => undefined);

      async function* events(): AsyncIterable<RunnerEvent> {
        const ctx: EventContext = {
          runId: input.runInput.environment.context.run.id,
          step: input.runInput.environment.context.run.currentStep,
          clock,
          eventIdGenerator
        };
        let terminalSeen = false;
        try {
          yield runtimeSkillDiagnosticNotification({
            requestedSkillRefs: env.skills.requested,
            resolvedSkillRefs: env.skills.resolved.map((skill) => skill.ref),
            handoffMode: skillDescriptors.length > 0 ? 'native_skills' : 'default_manifest',
            referenceEntries: nativeSkillReferenceEntries,
            promptShape
          }, ctx);

          for await (const item of outcome.items) {
            const event = mapRunItem(item, ctx);
            if (event === undefined) continue;
            if (terminalSeen) {
              throw new ProviderProtocolError(
                'impossible_session_sequence',
                'OpenAI run produced events after the terminal result.',
                { providerKind: openaiProviderKind, adapterId: openaiAgentAdapterId }
              );
            }
            yield event;
          }

          const terminal = await outcome.result;

          // Persist continuity state before yielding the terminal event.
          if (input.modelMemory !== undefined && terminal.responsesContinuity !== undefined) {
            const continuity = terminal.responsesContinuity;
            const continuityState: Record<string, string> = {};
            if (continuity.previousResponseId !== undefined) continuityState['previousResponseId'] = continuity.previousResponseId;
            if (continuity.conversationId !== undefined) continuityState['conversationId'] = continuity.conversationId;
            await input.modelMemory.store.save({
              providerKind: openaiProviderKind,
              adapterId: openaiAgentAdapterId,
              state: continuityState
            });
          }

          // Result-file handoff: write the final output to the scratch root.
          // Only on advance.
          if (terminal.directive === 'advance') {
            if (openAIOutputTypeStructuredResult !== undefined) {
              // Structured capture: use parsed output, not prose
              await writeStructuredResultFile(input.runInput.environment, openAIOutputTypeStructuredResult, terminal.output);
            } else if (structuredResult !== undefined) {
              if (input.telemetryContext.role === 'reviewer' && structuredResult.capture.step === 'implementation.build') {
                // Reviewers are read-only and record their verdict from the final
                // message. Avoid OpenAI outputType here so the model still uses
                // read-only tools before returning JSON.
                await writeStructuredResultFromFinalOutput(input.runInput.environment, structuredResult, terminal.output);
              } else {
                // Structured capture without OpenAI outputType: prefer the JSON
                // the agent authored inside the active sandbox, but accept a
                // valid final JSON payload when the result file is absent.
                await copyStructuredResultFileFromSandboxOrFinalOutput(
                  input.runInput.environment,
                  workspace,
                  sandboxHandle.session,
                  structuredResult,
                  terminal.output,
                  // Record the capture path without model or file contents.
                  (detail) => safeLog('info', 'openai.adapter.result_capture_diagnostic', {
                    runId: ctx.runId, step: ctx.step, ...detail
                  })
                );
              }
            } else if (structuredResult === undefined) {
              // Legacy no-contract path: write prose finalOutput as before
              await maybeWriteResultFile(input.runInput.environment, terminal.output);
            }
          }

          if (terminal.directive === 'advance' && structuredResult !== undefined) {
            safeLog('info', 'openai.adapter.result_capture_diagnostic', {
              runId: ctx.runId, step: ctx.step, captureStage: 'capture_complete',
              schemaId: structuredResult.capture.schemaId, resultFile: structuredResult.capture.resultFile,
              resultCaptureMechanism: openAIOutputTypeStructuredResult !== undefined ? 'openai_output_type' : 'sandbox_or_final_output'
            });
          }

          let terminalEvent: RunnerEvent;
          if (terminal.directive === 'needs_input') {
            terminalEvent = {
              ...baseEvent(ctx),
              type: 'runner_terminal_result',
              importance: 'high' as const,
              result: { directive: 'needs_input', question: terminal.question ?? 'The OpenAI agent requested more input.' }
            } as RunnerEvent;
          } else if (terminal.directive === 'fail') {
            terminalEvent = {
              ...baseEvent(ctx),
              type: 'runner_terminal_result',
              importance: 'high' as const,
              result: { directive: 'fail', reason: terminal.reason ?? 'OpenAI agent session failed.' }
            } as RunnerEvent;
          } else {
            terminalEvent = {
              ...baseEvent(ctx),
              type: 'runner_terminal_result',
              importance: 'high' as const,
              result: { directive: 'advance' }
            } as RunnerEvent;
          }
          terminalSeen = true;
          yield terminalEvent;

          metadataResolve({
            outcome: terminal.directive === 'fail' ? 'failed' : 'succeeded',
            launchMechanism: 'fetch_transport',
            degradedCapabilities: inferenceMapping.degraded,
            tokenUsage: terminal.tokenUsage
              ? { available: true, tokens: { input: terminal.tokenUsage.input, output: terminal.tokenUsage.output, cacheRead: 0, cacheWrite: 0 } }
              : { available: false },
            model: input.profile.model
          });
        } catch (err) {
          const classified = err instanceof ClassifiedProviderFailureError
            ? err
            : err instanceof ProviderProtocolError
              ? undefined
              : classifySdkError(err) ?? new ClassifiedProviderFailureError('runner_failed_before_terminal_result', {
                  providerKind: openaiProviderKind,
                  ...buildSafeOpenAISdkErrorDiagnostic(err)
                });
          const thrown = classified ?? err;
          const safeDetail = {
            ...buildSafeAdapterFailureLogDetail(err ?? {}, openaiProviderKind),
            ...buildSafeOpenAISdkErrorDiagnostic(err),
            // Keep the original SDK cause instead of replacing
            // its name with the ClassifiedProviderFailureError wrapper.
            ...(classified?.safeDetails ?? {})
          };
          const failureCode = typeof safeDetail.code === 'string' ? safeDetail.code : undefined;
          const protocolErrorCode = err instanceof ProviderProtocolError ? err.code : undefined;
          safeLog('error', 'openai.adapter.session_failed', {
            runId: input.runInput.environment.context.run.id,
            step: input.runInput.environment.context.run.currentStep,
            ...(classified !== undefined ? { failureReason: classified.failureReason } : {}),
            ...(failureCode !== undefined ? { failureCode } : {}),
            ...(protocolErrorCode !== undefined ? { protocolErrorCode } : {}),
            ...(structuredResult !== undefined ? {
              structuredResultCapture: true,
              schemaId: structuredResult.capture.schemaId,
              resultFile: structuredResult.capture.resultFile,
              resultCaptureMechanism: structuredResult.projection.mechanism
            } : {}),
            ...safeDetail
          });
          metadataReject(thrown);
          throw thrown;
        }
      }

      return {
        events: events(),
        metadata: metadataPromise,
        async close(): Promise<void> {
          await sandboxHandle.close?.();
        }
      };
      } catch (err) {
        const classified = classifySdkError(err);
        safeLog('error', 'openai.adapter.session_failed', {
          runId: input.telemetryContext.runId, step: input.telemetryContext.step,
          stage: 'session_setup',
          ...buildSafeAdapterFailureLogDetail(err ?? {}, openaiProviderKind),
          ...buildSafeOpenAISdkErrorDiagnostic(err),
          ...(classified?.safeDetails ?? {})
        });
        try { await sandboxHandle.close?.(); } catch {
          safeLog('warn', 'openai.adapter.sandbox_cleanup_failed', { runId: input.telemetryContext.runId });
        }
        throw classified ?? err;
      }
    }
  };
}
