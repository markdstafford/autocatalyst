import {
  configurationRecordCollectionPath,
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  conversationCollectionPath,
  createConfigurationRecordRequestSchema,
  createConfigurationRecordSuccessStatusCode,
  createConversationSuccessStatusCode,
  createConversationWithFirstRunRequestSchema,
  createConversationWithFirstRunResponseSchema,
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  createSecretRequestSchema,
  createSecretResponseSchema,
  createSecretSuccessStatusCode,
  degradedHealthStatusCode,
  deleteConfigurationRecordSuccessStatusCode,
  errorResponseSchema,
  healthResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema,
  appendRunFeedbackThreadRequestSchema,
  appendRunFeedbackThreadSuccessStatusCode,
  createRunFeedbackRequestSchema,
  createRunFeedbackSuccessStatusCode,
  createRunReplySuccessStatusCode,
  feedbackSchema,
  runFeedbackThreadPath,
  getRunPullRequestSuccessStatusCode,
  getRunSpecSuccessStatusCode,
  listRunFeedbackSuccessStatusCode,
  listRunSessionsSuccessStatusCode,
  pullRequestReconciliationPath,
  pullRequestReconciliationResponseSchema,
  reconcilePullRequestsSuccessStatusCode,
  runCollectionPath,
  runEventsPath,
  runFeedbackListResponseSchema,
  runFeedbackPath,
  runListResponseSchema,
  runPullRequestPath,
  runPullRequestResponseSchema,
  runRepliesPath,
  runReplyRequestSchema,
  runReplyResponseSchema,
  runResourcePath,
  runSchema,
  runSessionListResponseSchema,
  runSessionsPath,
  runSpecPath,
  runSpecResponseSchema,
  runStepListResponseSchema,
  runStepsPath,
  secretCollectionPath,
  updateConfigurationRecordRequestSchema,
  type ConfigurationRecord,
  type ConfigurationRecordListResponse,
  type CreateConfigurationRecordRequest,
  type CreateConversationWithFirstRunRequest,
  type CreateConversationWithFirstRunResponse,
  type CreateProbeResourceRequest,
  type AppendRunFeedbackThreadRequest,
  type CreateRunFeedbackRequest,
  type CreateSecretRequest,
  type ReconcilePullRequestsResponse,
  type RunReplyRequest,
  type RunReplyResponse,
  type CreateSecretResponse,
  type ErrorResponse,
  type Feedback,
  type HealthResponse,
  type ProbeResource,
  type Run,
  type RunFeedbackListResponse,
  type RunListResponse,
  type RunPullRequestResponse,
  type RunSessionListResponse,
  type RunStepListResponse,
  type RunSpecResponse,
  type UpdateConfigurationRecordRequest
} from '@autocatalyst/api-contract';

export interface ControlPlaneClientOptions {
  readonly baseUrl: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly bearerToken?: string;
}

export interface ControlPlaneClient {
  getHealth(): Promise<HealthResponse>;
  createProbeResource(request: CreateProbeResourceRequest): Promise<ProbeResource>;
  getProbeResource(id: string): Promise<ProbeResource>;
  createConfigurationRecord(request: CreateConfigurationRecordRequest): Promise<ConfigurationRecord>;
  listConfigurationRecords(): Promise<ConfigurationRecordListResponse>;
  getConfigurationRecord(id: string): Promise<ConfigurationRecord>;
  updateConfigurationRecord(id: string, patch: UpdateConfigurationRecordRequest): Promise<ConfigurationRecord>;
  deleteConfigurationRecord(id: string): Promise<void>;
  createSecret(request: CreateSecretRequest): Promise<CreateSecretResponse>;
  createConversationWithFirstRun(request: CreateConversationWithFirstRunRequest): Promise<CreateConversationWithFirstRunResponse>;
  listRuns(): Promise<RunListResponse>;
  getRun(id: string): Promise<Run>;
  listRunSteps(id: string): Promise<RunStepListResponse>;
  getRunPullRequest(id: string): Promise<RunPullRequestResponse>;
  listRunSessions(id: string): Promise<RunSessionListResponse>;
  subscribeRunEvents(id: string, options?: RunEventsStreamOptions): Promise<RunEventsResponse>;
  getRunSpec(id: string): Promise<RunSpecResponse>;
  createRunFeedback(id: string, request: CreateRunFeedbackRequest): Promise<Feedback>;
  listRunFeedback(id: string): Promise<RunFeedbackListResponse>;
  appendRunFeedbackThreadReply(id: string, feedbackId: string, request: AppendRunFeedbackThreadRequest): Promise<Feedback>;
  replyToRun(id: string, request: RunReplyRequest): Promise<RunReplyResponse>;
  reconcilePullRequests(): Promise<ReconcilePullRequestsResponse>;
}

