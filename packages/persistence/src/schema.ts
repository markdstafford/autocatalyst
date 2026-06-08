import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const probeResources = sqliteTable('probe_resources', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  createdAt: text('created_at').notNull()
});
