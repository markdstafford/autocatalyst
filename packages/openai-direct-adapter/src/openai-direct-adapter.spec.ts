import { describe, it, expect, vi } from 'vitest';
import {
  createOpenAIDirectAdapter,
  openaiProviderKind,
  openaiDirectAdapterId
} from './openai-direct-adapter.js';
import type { DirectProviderCallInput } from '@autocatalyst/execution';
import {
  DirectProviderProtocolError,
  ProviderConnectionError,
  createAgentConnection
} from '@autocatalyst/execution';
import type {
  ResolvedAgentRunnerProfile,
  AgentConnection,
  AgentConnectionTelemetryContext,
  ProviderFetchTransport
} from '@autocatalyst/execution';
import { z } from 'zod';

const OPENAI_FAKE_SECRET = 'sk-openai-fake-secret-key-1234';
const RAW_PROMPT_BODY = 'my raw prompt body with secret';
const RAW_PROVIDER_RESPONSE = 'raw provider response data here';

function makeFetchTransport(
  responseFactory: () => Promise<Response>
): ProviderFetchTransport {
  return { fetch: vi.fn(responseFactory) };
}

function makeProfile(overrides: Partial<ResolvedAgentRunnerProfile> = {}): ResolvedAgentRunnerProfile {
  return {
    mode: 'direct',
    providerKind: openaiProviderKind,
    adapterId: openaiDirectAdapterId,
    profileName: 'test-openai-direct',
    model: { provider: 'openai', model: 'gpt-4o' },
    inferenceSettings: {},
    endpoint: {},
    connectionMechanism: 'fetch_transport',
    ...overrides
  };
}

function makeConnection(fetchTransport: ProviderFetchTransport): AgentConnection {
  return {
    profile: makeProfile(),
    credentialResolved: true,
    createFetchTransport: vi.fn(() => fetchTransport),
    createProcessLaunchConfig: vi.fn()
  } as unknown as AgentConnection;
}

function makeTelemetryContext(): AgentConnectionTelemetryContext {
  return { runId: 'run_test', step: 'classify_intent' };
}

function makeDirectInput(
  fetchTransport: ProviderFetchTransport,
  schemaOverride?: z.ZodTypeAny
): DirectProviderCallInput {
  const schema = schemaOverride ?? z.object({ intent: z.enum(['implement', 'review']) }).strict();
  return {
    call: {
      purpose: 'intent_classification',
      input: { id: 'msg_1' },
      resultValidation: { schemaId: 'intent-result', schema }
    },
    profile: makeProfile(),
    connection: makeConnection(fetchTransport),
    telemetryContext: makeTelemetryContext()
  };
}

