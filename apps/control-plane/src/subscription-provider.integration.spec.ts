import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSqliteDatabase, migrateSqliteDatabase, DrizzleConfigurationRecordRepository } from '@autocatalyst/persistence';
import { createControlPlaneServer } from './server.js';

describe('subscription provider configuration', () => {
  it('activates and updates secret-free routes while API routes still require a credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subscription-config-'));
    const databasePath = join(dir, 'test.sqlite');
    const database = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(database);
    const repository = new DrizzleConfigurationRecordRepository(database);
    const claude = await repository.create({ tenant: 'tenant_dev', kind: 'provider_profile', providerKind: 'anthropic', adapterId: 'claude-agent-sdk-subscription', settings: { profileName: 'Claude Team', model: { provider: 'anthropic', model: 'sonnet' } } });
    const codex = await repository.create({ tenant: 'tenant_dev', kind: 'provider_profile', providerKind: 'codex', adapterId: 'codex-app-server-business', settings: { profileName: 'Codex Business', model: { provider: 'openai', model: 'gpt-6.1-sol' } } });
    const api = await repository.create({ tenant: 'tenant_dev', kind: 'provider_profile', providerKind: 'anthropic', adapterId: 'claude-agent-sdk', settings: { profileName: 'API without key', model: { provider: 'anthropic', model: 'sonnet' } } });
    database.close();
    const app = await createControlPlaneServer({ databasePath, bearerToken: 'test', masterSecret: 'test-master', realRunnerDispatch: { enabled: true } });
    const headers = { authorization: 'Bearer test' };
    try {
      const routing = { active: true, entries: [
        { id: 'implementer', route: { mode: 'agent', step: 'spec.author', role: 'implementer' }, profileId: codex.id },
        { id: 'reviewer', route: { mode: 'agent', step: 'spec.author', role: 'reviewer' }, profileId: claude.id }
      ] };
      const created = await app.inject({ method: 'POST', url: '/v1/configuration-records', headers, payload: { kind: 'model_routing_table', settings: routing } });
      expect(created.statusCode).toBe(201);
      const patched = await app.inject({ method: 'PATCH', url: '/v1/configuration-records/' + claude.id, headers, payload: { kind: 'provider_profile', settings: { profileName: 'Claude Team renamed' } } });
      expect(patched.statusCode).toBe(200);
      const invalid = await app.inject({ method: 'PATCH', url: '/v1/configuration-records/' + created.json().id, headers, payload: { kind: 'model_routing_table', settings: { entries: [{ ...routing.entries[0], profileId: api.id }] } } });
      expect(invalid.statusCode).toBe(422);
      const switchToApi = await app.inject({ method: 'PATCH', url: '/v1/configuration-records/' + claude.id, headers, payload: { kind: 'provider_profile', adapterId: 'claude-agent-sdk' } });
      expect(switchToApi.statusCode).toBe(422);
    } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
  });
});
