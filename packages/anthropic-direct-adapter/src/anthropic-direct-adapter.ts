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

export const anthropicProviderKind = 'anthropic' as const;
export const anthropicDirectAdapterId = 'anthropic-direct' as const;

export interface AnthropicDirectAdapterLogger {
  info(event: string, fields: unknown): void;
  warn(event: string, fields: unknown): void;
  error(event: string, fields: unknown): void;
}

export interface AnthropicDirectAdapterOptions {
  readonly logger?: AnthropicDirectAdapterLogger;
  readonly baseUrl?: string; // override for tests; production uses connection layer
}

// Internal Anthropic API types (not exported)
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicTextBlock;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicMessagesResponse {
  id?: string;
  content: AnthropicContentBlock[];
  model?: string;
  usage?: AnthropicUsage;
  stop_reason?: string;
}

function mapTokenUsage(usage: AnthropicUsage | undefined): AgentTokenUsage {
  if (usage === undefined) return { available: false };
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    available: true,
    tokens: {
      input,
      output,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0
    }
  };
}

export function createAnthropicDirectAdapter(
  options: AnthropicDirectAdapterOptions = {}
): DirectProviderAdapter {
  return {
    providerKind: anthropicProviderKind,
    adapterId: anthropicDirectAdapterId,
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
      const unsupportedOptional = ['streamingMode', 'parallelToolCalls'] as const;
      for (const key of unsupportedOptional) {
        if ((profile.inferenceSettings as Record<string, unknown>)[key] !== undefined) {
          degradedCapabilities.push({
            capability: key,
            reason: `Anthropic direct adapter does not support ${key}`
          } as ProviderCapabilityDegradation);
        }
      }

      // Build request body
      // Prefer tool_use structured output for clean extraction
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
            content: `Perform this task: ${call.purpose}\n\nInput data:\n${inputSerialized}\n\nYou MUST call the \`${toolName}\` tool with your result.`
          }
        ],
        tools: [
          {
            name: toolName,
            description: 'Return your structured result',
            input_schema: {
              type: 'object',
              description: `Result for ${call.purpose} (schema: ${call.resultValidation.schemaId})`
            }
          }
        ],
        tool_choice: { type: 'tool', name: toolName }
      };

      // Send through fetch transport (connection layer handles auth, retry, timeout, redaction)
      const baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
      let response: Response;
      try {
        response = await transport.fetch({
          url: `${baseUrl}/v1/messages`,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(requestBody)
        });
      } catch {
        throw new ProviderConnectionError(
          'timeout',
          'Anthropic direct request failed.',
          { providerKind: anthropicProviderKind, adapterId: anthropicDirectAdapterId }
        );
      }

      if (!response.ok) {
        const statusClass = response.status >= 500 ? '5xx' : response.status >= 400 ? '4xx' : 'other';
        throw new ProviderConnectionError(
          'non_transient_provider_failure',
          'Anthropic direct request returned error status.',
          { status: response.status, statusClass }
        );
      }

      let parsed: AnthropicMessagesResponse;
      try {
        parsed = (await response.json()) as AnthropicMessagesResponse;
      } catch {
        throw new DirectProviderProtocolError(
          'structured_result_malformed',
          'Anthropic direct response could not be parsed as JSON.',
          { providerKind: anthropicProviderKind, adapterId: anthropicDirectAdapterId }
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

function extractCandidate(response: AnthropicMessagesResponse, toolName: string): unknown {
  const content = response.content ?? [];

  // Tool-use path: look for exactly one tool_use block
  const toolUseBlocks = content.filter((b): b is AnthropicToolUseBlock => b.type === 'tool_use');
  const textBlocks = content.filter((b): b is AnthropicTextBlock => b.type === 'text');

  if (toolUseBlocks.length > 1) {
    throw new DirectProviderProtocolError(
      'multiple_structured_candidates',
      'Anthropic response contained multiple tool_use blocks.',
      { count: toolUseBlocks.length }
    );
  }

  if (toolUseBlocks.length === 1) {
    const block = toolUseBlocks[0]!;
    if (block.name !== toolName) {
      throw new DirectProviderProtocolError(
        'structured_result_missing',
        `Anthropic response tool_use block has unexpected name: ${block.name}`,
        { expected: toolName, actual: block.name }
      );
    }
    // Check for extra text outside the tool call
    const hasSignificantText = textBlocks.some(b => b.text.trim().length > 0);
    if (hasSignificantText) {
      throw new DirectProviderProtocolError(
        'extra_structured_output',
        'Anthropic response had text content alongside a tool_use block.',
        {}
      );
    }
    return block.input;
  }

  // JSON fallback: expect exactly one text block with a single JSON object
  if (textBlocks.length === 0) {
    throw new DirectProviderProtocolError(
      'structured_result_missing',
      'Anthropic response contained no tool_use or text content.',
      {}
    );
  }

  if (textBlocks.length > 1) {
    throw new DirectProviderProtocolError(
      'multiple_structured_candidates',
      'Anthropic response contained multiple text blocks.',
      { count: textBlocks.length }
    );
  }

  const text = textBlocks[0]!.text.trim();

  // Must be only a JSON object, no surrounding prose
  if (!text.startsWith('{') && !text.startsWith('[')) {
    throw new DirectProviderProtocolError(
      'structured_result_malformed',
      'Anthropic text response is not a JSON object or array.',
      {}
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new DirectProviderProtocolError(
      'structured_result_malformed',
      'Anthropic text response could not be parsed as JSON.',
      {}
    );
  }
}
