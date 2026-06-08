import { randomUUID } from 'node:crypto';

import type { CreateProbeResourceRequest, ProbeResource } from '@autocatalyst/api-contract';
import type { ProbeResourceRepository } from '@autocatalyst/core';
import { eq } from 'drizzle-orm';

import { probeResources } from './schema.js';
import { asInternalSqliteDatabase, type SqliteDatabase } from './sqlite.js';

export class DrizzleProbeResourceRepository implements ProbeResourceRepository {
  readonly #database;

  constructor(database: SqliteDatabase) {
    this.#database = asInternalSqliteDatabase(database);
  }

  async create(input: CreateProbeResourceRequest): Promise<ProbeResource> {
    const resource: ProbeResource = {
      id: `probe_${randomUUID()}`,
      value: input.value,
      createdAt: new Date().toISOString()
    };

    this.#database.drizzle.insert(probeResources).values({
      id: resource.id,
      value: resource.value,
      createdAt: resource.createdAt
    }).run();

    return resource;
  }

  async findById(id: string): Promise<ProbeResource | null> {
    const rows = this.#database.drizzle
      .select({
        id: probeResources.id,
        value: probeResources.value,
        createdAt: probeResources.createdAt
      })
      .from(probeResources)
      .where(eq(probeResources.id, id))
      .limit(1)
      .all();

    return rows[0] ?? null;
  }
}
