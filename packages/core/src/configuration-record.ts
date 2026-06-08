import type {
  ConfigurationRecord,
  CreateConfigurationRecordRequest,
  UpdateConfigurationRecordRequest
} from '@autocatalyst/api-contract';

export type CreateConfigurationRecordInput = CreateConfigurationRecordRequest;
export type UpdateConfigurationRecordInput = UpdateConfigurationRecordRequest;

export interface ConfigurationRecordRepository {
  create(input: CreateConfigurationRecordInput): Promise<ConfigurationRecord>;
  list(): Promise<readonly ConfigurationRecord[]>;
  findById(id: string): Promise<ConfigurationRecord | null>;
  update(id: string, input: UpdateConfigurationRecordInput): Promise<ConfigurationRecord | null>;
  delete(id: string): Promise<boolean>;
}

export function createConfigurationRecord(
  repository: ConfigurationRecordRepository,
  input: CreateConfigurationRecordInput
): Promise<ConfigurationRecord> {
  return repository.create(input);
}

export function listConfigurationRecords(
  repository: ConfigurationRecordRepository
): Promise<readonly ConfigurationRecord[]> {
  return repository.list();
}

export function getConfigurationRecord(
  repository: ConfigurationRecordRepository,
  id: string
): Promise<ConfigurationRecord | null> {
  return repository.findById(id);
}

export function updateConfigurationRecord(
  repository: ConfigurationRecordRepository,
  id: string,
  input: UpdateConfigurationRecordInput
): Promise<ConfigurationRecord | null> {
  return repository.update(id, input);
}

export function deleteConfigurationRecord(
  repository: ConfigurationRecordRepository,
  id: string
): Promise<boolean> {
  return repository.delete(id);
}