function makeToolCallResponse(args: unknown, model = 'gpt-4o'): Response {
  const body = JSON.stringify({
    id: 'chatcmpl_123',
    model,
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'autocatalyst_direct_result', arguments: JSON.stringify(args) }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeContentResponse(text: string): Response {
  const body = JSON.stringify({
    id: 'chatcmpl_456',
    model: 'gpt-4o',
    choices: [
      {
        message: { role: 'assistant', content: text },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 }
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('createOpenAIDirectAdapter', () => {
  describe('test 12: adapter constants', () => {
    it('exports correct provider kind constant', () => {
      expect(openaiProviderKind).toBe('openai');
    });

    it('exports correct adapter id constant', () => {
      expect(openaiDirectAdapterId).toBe('openai-direct');
    });

    it('adapter has correct providerKind and adapterId', () => {
      const adapter = createOpenAIDirectAdapter();
      expect(adapter.providerKind).toBe('openai');
      expect(adapter.adapterId).toBe('openai-direct');
      expect(adapter.supportedConnectionMechanism).toBe('fetch_transport');
    });
  });

  describe('test 1: successful tool-call extraction', () => {
    it('returns candidate from tool_call with correct token usage', async () => {
      const expectedResult = { intent: 'review' };
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeToolCallResponse(expectedResult))
      );
      const adapter = createOpenAIDirectAdapter();
      const result = await adapter.call(makeDirectInput(transport));

      expect(result.candidate).toEqual(expectedResult);
      expect(result.metadata.outcome).toBe('succeeded');
      expect(result.metadata.tokenUsage.available).toBe(true);
      expect(result.metadata.tokenUsage.tokens?.input).toBe(50);
      expect(result.metadata.tokenUsage.tokens?.output).toBe(10);
      expect(result.metadata.tokenUsage.tokens?.cacheRead).toBe(0);
      expect(result.metadata.tokenUsage.tokens?.cacheWrite).toBe(0);
    });
  });

  describe('test 2: successful JSON-only fallback', () => {
    it('returns candidate from message content containing pure JSON', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeContentResponse('{"intent":"implement"}'))
      );
      const adapter = createOpenAIDirectAdapter();
      const result = await adapter.call(makeDirectInput(transport));

      expect(result.candidate).toEqual({ intent: 'implement' });
      expect(result.metadata.outcome).toBe('succeeded');
    });
  });

  describe('test 3: extra prose around JSON', () => {
    it('throws structured_result_malformed when content has prose before JSON', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeContentResponse('Here is the result: {"intent":"implement"}'))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toThrow(
        DirectProviderProtocolError
      );
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'structured_result_malformed'
      });
    });
  });

  describe('test 4: malformed JSON in content', () => {
    it('throws structured_result_malformed when content contains invalid JSON', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeContentResponse('{invalid json here}'))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'structured_result_malformed'
      });
    });
  });

  describe('test 4b: malformed JSON in tool_call arguments', () => {
    it('throws structured_result_malformed when tool_call arguments are invalid JSON', async () => {
      const body = JSON.stringify({
        id: 'chatcmpl_badargs',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'autocatalyst_direct_result', arguments: '{not valid json' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 }
      });
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'structured_result_malformed'
      });
    });
  });

  describe('test 5: multiple tool_calls', () => {
    it('throws multiple_structured_candidates when response has more than one tool_call', async () => {
      const body = JSON.stringify({
        id: 'chatcmpl_789',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"a":1}' } },
                { id: 'call_2', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"b":2}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5 }
      });
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'multiple_structured_candidates'
      });
    });
  });

  describe('test 6: missing candidate (no tool_call, no content)', () => {
    it('throws structured_result_missing when message has no tool_call or content', async () => {
      const body = JSON.stringify({
        id: 'chatcmpl_empty',
        model: 'gpt-4o',
        choices: [
          { message: { role: 'assistant', content: '' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1 }
      });
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'structured_result_missing'
      });
    });

    it('throws structured_result_missing when tool_call has unexpected name', async () => {
      const body = JSON.stringify({
        id: 'chatcmpl_wrongname',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_x', type: 'function', function: { name: 'some_other_tool', arguments: '{}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1 }
      });
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'structured_result_missing'
      });
    });
  });

  describe('test 7: tool_call + content text', () => {
    it('throws extra_structured_output when tool_call and content text coexist', async () => {
      const body = JSON.stringify({
        id: 'chatcmpl_mixed',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Some preamble text here.',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"x":1}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 25, completion_tokens: 8 }
      });
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'extra_structured_output'
      });
    });
  });

  describe('test 8: non-2xx response', () => {
    it('throws ProviderConnectionError(non_transient_provider_failure) for 400 response', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response('{"error":"bad request"}', { status: 400 }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toBeInstanceOf(
        ProviderConnectionError
      );
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'non_transient_provider_failure'
      });
    });

    it('throws ProviderConnectionError(non_transient_provider_failure) for 500 response', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response('Internal Server Error', { status: 500 }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'non_transient_provider_failure'
      });
    });
  });

  describe('test 9: fetch throws', () => {
    it('throws ProviderConnectionError(timeout) when transport.fetch rejects', async () => {
      const transport = makeFetchTransport(() => Promise.reject(new Error('network error')));
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toBeInstanceOf(
        ProviderConnectionError
      );
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'timeout'
      });
    });
  });

  describe('test 10: token usage normalization', () => {
    it('maps prompt/completion tokens and zeroes cache fields', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeToolCallResponse({ intent: 'review' }))
      );
      const adapter = createOpenAIDirectAdapter();
      const result = await adapter.call(makeDirectInput(transport));

      expect(result.metadata.tokenUsage.available).toBe(true);
      expect(result.metadata.tokenUsage.tokens?.input).toBe(50);
      expect(result.metadata.tokenUsage.tokens?.output).toBe(10);
      expect(result.metadata.tokenUsage.tokens?.cacheRead).toBe(0);
      expect(result.metadata.tokenUsage.tokens?.cacheWrite).toBe(0);
    });
  });

  describe('test 11: token usage unavailable', () => {
    it('returns available: false when usage is missing from response', async () => {
      const body = JSON.stringify({
        id: 'chatcmpl_nousage',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
        // no usage field
      });
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const adapter = createOpenAIDirectAdapter();
      const result = await adapter.call(makeDirectInput(transport));

      expect(result.metadata.tokenUsage.available).toBe(false);
      expect(result.metadata.tokenUsage.tokens).toBeUndefined();
    });
  });

  describe('test 13: malformed top-level JSON', () => {
    it('throws structured_result_malformed when response body is not JSON', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(new Response('not json at all', { status: 200, headers: { 'content-type': 'application/json' } }))
      );
      const adapter = createOpenAIDirectAdapter();
      await expect(adapter.call(makeDirectInput(transport))).rejects.toBeInstanceOf(
        DirectProviderProtocolError
      );
      await expect(adapter.call(makeDirectInput(transport))).rejects.toMatchObject({
        code: 'structured_result_malformed'
      });
    });
  });

  describe('test 14: degraded capabilities', () => {
    it('records unsupported optional inference settings as degradedCapabilities', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeToolCallResponse({ intent: 'implement' }))
      );
      const adapter = createOpenAIDirectAdapter();
      const input = makeDirectInput(transport);
      const inputWithSettings: DirectProviderCallInput = {
        ...input,
        profile: makeProfile({
          inferenceSettings: { topK: 5, streamingMode: 'stream', parallelToolCalls: true }
        })
      };
      const result = await adapter.call(inputWithSettings);

      const capabilities = result.metadata.degradedCapabilities.map((d) => d.capability);
      expect(capabilities).toContain('topK');
      expect(capabilities).toContain('streamingMode');
      expect(capabilities).toContain('parallelToolCalls');
      for (const degraded of result.metadata.degradedCapabilities) {
        expect(degraded.required).toBe(false);
      }
    });

    it('records no degraded capabilities when none are present', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeToolCallResponse({ intent: 'implement' }))
      );
      const adapter = createOpenAIDirectAdapter();
      const result = await adapter.call(makeDirectInput(transport));
      expect(result.metadata.degradedCapabilities).toHaveLength(0);
    });
  });

  describe('test 15: no sensitive data in errors', () => {
    it('does not leak OPENAI_FAKE_SECRET in ProviderConnectionError', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: RAW_PROVIDER_RESPONSE, key: OPENAI_FAKE_SECRET }),
            { status: 401 }
          )
        )
      );
      const adapter = createOpenAIDirectAdapter();

      let thrown: unknown;
      try {
        await adapter.call(makeDirectInput(transport));
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(ProviderConnectionError);
      const serialized = JSON.stringify({
        message: (thrown as Error).message,
        safeDetails: (thrown as ProviderConnectionError).safeDetails
      });
      expect(serialized).not.toContain(OPENAI_FAKE_SECRET);
      expect(serialized).not.toContain(RAW_PROVIDER_RESPONSE);
      expect(serialized).not.toContain(RAW_PROMPT_BODY);
    });

    it('does not leak RAW_PROMPT_BODY when fetch throws', async () => {
      const transport = makeFetchTransport(() =>
        Promise.reject(new Error(`Connection failed with body: ${RAW_PROMPT_BODY}`))
      );
      const adapter = createOpenAIDirectAdapter();

      let thrown: unknown;
      try {
        await adapter.call(makeDirectInput(transport));
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(ProviderConnectionError);
      const serialized = JSON.stringify({
        message: (thrown as Error).message,
        safeDetails: (thrown as ProviderConnectionError).safeDetails
      });
      expect(serialized).not.toContain(RAW_PROMPT_BODY);
      expect(serialized).not.toContain(OPENAI_FAKE_SECRET);
    });
  });

  describe('test 16: request construction', () => {
    it('includes the call.input data and chat-completions shape in the outbound request body', async () => {
      const callInput = { taskId: 'task_42', category: 'feature', priority: 'high' };
      const capturedBodies: string[] = [];
      const transport: ProviderFetchTransport = {
        fetch: vi.fn(async (req) => {
          capturedBodies.push(req.body ?? '');
          return makeToolCallResponse({ intent: 'implement' });
        })
      };
      const connection = makeConnection(transport);
      const adapter = createOpenAIDirectAdapter();
      await adapter.call({
        call: {
          purpose: 'intent_classification',
          input: callInput,
          resultValidation: { schemaId: 'intent', schema: z.object({ intent: z.string() }) }
        },
        profile: makeProfile(),
        connection,
        telemetryContext: makeTelemetryContext()
      });

      expect(capturedBodies).toHaveLength(1);
      const parsedBody = JSON.parse(capturedBodies[0]!) as {
        model: string;
        messages: Array<{ content: string }>;
        tools: Array<{ type: string; function: { name: string } }>;
        tool_choice: { type: string; function: { name: string } };
      };
      expect(parsedBody.model).toBe('gpt-4o');
      const messageContent = parsedBody.messages[0]!.content;
      expect(messageContent).toContain(JSON.stringify(callInput));
      // Structured-output forcing
      expect(parsedBody.tools[0]!.type).toBe('function');
      expect(parsedBody.tools[0]!.function.name).toBe('autocatalyst_direct_result');
      expect(parsedBody.tool_choice).toEqual({
        type: 'function',
        function: { name: 'autocatalyst_direct_result' }
      });
    });
  });

  describe('test 17: uses fetch transport, NOT direct credentials', () => {
    it('calls connection.createFetchTransport()', async () => {
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeToolCallResponse({ intent: 'implement' }))
      );
      const connection = makeConnection(transport);
      const input = makeDirectInput(transport);
      const inputWithSpy: DirectProviderCallInput = { ...input, connection };

      const adapter = createOpenAIDirectAdapter();
      await adapter.call(inputWithSpy);

      expect(connection.createFetchTransport).toHaveBeenCalledTimes(1);
    });

    it('does not access process.env for credentials', async () => {
      const envBefore = { ...process.env };
      const transport = makeFetchTransport(() =>
        Promise.resolve(makeToolCallResponse({ intent: 'review' }))
      );
      const adapter = createOpenAIDirectAdapter();
      await adapter.call(makeDirectInput(transport));

      expect(process.env).toEqual(envBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// Production-seam tests: real createAgentConnection, only outermost fetch mocked
// ---------------------------------------------------------------------------

describe('openai-direct-adapter: production connection seam', () => {
  it('sends a properly-serialized JSON body through the real createAgentConnection transport', async () => {
    const capturedRequests: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];

    const outerFetch: typeof globalThis.fetch = async (url, init) => {
      capturedRequests.push({
        url: String(url),
        method: (init?.method ?? 'GET') as string,
        body: init?.body as string | undefined,
        headers: init?.headers as Record<string, string> | undefined
      });
      return new Response(JSON.stringify({
        id: 'chatcmpl_prod_1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_prod_1', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"intent":"implement"}' } }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const profile: ResolvedAgentRunnerProfile = {
      mode: 'direct',
      providerKind: openaiProviderKind,
      adapterId: openaiDirectAdapterId,
      profileName: 'prod-seam-test',
      model: { provider: 'openai', model: 'gpt-4o' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'fetch_transport'
    };

    const connection = await createAgentConnection({
      profile,
      credentialReference: { required: false },
      credentialResolver: { resolveCredential: async () => undefined },
      telemetryContext: { runId: 'run_seam_1', phase: 'main', step: 'classify' },
      fetch: outerFetch
    });

    const adapter = createOpenAIDirectAdapter();
    const schema = z.object({ intent: z.enum(['implement', 'review']) }).strict();
    const result = await adapter.call({
      call: {
        purpose: 'intent_classification',
        input: { rawText: 'implement this feature' },
        resultValidation: { schemaId: 'intent-result', schema }
      },
      profile,
      connection,
      telemetryContext: { runId: 'run_seam_1', phase: 'main', step: 'classify' }
    });

    // The outermost fetch was reached (production seam exercised)
    expect(capturedRequests).toHaveLength(1);
    const req = capturedRequests[0]!;

    // Body is a single-encoded JSON string (not double-encoded)
    expect(typeof req.body).toBe('string');
    const parsed = JSON.parse(req.body!);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    // Body should be an object with model, messages — not a string literal
    expect(typeof parsed.model).toBe('string');
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.tool_choice).toEqual({ type: 'function', function: { name: 'autocatalyst_direct_result' } });

    // Result was parsed correctly from the response
    expect(result.candidate).toEqual({ intent: 'implement' });
    expect(result.metadata.outcome).toBe('succeeded');
  });

  it('correctly maps token usage from the real transport response', async () => {
    const outerFetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({
      model: 'gpt-4o',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_2', type: 'function', function: { name: 'autocatalyst_direct_result', arguments: '{"result":"ok"}' } }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const profile: ResolvedAgentRunnerProfile = {
      mode: 'direct',
      providerKind: openaiProviderKind,
      adapterId: openaiDirectAdapterId,
      profileName: 'prod-seam-usage',
      model: { provider: 'openai', model: 'gpt-4o' },
      inferenceSettings: {},
      endpoint: {},
      connectionMechanism: 'fetch_transport'
    };

    const connection = await createAgentConnection({
      profile,
      credentialReference: { required: false },
      credentialResolver: { resolveCredential: async () => undefined },
      telemetryContext: { runId: 'run_seam_2', step: 'usage_test' },
      fetch: outerFetch
    });

    const adapter = createOpenAIDirectAdapter();
    const schema = z.object({ result: z.string() });
    const result = await adapter.call({
      call: {
        purpose: 'test_usage',
        input: {},
        resultValidation: { schemaId: 'test-result', schema }
      },
      profile,
      connection,
      telemetryContext: { runId: 'run_seam_2', step: 'usage_test' }
    });

    expect(result.metadata.tokenUsage.available).toBe(true);
    if (result.metadata.tokenUsage.available) {
      expect(result.metadata.tokenUsage.tokens.input).toBe(100);
      expect(result.metadata.tokenUsage.tokens.output).toBe(50);
      expect(result.metadata.tokenUsage.tokens.cacheRead).toBe(0);
      expect(result.metadata.tokenUsage.tokens.cacheWrite).toBe(0);
    }
  });
});
