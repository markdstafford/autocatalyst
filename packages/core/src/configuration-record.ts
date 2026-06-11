import type {
  ConfigurationRecord,
  CreateConfigurationRecordRequest,
  UpdateConfigurationRecordRequest
} from '@autocatalyst/api-contract';

export type CreateConfigurationRecordInput = CreateConfigurationRecordRequest;
export type UpdateConfigurationRecordInput = UpdateConfigurationRecordRequest;

export interface ConfigurationRecordRepository {
  create(input: CreateConfigurationRecordInput): Promise<ConfigurationRecord>;
  list(tenant: string): Promise<readonly ConfigurationRecord[]>;
  findById(tenant: string, id: string): Promise<ConfigurationRecord | null>;
  update(tenant: string, id: string, input: UpdateConfigurationRecordInput): Promise<ConfigurationRecord | null>;
  delete(tenant: string, id: string): Promise<boolean>;
}

export function createConfigurationRecord(
  repository: ConfigurationRecordRepository,
  input: CreateConfigurationRecordInput
): Promise<ConfigurationRecord> {
  return repository.create(input);
}

export function listConfigurationRecords(
  repository: ConfigurationRecordRepository,
  tenant: string
): Promise<readonly ConfigurationRecord[]> {
  return repository.list(tenant);
}

export function getConfigurationRecord(
  repository: ConfigurationRecordRepository,
  tenant: string,
  id: string
): Promise<ConfigurationRecord | null> {
  return repository.findById(tenant, id);
}

export function updateConfigurationRecord(
  repository: ConfigurationRecordRepository,
  tenant: string,
  id: string,
  input: UpdateConfigurationRecordInput
): Promise<ConfigurationRecord | null> {
  return repository.update(tenant, id, input);
}

export function deleteConfigurationRecord(
  repository: ConfigurationRecordRepository,
  tenant: string,
  id: string
): Promise<boolean> {
  return repository.delete(tenant, id);
}
