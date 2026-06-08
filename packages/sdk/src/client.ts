import {
  createProbeResourceRequestSchema,
  createProbeResourceSuccessStatusCode,
  degradedHealthStatusCode,
  errorResponseSchema,
  healthResponseSchema,
  probeResourceCollectionPath,
  probeResourceSchema,
  type CreateProbeResourceRequest,
  type ErrorResponse,
  type HealthResponse,
  type ProbeResource
} from '@autocatalyst/api-contract';

export interface ControlPlaneClientOptions {
  readonly baseUrl: string | URL;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ControlPlaneClient {
  getHealth(): Promise<HealthResponse>;
  createProbeResource(request: CreateProbeResourceRequest): Promise<ProbeResource>;
  getProbeResource(id: string): Promise<ProbeResource>;
}

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

export function createControlPlaneClient(options: ControlPlaneClientOptions): ControlPlaneClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
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
        headers: { 'content-type': 'application/json' },
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
        { method: 'GET' }
      );
      await throwForError(response);
      return probeResourceSchema.parse(await parseJson(response));
    }
  };
}
