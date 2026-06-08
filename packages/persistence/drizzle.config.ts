import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/persistence/src/schema.ts',
  out: './packages/persistence/drizzle'
});
