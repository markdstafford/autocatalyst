import type {
  AgentTokenUsage,
  DirectProviderAdapter,
  DirectProviderCallInput,
  DirectProviderCallResult,
  ProviderCapabilityDegradation
} from '@autocatalyst/execution';
import {
  DirectProviderProtocolError,
  ProviderConnectionError
} from '@autocatalyst/execution';

export const openaiProviderKind = 'openai' as const;
export const openaiDirectAdapterId = 'openai-direct' as const;

export interface OpenAIDirectAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface OpenAIDirectAdapterOptions {
  readonly logger?: OpenAIDirectAdapterLogger;
  readonly baseUrl?: string; // override for tests; production uses connection layer
}

// Internal OpenAI chat-completions API types (not exported)
interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIMessage {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAIChoice {
  message?: OpenAIMessage;
  finish_reason?: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

function mapTokenUsage(usage: OpenAIUsage | undefined): AgentTokenUsage {
  if (usage === undefined) return { available: false };
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return {
    available: true,
    tokens: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0
    }
  };
}

export function createOpenAIDirectAdapter(
  options: OpenAIDirectAdapterOptions = {}
): DirectProviderAdapter {
  return {
    providerKind: openaiProviderKind,
    adapterId: openaiDirectAdapterId,
    supportedConnectionMechanism: 'fetch_transport',

    async call(input: DirectProviderCallInput): Promise<DirectProviderCallResult> {
      const { call, profile, connection } = input;
      const transport = connection.createFetchTransport();
      const degradedCapabilities: ProviderCapabilityDegradation[] = [];

      // Build inference settings
      const maxTokens = (profile.inferenceSettings as { maxOutputTokens?: number }).maxOutputTokens ?? 64;
      const temperature = (profile.inferenceSettings as { temperature?: number }).temperature;
      const topP = (profile.inferenceSettings as { topP?: number }).topP;

      // Track unsupported settings
      const unsupportedOptional = ['topK', 'streamingMode', 'parallelToolCalls'] as const;
      for (const key of unsupportedOptional) {
        if ((profile.inferenceSettings as Record<string, unknown>)[key] !== undefined) {
          degradedCapabilities.push({
            capability: key,
            reason: `OpenAI direct adapter does not support ${key}`,
            required: false
          });
        }
      }

      // Build request body.
      // Force structured output via OpenAI function calling for clean extraction.
      const toolName = 'autocatalyst_direct_result';
      // Serialize the call input safely. The raw value must reach the model
      // so it can perform the bounded task, but it must not appear in logs or
      // telemetry (handled by the connection-layer redaction boundary).
      let inputSerialized: string;
      try {
        inputSerialized = JSON.stringify(call.input);
      } catch {
        inputSerialized = '[non-serializable input]';
      }

      const requestBody: Record<string, unknown> = {
        model: profile.model.model,
        max_tokens: maxTokens,
        ...(temperature !== undefined && { temperature }),
        ...(topP !== undefined && { top_p: topP }),
        messages: [
          {
            role: 'user',
            content: `Perform this task: ${call.purpose}\n\nInput data:\n${inputSerialized}\n\nYou MUST call the \`${toolName}\` function with your result.`
          }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: toolName,
              description: `Return your structured result for ${call.purpose} (schema: ${call.resultValidation.schemaId})`,
              parameters: {
                type: 'object',
                description: `Result for ${call.purpose} (schema: ${call.resultValidation.schemaId})`
              }
            }
          }
        ],
        tool_choice: { type: 'function', function: { name: toolName } }
      };

      // Send through fetch transport (connection layer handles auth, retry, timeout, redaction).
      // Pass body as the JSON string: the connection layer passes string bodies through
      // unchanged and only stringifies non-string values.
      const baseUrl = options.baseUrl ?? 'https://api.openai.com';
      let response: Response;
      try {
        response = await transport.fetch({
          url: `${baseUrl}/v1/chat/completions`,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
      } catch {
        throw new ProviderConnectionError(
          'timeout',
          'OpenAI direct request failed.',
          { providerKind: openaiProviderKind, adapterId: openaiDirectAdapterId }
        );
      }

      if (!response.ok) {
        const statusClass = response.status >= 500 ? '5xx' : response.status >= 400 ? '4xx' : 'other';
        throw new ProviderConnectionError(
          'non_transient_provider_failure',
          'OpenAI direct request returned error status.',
          { status: response.status, statusClass }
        );
      }

      let parsed: OpenAIChatCompletionResponse;
      try {
        parsed = (await response.json()) as OpenAIChatCompletionResponse;
      } catch {
        throw new DirectProviderProtocolError(
          'structured_result_malformed',
          'OpenAI direct response could not be parsed as JSON.',
          { providerKind: openaiProviderKind, adapterId: openaiDirectAdapterId }
        );
      }

      // Extract exactly one structured candidate
      const candidate = extractCandidate(parsed, toolName);

      return {
        candidate,
        metadata: {
          outcome: 'succeeded',
          tokenUsage: mapTokenUsage(parsed.usage),
          degradedCapabilities,
          model: profile.model,
          purpose: call.purpose
        }
      };
    }
  };
}

function extractCandidate(response: OpenAIChatCompletionResponse, toolName: string): unknown {
  const message = response.choices?.[0]?.message ?? {};
  const toolCalls = message.tool_calls ?? [];
  const content = typeof message.content === 'string' ? message.content : '';

  // Tool-call path: look for exactly one tool_call
  if (toolCalls.length > 1) {
    throw new DirectProviderProtocolError(
      'multiple_structured_candidates',
      'OpenAI response contained multiple tool_calls.',
      { count: toolCalls.length }
    );
  }

  if (toolCalls.length === 1) {
    const toolCall = toolCalls[0]!;
    const name = toolCall.function?.name;
    if (name !== toolName) {
      throw new DirectProviderProtocolError(
        'structured_result_missing',
        `OpenAI response tool_call has unexpected name: ${name ?? '(none)'}`,
        { expected: toolName, actual: name }
      );
    }
    // Check for extra text alongside the tool call
    if (content.trim().length > 0) {
      throw new DirectProviderProtocolError(
        'extra_structured_output',
        'OpenAI response had message content alongside a tool_call.',
        {}
      );
    }
    const args = toolCall.function?.arguments;
    if (typeof args !== 'string') {
      throw new DirectProviderProtocolError(
        'structured_result_malformed',
        'OpenAI tool_call arguments were not a string.',
        {}
      );
    }
    try {
      return JSON.parse(args);
    } catch {
      throw new DirectProviderProtocolError(
        'structured_result_malformed',
        'OpenAI tool_call arguments could not be parsed as JSON.',
        {}
      );
    }
  }

  // JSON fallback: expect message content to be a single JSON object/array
  const text = content.trim();
  if (text.length === 0) {
    throw new DirectProviderProtocolError(
      'structured_result_missing',
      'OpenAI response contained no tool_call or message content.',
      {}
    );
  }

  // Must be only a JSON object, no surrounding prose
  if (!text.startsWith('{') && !text.startsWith('[')) {
    throw new DirectProviderProtocolError(
      'structured_result_malformed',
      'OpenAI text response is not a JSON object or array.',
      {}
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new DirectProviderProtocolError(
      'structured_result_malformed',
      'OpenAI text response could not be parsed as JSON.',
      {}
    );
  }
}