export interface RunEventsStreamOptions {
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
  readonly replay?: 'retained';
}

export type RunEventsResponse = { readonly kind: 'response'; readonly response: Response };

export class ControlPlaneClientError extends Error {
  readonly status: number;
  readonly response: ErrorResponse;

  constructor(status: number, response: ErrorResponse) {
    super(response.error.message);
    this.name = 'ControlPlaneClientError';
    this.status = status;
    this.response = response;
  }
}

function normalizeBaseUrl(baseUrl: string | URL): URL {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/$/u, '');
  return url;
}

function urlFor(baseUrl: URL, path: string): URL {
  return new URL(path, `${baseUrl.origin}${baseUrl.pathname}/`);
}

async function parseJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function throwForError(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const parsed = errorResponseSchema.parse(await parseJson(response));
  throw new ControlPlaneClientError(response.status, parsed);
}

function protectedHeaders(bearerToken: string | undefined, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (bearerToken !== undefined) {
    headers['authorization'] = `Bearer ${bearerToken}`;
  }
  return headers;
}

export function createControlPlaneClient(options: ControlPlaneClientOptions): ControlPlaneClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const { bearerToken } = options;
  if (fetchImplementation === undefined) {
    throw new Error('A fetch implementation is required.');
  }

  return {
    async getHealth() {
      const response = await fetchImplementation(urlFor(baseUrl, '/health'), { method: 'GET' });
      if (response.ok || response.status === degradedHealthStatusCode) {
        return healthResponseSchema.parse(await parseJson(response));
      }
      const parsed = errorResponseSchema.parse(await parseJson(response));
      throw new ControlPlaneClientError(response.status, parsed);
    },

    async createProbeResource(request) {
      const body = createProbeResourceRequestSchema.parse(request);
      const response = await fetchImplementation(urlFor(baseUrl, probeResourceCollectionPath), {
        method: 'POST',
        headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
        body: JSON.stringify(body)
      });
      await throwForError(response);
      if (response.status !== createProbeResourceSuccessStatusCode) {
        throw new Error(
          `Expected ${createProbeResourceSuccessStatusCode} from createProbeResource, received ${response.status}.`
        );
      }
      return probeResourceSchema.parse(await parseJson(response));
    },

    async getProbeResource(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, `${probeResourceCollectionPath}/${id}`),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      return probeResourceSchema.parse(await parseJson(response));
    },

    async createConfigurationRecord(request) {
      const body = createConfigurationRecordRequestSchema.parse(request);
      const response = await fetchImplementation(urlFor(baseUrl, configurationRecordCollectionPath), {
        method: 'POST',
        headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
        body: JSON.stringify(body)
      });
      await throwForError(response);
      if (response.status !== createConfigurationRecordSuccessStatusCode) {
        throw new Error(
          `Expected ${createConfigurationRecordSuccessStatusCode} from createConfigurationRecord, received ${response.status}.`
        );
      }
      return configurationRecordResponseSchema.parse(await parseJson(response));
    },

    async listConfigurationRecords() {
      const response = await fetchImplementation(urlFor(baseUrl, configurationRecordCollectionPath), {
        method: 'GET',
        headers: protectedHeaders(bearerToken)
      });
      await throwForError(response);
      return configurationRecordListResponseSchema.parse(await parseJson(response));
    },

    async getConfigurationRecord(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, `${configurationRecordCollectionPath}/${id}`),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      return configurationRecordResponseSchema.parse(await parseJson(response));
    },

    async updateConfigurationRecord(id, patch) {
      const body = updateConfigurationRecordRequestSchema.parse(patch);
      const response = await fetchImplementation(
        urlFor(baseUrl, `${configurationRecordCollectionPath}/${id}`),
        {
          method: 'PATCH',
          headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
          body: JSON.stringify(body)
        }
      );
      await throwForError(response);
      return configurationRecordResponseSchema.parse(await parseJson(response));
    },

    async deleteConfigurationRecord(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, `${configurationRecordCollectionPath}/${id}`),
        { method: 'DELETE', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      if (response.status !== deleteConfigurationRecordSuccessStatusCode) {
        throw new Error(
          `Expected ${deleteConfigurationRecordSuccessStatusCode} from deleteConfigurationRecord, received ${response.status}.`
        );
      }
    },

    async createSecret(request) {
      const body = createSecretRequestSchema.parse(request);
      const response = await fetchImplementation(urlFor(baseUrl, secretCollectionPath), {
        method: 'POST',
        headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
        body: JSON.stringify(body)
      });
      await throwForError(response);
      if (response.status !== createSecretSuccessStatusCode) {
        throw new Error(
          `Expected ${createSecretSuccessStatusCode} from createSecret, received ${response.status}.`
        );
      }
      return createSecretResponseSchema.parse(await parseJson(response));
    },

    async createConversationWithFirstRun(request) {
      const body = createConversationWithFirstRunRequestSchema.parse(request);
      const response = await fetchImplementation(urlFor(baseUrl, conversationCollectionPath), {
        method: 'POST',
        headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
        body: JSON.stringify(body)
      });
      await throwForError(response);
      if (response.status !== createConversationSuccessStatusCode) {
        throw new Error(
          `Expected ${createConversationSuccessStatusCode} from createConversationWithFirstRun, received ${response.status}.`
        );
      }
      return createConversationWithFirstRunResponseSchema.parse(await parseJson(response));
    },

    async listRuns() {
      const response = await fetchImplementation(urlFor(baseUrl, runCollectionPath), {
        method: 'GET',
        headers: protectedHeaders(bearerToken)
      });
      await throwForError(response);
      return runListResponseSchema.parse(await parseJson(response));
    },

    async getRun(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, runResourcePath.replace(':id', id)),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      return runSchema.parse(await parseJson(response));
    },

    async listRunSteps(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, runStepsPath.replace(':id', id)),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      return runStepListResponseSchema.parse(await parseJson(response));
    },

    async getRunPullRequest(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, runPullRequestPath.replace(':id', id)),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      if (response.status !== getRunPullRequestSuccessStatusCode) {
        throw new Error(`Expected ${getRunPullRequestSuccessStatusCode} from getRunPullRequest, received ${response.status}.`);
      }
      return runPullRequestResponseSchema.parse(await parseJson(response));
    },

    async listRunSessions(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, runSessionsPath.replace(':id', id)),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      if (response.status !== listRunSessionsSuccessStatusCode) {
        throw new Error(`Expected ${listRunSessionsSuccessStatusCode} from listRunSessions, received ${response.status}.`);
      }
      return runSessionListResponseSchema.parse(await parseJson(response));
    },

    async subscribeRunEvents(id, options) {
      const headers: Record<string, string> = protectedHeaders(bearerToken);
      if (options?.lastEventId !== undefined) {
        headers['last-event-id'] = options.lastEventId;
      }
      const url = urlFor(baseUrl, runEventsPath.replace(':id', id));
      if (options?.replay === 'retained') {
        url.searchParams.set('replay', 'retained');
      }
      const response = await fetchImplementation(
        url,
        { method: 'GET', headers, ...(options?.signal !== undefined ? { signal: options.signal } : {}) }
      );
      if (!response.ok) {
        const parsed = errorResponseSchema.parse(await parseJson(response));
        throw new ControlPlaneClientError(response.status, parsed);
      }
      return { kind: 'response' as const, response };
    },

    async getRunSpec(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, runSpecPath.replace(':id', id)),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      if (response.status !== getRunSpecSuccessStatusCode) {
        throw new Error(`Expected ${getRunSpecSuccessStatusCode} from getRunSpec, received ${response.status}.`);
      }
      return runSpecResponseSchema.parse(await parseJson(response));
    },

    async createRunFeedback(id, request) {
      const body = createRunFeedbackRequestSchema.parse(request);
      const response = await fetchImplementation(
        urlFor(baseUrl, runFeedbackPath.replace(':id', id)),
        {
          method: 'POST',
          headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
          body: JSON.stringify(body)
        }
      );
      await throwForError(response);
      if (response.status !== createRunFeedbackSuccessStatusCode) {
        throw new Error(`Expected ${createRunFeedbackSuccessStatusCode} from createRunFeedback, received ${response.status}.`);
      }
      return feedbackSchema.parse(await parseJson(response));
    },

    async listRunFeedback(id) {
      const response = await fetchImplementation(
        urlFor(baseUrl, runFeedbackPath.replace(':id', id)),
        { method: 'GET', headers: protectedHeaders(bearerToken) }
      );
      await throwForError(response);
      if (response.status !== listRunFeedbackSuccessStatusCode) {
        throw new Error(`Expected ${listRunFeedbackSuccessStatusCode} from listRunFeedback, received ${response.status}.`);
      }
      return runFeedbackListResponseSchema.parse(await parseJson(response));
    },

    async appendRunFeedbackThreadReply(id, feedbackId, request) {
      const body = appendRunFeedbackThreadRequestSchema.parse(request);
      const path = runFeedbackThreadPath
        .replace(':id', id)
        .replace(':feedbackId', feedbackId);
      const response = await fetchImplementation(
        urlFor(baseUrl, path),
        {
          method: 'POST',
          headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
          body: JSON.stringify(body)
        }
      );
      await throwForError(response);
      if (response.status !== appendRunFeedbackThreadSuccessStatusCode) {
        throw new Error(`Expected ${appendRunFeedbackThreadSuccessStatusCode} from appendRunFeedbackThreadReply, received ${response.status}.`);
      }
      return feedbackSchema.parse(await parseJson(response));
    },

    async replyToRun(id, request) {
      const body = runReplyRequestSchema.parse(request);
      const response = await fetchImplementation(
        urlFor(baseUrl, runRepliesPath.replace(':id', id)),
        {
          method: 'POST',
          headers: protectedHeaders(bearerToken, { 'content-type': 'application/json' }),
          body: JSON.stringify(body)
        }
      );
      await throwForError(response);
      if (response.status !== createRunReplySuccessStatusCode) {
        throw new Error(`Expected ${createRunReplySuccessStatusCode} from replyToRun, received ${response.status}.`);
      }
      return runReplyResponseSchema.parse(await parseJson(response));
    },

    async reconcilePullRequests() {
      const response = await fetchImplementation(urlFor(baseUrl, pullRequestReconciliationPath), {
        method: 'POST',
        headers: protectedHeaders(bearerToken)
      });
      await throwForError(response);
      if (response.status !== reconcilePullRequestsSuccessStatusCode) {
        throw new Error(`Expected ${reconcilePullRequestsSuccessStatusCode} from reconcilePullRequests, received ${response.status}.`);
      }
      return pullRequestReconciliationResponseSchema.parse(await parseJson(response));
    }
  };
}
