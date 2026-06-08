import type {
  CreateProbeResourceRequest,
  ProbeResource
} from '@autocatalyst/api-contract';

export interface ProbeResourceRepository {
  create(input: CreateProbeResourceRequest): Promise<ProbeResource>;
  findById(id: string): Promise<ProbeResource | null>;
}

export async function createProbeResource(
  repository: ProbeResourceRepository,
  request: CreateProbeResourceRequest
): Promise<ProbeResource> {
  return repository.create(request);
}

export async function getProbeResource(
  repository: ProbeResourceRepository,
  id: string
): Promise<ProbeResource | null> {
  return repository.findById(id);
}
