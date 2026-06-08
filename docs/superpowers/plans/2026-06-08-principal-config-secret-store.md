# Principal Config Secret Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first authenticated `/v1` request seam, permissive policy-decision point, service-owned configuration CRUD, encrypted SQLite secret store, SDK support, and end-to-end coverage.

**Architecture:** Keep `apps/control-plane` as the composition shell that reads only bootstrap values, opens SQLite, migrates, unlocks the secret store, wires repositories, and registers core routes. Keep schemas and OpenAPI in `packages/api-contract`, route/use-case seams in `packages/core`, concrete Drizzle/crypto persistence in `packages/persistence`, and typed client behavior in `packages/sdk`. `GET /health` remains the only public operational route; every `/v1` route is protected by bearer auth, principal attachment, and policy authorization.

**Tech Stack:** TypeScript ESM, Nx, Fastify, Zod, Vitest, Drizzle ORM, better-sqlite3, Node `crypto` AES-256-GCM/scrypt, `@asteasolutions/zod-to-openapi`.

---

## Authoritative Inputs

- Approved spec: `context-human/specs/feature-principal-config-secret-store.md`.
- Current navigation: `context-agent/wiki/code-map.md`.
- Current conventions: `context-agent/standards/api-conventions.md`, `context-agent/standards/logging.md`, `context-agent/standards/workspace-conventions.md`.
- Important existing files:
  - `apps/control-plane/src/config.ts` reads only `CONTROL_PLANE_PORT` / `CONTROL_PLANE_DATABASE_PATH` and flags.
  - `apps/control-plane/src/server.ts` currently takes a caller-owned `SqliteDatabase`; this must become options-based composition.
  - `packages/core/src/routes.ts` currently registers public `/health`, `/v1/probe-resources`, and `/v1/events` in one function.
  - `packages/api-contract/src/probe-resource.ts`, `errors.ts`, `openapi.ts`, and `index.ts` define the contract pattern to extend.
  - `packages/persistence/src/schema.ts`, `sqlite.ts`, `probe-resource-repository.ts`, and `drizzle/0000_create_probe_resources.sql` define the persistence pattern to extend.
  - `packages/sdk/src/client.ts` currently has no auth header support.

## File Structure

Create or modify these files. Keep names exact unless an implementation step proves TypeScript requires a narrower split; if a split is needed, update this plan in the commit message and update `context-agent/wiki/code-map.md` in the same change.

### App shell

- Modify `apps/control-plane/src/config.ts` — add `bearerToken`, `masterSecret`, flags/env parsing, and non-secret validation messages.
- Modify `apps/control-plane/src/config.spec.ts` — env/flag precedence and validation tests for token and master secret.
- Modify `apps/control-plane/src/server.ts` — options-based `createControlPlaneServer`, database/migration ownership, secret-store unlock, repository/policy wiring, Fastify close cleanup.
- Modify `apps/control-plane/src/server.spec.ts` — empty option validation and close cleanup coverage for the new server options surface.
- Modify `apps/control-plane/src/integration.spec.ts` — real app auth, principal, policy, config CRUD, secret-handle separation, and health checker regression.
- Modify `apps/control-plane/src/main.ts` and `apps/control-plane/src/main.spec.ts` only to pass through new config values and assert logs do not include secrets if current tests require it.

### API contract

- Create `packages/api-contract/src/principal.ts` — `PrincipalKind`, `Principal`, and diagnostic response schemas/types.
- Create `packages/api-contract/src/principal.spec.ts` — valid diagnostic and invalid kind tests.
- Create `packages/api-contract/src/secret.ts` — `secretCollectionPath`, secret handle schema, create-secret request/response schemas/types.
- Create `packages/api-contract/src/secret.spec.ts` — exact `sec_` handle format tests and empty value rejection.
- Create `packages/api-contract/src/configuration-record.ts` — route constants, status constants, params, create/update/response/list schemas/types.
- Create `packages/api-contract/src/configuration-record.spec.ts` — create/update/list validation and secret-value exclusion tests.
- Modify `packages/api-contract/src/errors.ts` — stable error-code constants while preserving envelope shape.
- Modify `packages/api-contract/src/index.ts` and `index.spec.ts` — export all new contracts.
- Modify `packages/api-contract/src/openapi.ts` and `openapi.spec.ts` — register new paths using the same schemas/constants.

### Core

- Create `packages/core/src/principal.ts` and `principal.spec.ts` — hardcoded synthetic principal and request context helpers.
- Create `packages/core/src/auth.ts` and `auth.spec.ts` — bearer auth hook, async-capable principal resolver, constant-time comparison.
- Create `packages/core/src/policy.ts` and `policy.spec.ts` — policy interface, permissive implementation, route authorization helper.
- Create `packages/core/src/configuration-record.ts` and `configuration-record.spec.ts` — repository interface plus create/list/get/update/delete use cases.
- Create `packages/core/src/secret.ts` and `secret.spec.ts` — secret store interface, `createSecret` use case, locked error.
- Modify `packages/core/src/routes.ts` and `routes.spec.ts` — dependency bag, protected `/v1` plugin/wrapper, configuration CRUD routes, secret create route, optional principal diagnostic route.
- Modify `packages/core/src/index.ts` and `index.spec.ts` — public exports for new route dependencies and interfaces.

### Persistence

- Modify `packages/persistence/src/schema.ts` — add `configurationRecords`, `secretStoreMetadata`, and `secrets` Drizzle tables.
- Add `packages/persistence/drizzle/0001_create_configuration_and_secrets.sql` — committed migration.
- Modify `packages/persistence/drizzle/meta/_journal.json` — append migration metadata.
- Create `packages/persistence/src/configuration-record-repository.ts` and `.spec.ts` — Drizzle implementation of core config repository.
- Create `packages/persistence/src/secret-store.ts` and `.spec.ts` — encrypted SQLite secret store with unlock, sentinel, handle generation, and collision retry.
- Modify `packages/persistence/src/index.ts` and `index.spec.ts` — public exports for new implementations.

### SDK

- Modify `packages/sdk/src/client.ts` — optional `bearerToken`, auth headers for protected calls, config CRUD, create-secret.
- Modify `packages/sdk/src/client.spec.ts` — header behavior, config/secret methods, error mapping, test server auth migration.
- Modify `packages/sdk/src/index.ts` and `index.spec.ts` if export tests require new type exports.

### Agent docs

- Modify `context-agent/wiki/code-map.md` — bootstrap token/master-secret config, auth/principal/policy seams, config routes/repositories/migrations, secret store, SDK methods, env vars.
- Add `context-agent/decisions/core-api-request-type-aliases.md` — terse decision for intentional request input aliases in core.

---

## Implementation Tasks

### Task 1: Bootstrap Config Parsing

**Files:**
- Modify: `apps/control-plane/src/config.ts`
- Modify: `apps/control-plane/src/config.spec.ts`

- [ ] **Step 1: Write failing config tests for env values**

Add a test that expects all four bootstrap values to parse from env:

```ts
it('reads port, database path, bearer token, and master secret from environment variables', () => {
  expect(
    readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '4300',
      CONTROL_PLANE_DATABASE_PATH: '/tmp/control-plane.sqlite',
      CONTROL_PLANE_BEARER_TOKEN: 'test-bearer-token',
      CONTROL_PLANE_MASTER_SECRET: 'test-master-secret'
    })
  ).toEqual({
    port: 4300,
    databasePath: '/tmp/control-plane.sqlite',
    bearerToken: 'test-bearer-token',
    masterSecret: 'test-master-secret'
  });
});
```

- [ ] **Step 2: Write failing config tests for flag precedence**

Replace the existing flag precedence test with one that includes the new flags:

```ts
it('lets flags take precedence over environment variables', () => {
  expect(
    readControlPlaneAppConfig(
      [
        '--port',
        '4400',
        '--database-path',
        '/tmp/flag.sqlite',
        '--bearer-token',
        'flag-token',
        '--master-secret',
        'flag-secret'
      ],
      {
        CONTROL_PLANE_PORT: '4300',
        CONTROL_PLANE_DATABASE_PATH: '/tmp/env.sqlite',
        CONTROL_PLANE_BEARER_TOKEN: 'env-token',
        CONTROL_PLANE_MASTER_SECRET: 'env-secret'
      }
    )
  ).toEqual({
    port: 4400,
    databasePath: '/tmp/flag.sqlite',
    bearerToken: 'flag-token',
    masterSecret: 'flag-secret'
  });
});
```

- [ ] **Step 3: Write failing validation tests that do not leak secret values**

Add tests for missing/empty token and master secret. Assert only variable/flag names appear in messages:

```ts
it('throws for missing or empty bearer tokens without echoing provided values', () => {
  expect(() =>
    readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '4300',
      CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
      CONTROL_PLANE_MASTER_SECRET: 'test-master-secret'
    })
  ).toThrow('CONTROL_PLANE_BEARER_TOKEN or --bearer-token is required.');

  expect(() =>
    readControlPlaneAppConfig(['--bearer-token', '   '], {
      CONTROL_PLANE_PORT: '4300',
      CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
      CONTROL_PLANE_MASTER_SECRET: 'test-master-secret'
    })
  ).toThrow('CONTROL_PLANE_BEARER_TOKEN or --bearer-token is required.');
});

it('throws for missing or empty master secrets without echoing provided values', () => {
  expect(() =>
    readControlPlaneAppConfig([], {
      CONTROL_PLANE_PORT: '4300',
      CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
      CONTROL_PLANE_BEARER_TOKEN: 'test-bearer-token'
    })
  ).toThrow('CONTROL_PLANE_MASTER_SECRET or --master-secret is required.');

  expect(() =>
    readControlPlaneAppConfig(['--master-secret', '   '], {
      CONTROL_PLANE_PORT: '4300',
      CONTROL_PLANE_DATABASE_PATH: '/tmp/db.sqlite',
      CONTROL_PLANE_BEARER_TOKEN: 'test-bearer-token'
    })
  ).toThrow('CONTROL_PLANE_MASTER_SECRET or --master-secret is required.');
});
```

- [ ] **Step 4: Run config tests and confirm failure**

Run:

```bash
pnpm nx test control-plane -- --run apps/control-plane/src/config.spec.ts
```

Expected: failing assertions because `bearerToken` and `masterSecret` are not parsed yet.

- [ ] **Step 5: Implement config parsing**

Update `ControlPlaneAppConfig` and add a shared required-string parser:

```ts
export interface ControlPlaneAppConfig {
  readonly port: number;
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
}

function parseRequiredString(value: string | undefined, message: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}
```

Use it from `parseDatabasePath`, plus new parsers:

```ts
function parseDatabasePath(value: string | undefined): string {
  return parseRequiredString(value, 'CONTROL_PLANE_DATABASE_PATH or --database-path is required.');
}

function parseBearerToken(value: string | undefined): string {
  return parseRequiredString(value, 'CONTROL_PLANE_BEARER_TOKEN or --bearer-token is required.');
}

function parseMasterSecret(value: string | undefined): string {
  return parseRequiredString(value, 'CONTROL_PLANE_MASTER_SECRET or --master-secret is required.');
}
```

Extend `readControlPlaneAppConfig`:

```ts
const bearerTokenValue = readFlag(argv, '--bearer-token') ?? env['CONTROL_PLANE_BEARER_TOKEN'];
const masterSecretValue = readFlag(argv, '--master-secret') ?? env['CONTROL_PLANE_MASTER_SECRET'];

return {
  port: parsePort(portValue),
  databasePath: parseDatabasePath(databasePathValue),
  bearerToken: parseBearerToken(bearerTokenValue),
  masterSecret: parseMasterSecret(masterSecretValue)
};
```

- [ ] **Step 6: Run config tests and commit**

Run:

```bash
pnpm nx test control-plane -- --run apps/control-plane/src/config.spec.ts
```

Expected: all config tests pass.

Commit:

```bash
git add apps/control-plane/src/config.ts apps/control-plane/src/config.spec.ts
git commit -m "feat(control-plane): require auth bootstrap config"
```

### Task 2: Shared Principal, Secret, Configuration, and Error Contracts

**Files:**
- Create: `packages/api-contract/src/principal.ts`
- Create: `packages/api-contract/src/principal.spec.ts`
- Create: `packages/api-contract/src/secret.ts`
- Create: `packages/api-contract/src/secret.spec.ts`
- Create: `packages/api-contract/src/configuration-record.ts`
- Create: `packages/api-contract/src/configuration-record.spec.ts`
- Modify: `packages/api-contract/src/errors.ts`
- Modify: `packages/api-contract/src/index.ts`
- Modify: `packages/api-contract/src/index.spec.ts`

- [ ] **Step 1: Write contract tests for principal schemas**

Create `packages/api-contract/src/principal.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { principalDiagnosticResponseSchema, principalKindSchema, principalSchema } from './principal.js';

describe('principal contract schemas', () => {
  it('accepts supported principal kinds and a diagnostic response', () => {
    expect(principalKindSchema.options).toEqual(['human', 'model', 'system']);
    expect(
      principalDiagnosticResponseSchema.parse({
        principal: {
          id: 'principal_dev_human',
          kind: 'human',
          tenantId: 'tenant_dev',
          displayName: 'Development Principal'
        }
      })
    ).toEqual({
      principal: {
        id: 'principal_dev_human',
        kind: 'human',
        tenantId: 'tenant_dev',
        displayName: 'Development Principal'
      }
    });
  });

  it('rejects invalid principal kinds', () => {
    expect(() =>
      principalSchema.parse({ id: 'principal_bad', kind: 'robot', tenantId: 'tenant_dev' })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Write secret contract tests**

Create `packages/api-contract/src/secret.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  createSecretRequestSchema,
  createSecretResponseSchema,
  secretCollectionPath,
  secretHandleSchema
} from './secret.js';

describe('secret contract schemas', () => {
  it('uses the protected secret collection path', () => {
    expect(secretCollectionPath).toBe('/v1/secrets');
  });

  it('validates the exact opaque secret handle format', () => {
    const valid = 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    expect(secretHandleSchema.parse(valid)).toBe(valid);
    expect(() => secretHandleSchema.parse('sec_short')).toThrow();
    expect(() => secretHandleSchema.parse(`sec_${'A'.repeat(33)}`)).toThrow();
    expect(() => secretHandleSchema.parse(`sec_${'A'.repeat(31)}=`)).toThrow();
    expect(() => secretHandleSchema.parse(`sec_${'A'.repeat(31)}+`)).toThrow();
  });

  it('accepts create-secret requests and responses without exposing values in responses', () => {
    expect(createSecretRequestSchema.parse({ value: 'sk-test' })).toEqual({ value: 'sk-test' });
    expect(() => createSecretRequestSchema.parse({ value: '' })).toThrow();
    expect(createSecretResponseSchema.parse({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' })).toEqual({
      handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'
    });
    expect(() =>
      createSecretResponseSchema.parse({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', value: 'sk-test' })
    ).toThrow();
  });
});
```

- [ ] **Step 3: Write configuration contract tests**

Create `packages/api-contract/src/configuration-record.spec.ts` with coverage for create, update, response, and list:

```ts
import { describe, expect, it } from 'vitest';

import {
  configurationRecordCollectionPath,
  configurationRecordIdParamsSchema,
  configurationRecordListResponseSchema,
  configurationRecordResponseSchema,
  createConfigurationRecordRequestSchema,
  updateConfigurationRecordRequestSchema
} from './configuration-record.js';

const handle = 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';

describe('configuration record contract schemas', () => {
  it('uses the agreed collection path and id params', () => {
    expect(configurationRecordCollectionPath).toBe('/v1/configuration-records');
    expect(configurationRecordIdParamsSchema.parse({ id: 'cfg_123' })).toEqual({ id: 'cfg_123' });
  });

  it('validates provider profile create requests', () => {
    expect(
      createConfigurationRecordRequestSchema.parse({
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: 'default', credentialSecretHandle: handle }
      })
    ).toEqual({
      kind: 'provider_profile',
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default', credentialSecretHandle: handle }
    });
    expect(() =>
      createConfigurationRecordRequestSchema.parse({
        kind: 'provider_profile',
        providerKind: 'model_runner',
        adapterId: 'openai',
        settings: { profileName: '' }
      })
    ).toThrow();
  });

  it('validates narrow patch semantics', () => {
    expect(() => updateConfigurationRecordRequestSchema.parse({})).toThrow();
    expect(() => updateConfigurationRecordRequestSchema.parse({ id: 'cfg_bad' })).toThrow();
    expect(
      updateConfigurationRecordRequestSchema.parse({ settings: { credentialSecretHandle: null } })
    ).toEqual({ settings: { credentialSecretHandle: null } });
    expect(() => updateConfigurationRecordRequestSchema.parse({ settings: { profileName: '' } })).toThrow();
  });

  it('validates responses with datetime timestamps and no secret value field', () => {
    const record = {
      id: 'cfg_123',
      kind: 'provider_profile',
      providerKind: 'model_runner',
      adapterId: 'openai',
      settings: { profileName: 'default', credentialSecretHandle: handle },
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z'
    };
    expect(configurationRecordResponseSchema.parse(record)).toEqual(record);
    expect(configurationRecordListResponseSchema.parse({ records: [record] })).toEqual({ records: [record] });
    expect(() => configurationRecordResponseSchema.parse(Object.assign({}, record, { secretValue: 'sk-test' }))).toThrow();
    expect(() => configurationRecordResponseSchema.parse(Object.assign({}, record, { createdAt: 'not-a-date' }))).toThrow();
  });
});
```

- [ ] **Step 4: Write failing error constant export test**

Update `packages/api-contract/src/index.spec.ts` to import and assert these constants:

```ts
import {
  notFoundErrorCode,
  secretStoreLockedErrorCode,
  unauthorizedErrorCode,
  validationErrorCode
} from './index.js';

it('exports stable shared error code constants', () => {
  expect(unauthorizedErrorCode).toBe('unauthorized');
  expect(validationErrorCode).toBe('validation_error');
  expect(notFoundErrorCode).toBe('not_found');
  expect(secretStoreLockedErrorCode).toBe('secret_store_locked');
});
```

- [ ] **Step 5: Run api-contract tests and confirm failure**

Run:

```bash
pnpm nx test api-contract -- --run packages/api-contract/src/principal.spec.ts packages/api-contract/src/secret.spec.ts packages/api-contract/src/configuration-record.spec.ts packages/api-contract/src/index.spec.ts
```

Expected: module-not-found or missing export failures.

- [ ] **Step 6: Implement principal contract**

Create `packages/api-contract/src/principal.ts`:

```ts
import { z } from 'zod';

export const principalDiagnosticPath = '/v1/principal' as const;

export const principalKindSchema = z.enum(['human', 'model', 'system']);

export const principalSchema = z.object({
  id: z.string().min(1),
  kind: principalKindSchema,
  tenantId: z.string().min(1),
  displayName: z.string().min(1).optional()
}).strict();

export const principalDiagnosticResponseSchema = z.object({
  principal: principalSchema
}).strict();

export type PrincipalKind = z.infer<typeof principalKindSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type PrincipalDiagnosticResponse = z.infer<typeof principalDiagnosticResponseSchema>;
```

- [ ] **Step 7: Implement secret contract**

Create `packages/api-contract/src/secret.ts`:

```ts
import { z } from 'zod';

export const secretCollectionPath = '/v1/secrets' as const;
export const createSecretSuccessStatusCode = 201 as const;
export const secretHandlePattern = /^sec_[A-Za-z0-9_-]{32}$/u;

export const secretHandleSchema = z.string().regex(secretHandlePattern);

export const createSecretRequestSchema = z.object({
  value: z.string().min(1)
}).strict();

export const createSecretResponseSchema = z.object({
  handle: secretHandleSchema
}).strict();

export type SecretHandle = z.infer<typeof secretHandleSchema>;
export type CreateSecretRequest = z.infer<typeof createSecretRequestSchema>;
export type CreateSecretResponse = z.infer<typeof createSecretResponseSchema>;
```

- [ ] **Step 8: Implement configuration contract**

Create `packages/api-contract/src/configuration-record.ts`:

```ts
import { z } from 'zod';

import { secretHandleSchema } from './secret.js';

export const configurationRecordCollectionPath = '/v1/configuration-records' as const;
export const createConfigurationRecordSuccessStatusCode = 201 as const;
export const deleteConfigurationRecordSuccessStatusCode = 204 as const;

export const configurationRecordIdParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

export const configurationRecordKindSchema = z.literal('provider_profile');

export const configurationRecordSettingsSchema = z.object({
  profileName: z.string().min(1),
  credentialSecretHandle: secretHandleSchema.optional()
}).strict();

export const createConfigurationRecordRequestSchema = z.object({
  kind: configurationRecordKindSchema,
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  settings: configurationRecordSettingsSchema
}).strict();

export const updateConfigurationRecordSettingsSchema = z.object({
  profileName: z.string().min(1).optional(),
  credentialSecretHandle: secretHandleSchema.nullable().optional()
}).strict();

export const updateConfigurationRecordRequestSchema = z.object({
  providerKind: z.string().min(1).optional(),
  adapterId: z.string().min(1).optional(),
  settings: updateConfigurationRecordSettingsSchema.optional()
}).strict().refine(
  (value) => value.providerKind !== undefined || value.adapterId !== undefined || value.settings !== undefined,
  { message: 'At least one mutable field is required.' }
);

export const configurationRecordResponseSchema = z.object({
  id: z.string().min(1),
  kind: configurationRecordKindSchema,
  providerKind: z.string().min(1),
  adapterId: z.string().min(1),
  settings: configurationRecordSettingsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const configurationRecordListResponseSchema = z.object({
  records: z.array(configurationRecordResponseSchema)
}).strict();

export type ConfigurationRecordIdParams = z.infer<typeof configurationRecordIdParamsSchema>;
export type ConfigurationRecordKind = z.infer<typeof configurationRecordKindSchema>;
export type ConfigurationRecordSettings = z.infer<typeof configurationRecordSettingsSchema>;
export type CreateConfigurationRecordRequest = z.infer<typeof createConfigurationRecordRequestSchema>;
export type UpdateConfigurationRecordRequest = z.infer<typeof updateConfigurationRecordRequestSchema>;
export type ConfigurationRecord = z.infer<typeof configurationRecordResponseSchema>;
export type ConfigurationRecordListResponse = z.infer<typeof configurationRecordListResponseSchema>;
```

- [ ] **Step 9: Implement error constants and exports**

Update `packages/api-contract/src/errors.ts`:

```ts
export const unauthorizedErrorCode = 'unauthorized' as const;
export const validationErrorCode = 'validation_error' as const;
export const notFoundErrorCode = 'not_found' as const;
export const secretStoreLockedErrorCode = 'secret_store_locked' as const;
```

Export new contract modules and constants from `packages/api-contract/src/index.ts`.

- [ ] **Step 10: Run api-contract tests and commit**

Run:

```bash
pnpm nx test api-contract -- --run packages/api-contract/src/principal.spec.ts packages/api-contract/src/secret.spec.ts packages/api-contract/src/configuration-record.spec.ts packages/api-contract/src/index.spec.ts
```

Expected: all targeted tests pass.

Commit:

```bash
git add packages/api-contract/src
git commit -m "feat(api-contract): add principal config and secret schemas"
```

### Task 3: OpenAPI Registration

**Files:**
- Modify: `packages/api-contract/src/openapi.ts`
- Modify: `packages/api-contract/src/openapi.spec.ts`

- [ ] **Step 1: Add failing OpenAPI tests**

Extend `packages/api-contract/src/openapi.spec.ts` with assertions for new paths:

```ts
it('documents protected principal, configuration, and secret routes', () => {
  const document = generateOpenApiDocument();
  expect(document.paths['/v1/principal']?.get).toBeDefined();
  expect(document.paths['/v1/configuration-records']?.post).toBeDefined();
  expect(document.paths['/v1/configuration-records']?.get).toBeDefined();
  expect(document.paths['/v1/configuration-records/{id}']?.get).toBeDefined();
  expect(document.paths['/v1/configuration-records/{id}']?.patch).toBeDefined();
  expect(document.paths['/v1/configuration-records/{id}']?.delete).toBeDefined();
  expect(document.paths['/v1/secrets']?.post).toBeDefined();
});

it('documents no-content delete and unauthorized responses for protected routes', () => {
  const document = generateOpenApiDocument();
  const deleteOperation = document.paths['/v1/configuration-records/{id}']?.delete as {
    responses?: Record<string, unknown>;
  };
  expect(deleteOperation.responses?.['204']).toMatchObject({ description: 'Deleted configuration record.' });

  const createOperation = document.paths['/v1/configuration-records']?.post as {
    responses?: Record<string, unknown>;
  };
  expect(createOperation.responses?.['401']).toBeDefined();
});
```

- [ ] **Step 2: Run OpenAPI tests and confirm failure**

Run:

```bash
pnpm nx test api-contract -- --run packages/api-contract/src/openapi.spec.ts
```

Expected: missing path failures.

- [ ] **Step 3: Register schemas and reusable responses**

In `openapi.ts`, import contract constants/schemas and register:

```ts
const PrincipalDiagnosticResponse = registry.register('PrincipalDiagnosticResponse', principalDiagnosticResponseSchema);
const CreateConfigurationRecordRequest = registry.register('CreateConfigurationRecordRequest', createConfigurationRecordRequestSchema);
const UpdateConfigurationRecordRequest = registry.register('UpdateConfigurationRecordRequest', updateConfigurationRecordRequestSchema);
const ConfigurationRecord = registry.register('ConfigurationRecord', configurationRecordResponseSchema);
const ConfigurationRecordListResponse = registry.register('ConfigurationRecordListResponse', configurationRecordListResponseSchema);
const ConfigurationRecordIdParams = registry.register('ConfigurationRecordIdParams', configurationRecordIdParamsSchema);
const CreateSecretRequest = registry.register('CreateSecretRequest', createSecretRequestSchema);
const CreateSecretResponse = registry.register('CreateSecretResponse', createSecretResponseSchema);
```

Add a helper:

```ts
function standardProtectedErrorResponses(ErrorResponse: z.ZodTypeAny) {
  return {
    401: jsonResponse(ErrorResponse, 'Unauthorized.'),
    400: jsonResponse(ErrorResponse, 'Validation error.')
  };
}
```

- [ ] **Step 4: Register new paths from constants**

Register each new route using existing `registry.registerPath` style. For delete, use:

```ts
registry.registerPath({
  method: 'delete',
  path: `${configurationRecordCollectionPath}/{id}`,
  tags: ['configuration-records'],
  request: { params: ConfigurationRecordIdParams },
  responses: {
    204: { description: 'Deleted configuration record.' },
    401: jsonResponse(ErrorResponse, 'Unauthorized.'),
    404: jsonResponse(ErrorResponse, 'Configuration record not found.')
  }
});
```

For `POST /v1/secrets`, include `createSecretSuccessStatusCode`, `401`, `400`, and `secret_store_locked` as an error-envelope response description.

- [ ] **Step 5: Run OpenAPI tests and commit**

Run:

```bash
pnpm nx test api-contract -- --run packages/api-contract/src/openapi.spec.ts
```

Expected: OpenAPI tests pass.

Commit:

```bash
git add packages/api-contract/src/openapi.ts packages/api-contract/src/openapi.spec.ts
git commit -m "feat(api-contract): document config and secret routes"
```

### Task 4: Principal Request Context, Bearer Auth, and Policy Seam

**Files:**
- Create: `packages/core/src/principal.ts`
- Create: `packages/core/src/principal.spec.ts`
- Create: `packages/core/src/auth.ts`
- Create: `packages/core/src/auth.spec.ts`
- Create: `packages/core/src/policy.ts`
- Create: `packages/core/src/policy.spec.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/index.spec.ts`

- [ ] **Step 1: Write principal helper tests**

Create `packages/core/src/principal.spec.ts` using Fastify injection or minimal request objects:

```ts
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  attachPrincipalToRequest,
  getPrincipalFromRequest,
  hardcodedDevelopmentPrincipal,
  requirePrincipalFromRequest
} from './principal.js';

describe('principal request context', () => {
  const app = Fastify({ logger: false });

  afterEach(async () => {
    await app.close();
  });

  it('defines a synthetic hardcoded development principal', () => {
    expect(hardcodedDevelopmentPrincipal).toEqual({
      id: 'principal_dev_human',
      kind: 'human',
      tenantId: 'tenant_dev',
      displayName: 'Development Principal'
    });
  });

  it('attaches, gets, and requires a principal from a request', async () => {
    app.get('/probe', async (request) => {
      expect(getPrincipalFromRequest(request)).toBeUndefined();
      attachPrincipalToRequest(request, hardcodedDevelopmentPrincipal);
      return { principal: requirePrincipalFromRequest(request) };
    });

    const response = await app.inject({ method: 'GET', url: '/probe' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ principal: hardcodedDevelopmentPrincipal });
  });
});
```

Add a direct test that `requirePrincipalFromRequest({} as FastifyRequest)` throws `Principal is required for protected route.`.

- [ ] **Step 2: Write auth hook tests**

Create `packages/core/src/auth.spec.ts`. Assert missing, malformed, and wrong tokens return 401, valid token reaches handler, async resolver works, and handler is not called on failure:

```ts
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorResponseSchema } from '@autocatalyst/api-contract';

import { registerBearerAuthHook } from './auth.js';
import { getPrincipalFromRequest, hardcodedDevelopmentPrincipal } from './principal.js';

describe('registerBearerAuthHook', () => {
  let app = Fastify({ logger: false });

  afterEach(async () => {
    await app.close();
    app = Fastify({ logger: false });
  });

  it('rejects missing malformed and invalid bearer tokens before handlers run', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    await registerBearerAuthHook(app, { bearerToken: 'expected-token' });
    app.get('/v1/protected', handler);

    for (const authorization of [undefined, 'Basic abc', 'Bearer wrong-token']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/protected',
        headers: authorization === undefined ? {} : { authorization }
      });
      expect(response.statusCode).toBe(401);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('unauthorized');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('attaches the default or resolved principal for valid tokens', async () => {
    await registerBearerAuthHook(app, {
      bearerToken: 'expected-token',
      resolvePrincipal: async () => Object.assign({}, hardcodedDevelopmentPrincipal, { id: 'principal_async' })
    });
    app.get('/v1/protected', async (request) => ({ principal: getPrincipalFromRequest(request) }));

    const response = await app.inject({
      method: 'GET',
      url: '/v1/protected',
      headers: { authorization: 'Bearer expected-token' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().principal.id).toBe('principal_async');
  });
});
```

- [ ] **Step 3: Write policy tests**

Create `packages/core/src/policy.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { authorizeRequest, permissivePolicyDecisionPoint } from './policy.js';
import { hardcodedDevelopmentPrincipal } from './principal.js';

describe('policy decision point', () => {
  it('allows every request with the permissive implementation', async () => {
    await expect(
      permissivePolicyDecisionPoint.authorize({
        principal: hardcodedDevelopmentPrincipal,
        action: 'probe_resource.create',
        resource: { kind: 'probe_resource_collection', path: '/v1/probe-resources' }
      })
    ).resolves.toEqual({ allowed: true });
  });

  it('routes authorization through an injectable policy', async () => {
    const authorize = vi.fn(async () => ({ allowed: true as const }));
    await authorizeRequest(
      { authorize },
      {
        principal: hardcodedDevelopmentPrincipal,
        action: 'configuration_record.list',
        resource: { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
      }
    );
    expect(authorize).toHaveBeenCalledWith({
      principal: hardcodedDevelopmentPrincipal,
      action: 'configuration_record.list',
      resource: { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
    });
  });
});
```

- [ ] **Step 4: Run core seam tests and confirm failure**

Run:

```bash
pnpm nx test core -- --run packages/core/src/principal.spec.ts packages/core/src/auth.spec.ts packages/core/src/policy.spec.ts
```

Expected: missing module failures.

- [ ] **Step 5: Implement principal helpers**

Create `packages/core/src/principal.ts`:

```ts
import type { FastifyRequest } from 'fastify';

import type { Principal } from '@autocatalyst/api-contract';

const principalSymbol = Symbol('autocatalyst.principal');

type PrincipalRequest = FastifyRequest & { [principalSymbol]?: Principal };

export const hardcodedDevelopmentPrincipal: Principal = {
  id: 'principal_dev_human',
  kind: 'human',
  tenantId: 'tenant_dev',
  displayName: 'Development Principal'
};

export function attachPrincipalToRequest(request: FastifyRequest, principal: Principal): void {
  (request as PrincipalRequest)[principalSymbol] = principal;
}

export function getPrincipalFromRequest(request: FastifyRequest): Principal | undefined {
  return (request as PrincipalRequest)[principalSymbol];
}

export function requirePrincipalFromRequest(request: FastifyRequest): Principal {
  const principal = getPrincipalFromRequest(request);
  if (principal === undefined) {
    throw new Error('Principal is required for protected route.');
  }
  return principal;
}
```

- [ ] **Step 6: Implement auth hook**

Create `packages/core/src/auth.ts` with constant-time compare:

```ts
import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { errorResponseSchema, unauthorizedErrorCode, type Principal } from '@autocatalyst/api-contract';

import { attachPrincipalToRequest, hardcodedDevelopmentPrincipal } from './principal.js';

export interface BearerAuthOptions {
  readonly bearerToken: string;
  readonly resolvePrincipal?: () => Principal | Promise<Principal>;
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) {
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function unauthorizedResponse() {
  return errorResponseSchema.parse({
    error: { code: unauthorizedErrorCode, message: 'Unauthorized.' }
  });
}

export async function registerBearerAuthHook(app: FastifyInstance, options: BearerAuthOptions): Promise<void> {
  if (options.bearerToken.trim().length === 0) {
    throw new Error('Bearer token is required.');
  }

  app.addHook('preHandler', async (request, reply) => {
    const authorization = request.headers.authorization;
    const prefix = 'Bearer ';
    if (authorization === undefined || !authorization.startsWith(prefix)) {
      await reply.status(401).send(unauthorizedResponse());
      return;
    }

    const suppliedToken = authorization.slice(prefix.length);
    if (!tokensMatch(suppliedToken, options.bearerToken)) {
      await reply.status(401).send(unauthorizedResponse());
      return;
    }

    const principal = options.resolvePrincipal === undefined
      ? hardcodedDevelopmentPrincipal
      : await options.resolvePrincipal();
    attachPrincipalToRequest(request, principal);
  });
}
```

- [ ] **Step 7: Implement policy seam**

Create `packages/core/src/policy.ts`:

```ts
import type { Principal } from '@autocatalyst/api-contract';

export type PolicyResourceDescriptor =
  | { readonly kind: 'probe_resource_collection'; readonly path: '/v1/probe-resources' }
  | { readonly kind: 'probe_resource'; readonly id: string; readonly path: '/v1/probe-resources/:id' }
  | { readonly kind: 'event_stream'; readonly path: '/v1/events' }
  | { readonly kind: 'principal_diagnostic'; readonly path: '/v1/principal' }
  | { readonly kind: 'configuration_record_collection'; readonly path: '/v1/configuration-records' }
  | { readonly kind: 'configuration_record'; readonly id: string; readonly path: '/v1/configuration-records/:id' }
  | { readonly kind: 'secret_collection'; readonly path: '/v1/secrets' };

export type PolicyAction =
  | 'probe_resource.create'
  | 'probe_resource.read'
  | 'events.stream'
  | 'principal.diagnostic.read'
  | 'configuration_record.create'
  | 'configuration_record.list'
  | 'configuration_record.read'
  | 'configuration_record.update'
  | 'configuration_record.delete'
  | 'secret.create';

export interface PolicyDecisionInput {
  readonly principal: Principal;
  readonly action: PolicyAction;
  readonly resource: PolicyResourceDescriptor;
}

export interface PolicyDecision {
  readonly allowed: boolean;
}

export interface PolicyDecisionPoint {
  authorize(input: PolicyDecisionInput): Promise<PolicyDecision>;
}

export const permissivePolicyDecisionPoint: PolicyDecisionPoint = {
  async authorize() {
    return { allowed: true };
  }
};

export async function authorizeRequest(
  policy: PolicyDecisionPoint,
  input: PolicyDecisionInput
): Promise<PolicyDecision> {
  return policy.authorize(input);
}
```

- [ ] **Step 8: Export seams and commit**

Update `packages/core/src/index.ts` to export principal, auth, and policy modules. Run:

```bash
pnpm nx test core -- --run packages/core/src/principal.spec.ts packages/core/src/auth.spec.ts packages/core/src/policy.spec.ts packages/core/src/index.spec.ts
```

Expected: tests pass.

Commit:

```bash
git add packages/core/src
git commit -m "feat(core): add principal auth and policy seams"
```

### Task 5: Core Configuration and Secret Use-Case Interfaces

**Files:**
- Create: `packages/core/src/configuration-record.ts`
- Create: `packages/core/src/configuration-record.spec.ts`
- Create: `packages/core/src/secret.ts`
- Create: `packages/core/src/secret.spec.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write configuration use-case delegation tests**

Create `configuration-record.spec.ts` with a recording repository that asserts `createConfigurationRecord`, `listConfigurationRecords`, `getConfigurationRecord`, `updateConfigurationRecord`, and `deleteConfigurationRecord` delegate without importing persistence.

Use these expected calls:

```ts
await createConfigurationRecord(repository, {
  kind: 'provider_profile',
  providerKind: 'model_runner',
  adapterId: 'openai',
  settings: { profileName: 'default' }
});
await listConfigurationRecords(repository);
await getConfigurationRecord(repository, 'cfg_123');
await updateConfigurationRecord(repository, 'cfg_123', { settings: { credentialSecretHandle: null } });
await deleteConfigurationRecord(repository, 'cfg_123');
```

Assert missing reads resolve `null` and missing deletes resolve `false`.

- [ ] **Step 2: Write secret use-case tests**

Create `secret.spec.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createSecret, SecretStoreLockedError, type SecretStore } from './secret.js';

describe('secret use case', () => {
  it('delegates creation and returns only a handle', async () => {
    const store: SecretStore = { createSecret: vi.fn(async () => ({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' })) };
    await expect(createSecret(store, { value: 'sk-test' })).resolves.toEqual({
      handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'
    });
    expect(store.createSecret).toHaveBeenCalledWith({ value: 'sk-test' });
  });

  it('propagates locked-store errors without including secret values in the message', async () => {
    const error = new SecretStoreLockedError();
    const store: SecretStore = { createSecret: vi.fn(async () => { throw error; }) };
    await expect(createSecret(store, { value: 'sk-test' })).rejects.toBe(error);
    expect(error.message).not.toContain('sk-test');
  });
});
```

- [ ] **Step 3: Run tests and confirm failure**

Run:

```bash
pnpm nx test core -- --run packages/core/src/configuration-record.spec.ts packages/core/src/secret.spec.ts
```

Expected: missing module failures.

- [ ] **Step 4: Implement configuration use-case interfaces**

Create `packages/core/src/configuration-record.ts`:

```ts
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

export function createConfigurationRecord(repository: ConfigurationRecordRepository, input: CreateConfigurationRecordInput) {
  return repository.create(input);
}

export function listConfigurationRecords(repository: ConfigurationRecordRepository) {
  return repository.list();
}

export function getConfigurationRecord(repository: ConfigurationRecordRepository, id: string) {
  return repository.findById(id);
}

export function updateConfigurationRecord(
  repository: ConfigurationRecordRepository,
  id: string,
  input: UpdateConfigurationRecordInput
) {
  return repository.update(id, input);
}

export function deleteConfigurationRecord(repository: ConfigurationRecordRepository, id: string) {
  return repository.delete(id);
}
```

- [ ] **Step 5: Implement secret use-case interface**

Create `packages/core/src/secret.ts`:

```ts
import type { CreateSecretRequest, CreateSecretResponse } from '@autocatalyst/api-contract';

export type CreateSecretInput = CreateSecretRequest;

export class SecretStoreLockedError extends Error {
  constructor() {
    super('Secret store is locked.');
    this.name = 'SecretStoreLockedError';
  }
}

export interface SecretStore {
  createSecret(input: CreateSecretInput): Promise<CreateSecretResponse>;
}

export function createSecret(store: SecretStore, input: CreateSecretInput): Promise<CreateSecretResponse> {
  return store.createSecret(input);
}
```

- [ ] **Step 6: Export, test, and commit**

Update `packages/core/src/index.ts`. Run:

```bash
pnpm nx test core -- --run packages/core/src/configuration-record.spec.ts packages/core/src/secret.spec.ts packages/core/src/index.spec.ts
```

Expected: tests pass.

Commit:

```bash
git add packages/core/src
git commit -m "feat(core): add config and secret use cases"
```

### Task 6: Persistence Schema and Migration

**Files:**
- Modify: `packages/persistence/src/schema.ts`
- Add: `packages/persistence/drizzle/0001_create_configuration_and_secrets.sql`
- Modify: `packages/persistence/drizzle/meta/_journal.json`
- Modify: `packages/persistence/src/index.spec.ts` or add migration coverage to repository specs

- [ ] **Step 1: Write failing migration smoke test**

Add to `packages/persistence/src/index.spec.ts` or `probe-resource-repository.spec.ts`:

```ts
it('migrates configuration and secret-store tables in an isolated database', async () => {
  await withTempDatabasePath(async (databasePath) => {
    const database = createSqliteDatabase({ path: databasePath });
    await migrateSqliteDatabase(database);
    const internal = asInternalSqliteDatabase(database);

    const tables = internal.client
      .prepare("select name from sqlite_master where type = 'table' and name in (?, ?, ?)")
      .all('configuration_records', 'secret_store_metadata', 'secrets')
      .map((row) => (row as { name: string }).name)
      .sort();

    expect(tables).toEqual(['configuration_records', 'secret_store_metadata', 'secrets']);
    database.close();
  });
});
```

If `asInternalSqliteDatabase` is not exported, import it directly from `./sqlite.js` inside the persistence test rather than changing package public exports for a test-only helper.

- [ ] **Step 2: Run migration smoke test and confirm failure**

Run:

```bash
pnpm nx test persistence -- --run packages/persistence/src/index.spec.ts packages/persistence/src/probe-resource-repository.spec.ts
```

Expected: table missing failure.

- [ ] **Step 3: Extend Drizzle schema**

Add tables to `packages/persistence/src/schema.ts`:

```ts
export const configurationRecords = sqliteTable('configuration_records', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  providerKind: text('provider_kind').notNull(),
  adapterId: text('adapter_id').notNull(),
  settingsJson: text('settings_json').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const secretStoreMetadata = sqliteTable('secret_store_metadata', {
  id: text('id').primaryKey(),
  encryptionVersion: text('encryption_version').notNull(),
  kdfName: text('kdf_name').notNull(),
  kdfParamsJson: text('kdf_params_json').notNull(),
  kdfSalt: text('kdf_salt').notNull(),
  sentinelNonce: text('sentinel_nonce').notNull(),
  sentinelCiphertext: text('sentinel_ciphertext').notNull(),
  sentinelAuthTag: text('sentinel_auth_tag').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
});

export const secrets = sqliteTable('secrets', {
  handle: text('handle').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  nonce: text('nonce').notNull(),
  authTag: text('auth_tag').notNull(),
  encryptionVersion: text('encryption_version').notNull(),
  createdAt: text('created_at').notNull()
});
```

- [ ] **Step 4: Add committed migration**

Create `packages/persistence/drizzle/0001_create_configuration_and_secrets.sql`:

```sql
CREATE TABLE `configuration_records` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `provider_kind` text NOT NULL,
  `adapter_id` text NOT NULL,
  `settings_json` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secret_store_metadata` (
  `id` text PRIMARY KEY NOT NULL,
  `encryption_version` text NOT NULL,
  `kdf_name` text NOT NULL,
  `kdf_params_json` text NOT NULL,
  `kdf_salt` text NOT NULL,
  `sentinel_nonce` text NOT NULL,
  `sentinel_ciphertext` text NOT NULL,
  `sentinel_auth_tag` text NOT NULL,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `secrets` (
  `handle` text PRIMARY KEY NOT NULL,
  `ciphertext` text NOT NULL,
  `nonce` text NOT NULL,
  `auth_tag` text NOT NULL,
  `encryption_version` text NOT NULL,
  `created_at` text NOT NULL
);
```

Append a journal entry with `idx: 1`, tag `0001_create_configuration_and_secrets`, version `6`, and a stable `when` timestamp later than the first entry.

- [ ] **Step 5: Run migration tests and commit**

Run:

```bash
pnpm nx test persistence -- --run packages/persistence/src/index.spec.ts packages/persistence/src/probe-resource-repository.spec.ts
```

Expected: migration smoke test and existing probe-resource tests pass.

Commit:

```bash
git add packages/persistence/src/schema.ts packages/persistence/drizzle packages/persistence/src/index.spec.ts packages/persistence/src/probe-resource-repository.spec.ts
git commit -m "feat(persistence): add config and secret tables"
```

### Task 7: Drizzle Configuration Repository

**Files:**
- Create: `packages/persistence/src/configuration-record-repository.ts`
- Create: `packages/persistence/src/configuration-record-repository.spec.ts`
- Modify: `packages/persistence/src/index.ts`

- [ ] **Step 1: Write repository CRUD tests**

Create tests that open/migrate an isolated temp database and assert:

```ts
const repository = new DrizzleConfigurationRecordRepository(database);
const created = await repository.create({
  kind: 'provider_profile',
  providerKind: 'model_runner',
  adapterId: 'openai',
  settings: { profileName: 'default', credentialSecretHandle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' }
});
expect(created.id).toMatch(/^cfg_/u);
expect(created.settings).not.toHaveProperty('secretValue');
await expect(repository.findById(created.id)).resolves.toEqual(created);
await expect(repository.list()).resolves.toEqual([created]);
const updated = await repository.update(created.id, { settings: { profileName: 'renamed', credentialSecretHandle: null } });
expect(updated?.settings).toEqual({ profileName: 'renamed' });
expect(updated?.createdAt).toBe(created.createdAt);
expect(updated?.updatedAt).not.toBe(created.updatedAt);
await expect(repository.delete(created.id)).resolves.toBe(true);
await expect(repository.findById(created.id)).resolves.toBeNull();
await expect(repository.delete(created.id)).resolves.toBe(false);
```

- [ ] **Step 2: Run repository tests and confirm failure**

Run:

```bash
pnpm nx test persistence -- --run packages/persistence/src/configuration-record-repository.spec.ts
```

Expected: missing module failure.

- [ ] **Step 3: Implement repository mapping**

Create `configuration-record-repository.ts`. Use `randomUUID` for ids, `eq` from Drizzle, and schema rows. Include helpers:

```ts
function serializeSettings(settings: ConfigurationRecordSettings): string {
  return JSON.stringify(settings);
}

function parseSettings(settingsJson: string): ConfigurationRecordSettings {
  return configurationRecordSettingsSchema.parse(JSON.parse(settingsJson));
}

function rowToRecord(row: typeof configurationRecords.$inferSelect): ConfigurationRecord {
  return configurationRecordResponseSchema.parse({
    id: row.id,
    kind: row.kind,
    providerKind: row.providerKind,
    adapterId: row.adapterId,
    settings: parseSettings(row.settingsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  });
}
```

Implement `update` by reading the current record first, applying PATCH semantics in memory, updating `updatedAt` only for found records, and returning `null` for missing ids. When `credentialSecretHandle` is `null`, remove the property from settings before serialization.

- [ ] **Step 4: Export, test, and commit**

Run:

```bash
pnpm nx test persistence -- --run packages/persistence/src/configuration-record-repository.spec.ts packages/persistence/src/index.spec.ts
```

Expected: repository tests pass.

Commit:

```bash
git add packages/persistence/src/configuration-record-repository.ts packages/persistence/src/configuration-record-repository.spec.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): store configuration records"
```

### Task 8: SQLite-Backed Encrypted Secret Store

**Files:**
- Create: `packages/persistence/src/secret-store.ts`
- Create: `packages/persistence/src/secret-store.spec.ts`
- Modify: `packages/persistence/src/index.ts`

- [ ] **Step 1: Write secret-store tests before implementation**

Create tests for unlock and create behavior:

```ts
const store = new SqliteSecretStore(database);
await expect(store.createSecret({ value: 'sk-before-unlock' })).rejects.toThrow(SecretStoreLockedError);
await store.unlock('correct horse battery staple');
await store.unlock('correct horse battery staple');
const created = await store.createSecret({ value: 'sk-live-secret' });
expect(created.handle).toMatch(/^sec_[A-Za-z0-9_-]{32}$/u);
```

Add table assertions:

```ts
const internal = asInternalSqliteDatabase(database);
const row = internal.client.prepare('select ciphertext, nonce, auth_tag from secrets where handle = ?').get(created.handle) as {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
};
expect(row.ciphertext).not.toContain('sk-live-secret');
expect(JSON.stringify(row)).not.toContain('sk-live-secret');
```

Add wrong-master behavior:

```ts
const first = new SqliteSecretStore(firstDatabase);
await first.unlock('right-secret');
await first.createSecret({ value: 'sk-value' });
firstDatabase.close();

const second = new SqliteSecretStore(secondDatabase);
await expect(second.unlock('wrong-secret')).rejects.toThrow(SecretStoreUnlockError);
await expect(second.createSecret({ value: 'sk-after-fail' })).rejects.toThrow(SecretStoreLockedError);
```

Add a collision test by allowing constructor injection of a test-only random byte provider:

```ts
const firstBytes = Buffer.alloc(24, 1);
const secondBytes = Buffer.alloc(24, 2);
const store = new SqliteSecretStore(database, { randomBytes: vi.fn().mockReturnValueOnce(firstBytes).mockReturnValueOnce(firstBytes).mockReturnValueOnce(secondBytes) });
```

Assert two creates return different handles.

- [ ] **Step 2: Run secret-store tests and confirm failure**

Run:

```bash
pnpm nx test persistence -- --run packages/persistence/src/secret-store.spec.ts
```

Expected: missing module failure.

- [ ] **Step 3: Implement crypto helpers**

Create `secret-store.ts` with:

```ts
const encryptionVersion = 'v1';
const metadataId = 'default';
const kdfName = 'scrypt';
const kdfParams = { cost: 16384, blockSize: 8, parallelization: 1, keyLength: 32 } as const;
const sentinelPlaintext = 'autocatalyst-secret-store-v1';
```

Use promisified `scrypt`, `createCipheriv('aes-256-gcm', key, nonce)`, and `createDecipheriv`. Store ciphertext/nonce/auth tag as base64 strings. Generate secret handles from `randomBytes(24).toString('base64url')`, prefixed with `sec_`.

- [ ] **Step 4: Implement unlock semantics**

Implement `unlock(masterSecret: string)`:

1. Reject empty master secret with `SecretStoreUnlockError`.
2. If already unlocked, return without rewriting metadata.
3. Read singleton metadata.
4. If missing, generate salt and sentinel nonce, derive key, encrypt sentinel, insert metadata.
5. If present, derive key from stored params and salt, decrypt/authenticate sentinel.
6. On decrypt failure, set no key and throw `SecretStoreUnlockError`.

- [ ] **Step 5: Implement createSecret semantics**

Implement `createSecret`:

1. Throw core `SecretStoreLockedError` if no unlocked key.
2. Loop up to 5 attempts to create a fresh handle.
3. Encrypt submitted value with a fresh 12-byte nonce.
4. Insert row into `secrets`.
5. On primary-key collision, retry with fresh random bytes.
6. If attempts exhaust, throw `new Error('Unable to allocate secret handle.')` without including the secret value.

- [ ] **Step 6: Run secret-store tests and commit**

Run:

```bash
pnpm nx test persistence -- --run packages/persistence/src/secret-store.spec.ts
```

Expected: tests pass and no assertion contains plaintext in stored payloads.

Commit:

```bash
git add packages/persistence/src/secret-store.ts packages/persistence/src/secret-store.spec.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): encrypt stored secrets"
```

### Task 9: Server Options and Dependency Composition

**Files:**
- Modify: `apps/control-plane/src/server.ts`
- Modify: `apps/control-plane/src/server.spec.ts`
- Modify: `apps/control-plane/src/integration.spec.ts` for health seam migration

- [ ] **Step 1: Write server composition tests**

Add tests that call `createControlPlaneServer` with object options:

```ts
await expect(
  createControlPlaneServer({ databasePath: '', bearerToken: 'token', masterSecret: 'secret' })
).rejects.toThrow('SQLite database path is required.');
await expect(
  createControlPlaneServer({ databasePath, bearerToken: '', masterSecret: 'secret' })
).rejects.toThrow('Bearer token is required.');
await expect(
  createControlPlaneServer({ databasePath, bearerToken: 'token', masterSecret: '' })
).rejects.toThrow('Master secret is required.');
```

Add a health seam test:

```ts
const app = await createControlPlaneServer({
  databasePath,
  bearerToken: 'token',
  masterSecret: 'secret',
  health: { isDatabaseReachable: async () => false }
});
const response = await app.inject({ method: 'GET', url: '/health' });
expect(response.statusCode).toBe(degradedHealthStatusCode);
await app.close();
```

- [ ] **Step 2: Run server tests and confirm failure**

Run:

```bash
pnpm nx test control-plane -- --run apps/control-plane/src/server.spec.ts apps/control-plane/src/integration.spec.ts
```

Expected: type/signature failures because server still accepts `SqliteDatabase`.

- [ ] **Step 3: Implement options type and validation**

In `server.ts` add:

```ts
export interface ControlPlaneServerOptions {
  readonly databasePath: string;
  readonly bearerToken: string;
  readonly masterSecret: string;
  readonly policy?: PolicyDecisionPoint;
  readonly health?: HealthDependencyChecker;
}
```

Validate `bearerToken` and `masterSecret` before route registration. Let `createSqliteDatabase` validate the path or add a path guard with the same existing message.

- [ ] **Step 4: Compose persistence and core dependencies**

Inside `createControlPlaneServer(options)`:

```ts
const database = createSqliteDatabase({ path: options.databasePath });
await migrateSqliteDatabase(database);
const secretStore = new SqliteSecretStore(database);
await secretStore.unlock(options.masterSecret);
const app = Fastify({ logger: false });
await registerControlPlaneRoutes(app, {
  health: options.health ?? { isDatabaseReachable: async () => checkSqliteDatabaseReachability(database) },
  auth: { bearerToken: options.bearerToken },
  policy: options.policy ?? permissivePolicyDecisionPoint,
  probeResources: new DrizzleProbeResourceRepository(database),
  configurationRecords: new DrizzleConfigurationRecordRepository(database),
  secrets: secretStore
});
app.addHook('onClose', async () => {
  database.close();
});
return app;
```

If route dependencies are not yet updated, keep TypeScript compile green by implementing Task 10 immediately after this task; do not commit a broken intermediate state.

- [ ] **Step 5: Preserve start lifecycle**

Update `startControlPlaneServer(config)` to call `createControlPlaneServer(config)` and keep returning `{ port, databasePath, close }`. Do not call `listen()` inside `createControlPlaneServer`.

- [ ] **Step 6: Run server tests and commit with route dependency task if necessary**

Run:

```bash
pnpm nx test control-plane -- --run apps/control-plane/src/server.spec.ts
```

Expected: options validation and health seam tests pass after routes compile.

Commit:

```bash
git add apps/control-plane/src/server.ts apps/control-plane/src/server.spec.ts apps/control-plane/src/integration.spec.ts
git commit -m "feat(control-plane): compose server from bootstrap options"
```

### Task 10: Protected Route Scope and Existing Probe/SSE Migration

**Files:**
- Modify: `packages/core/src/routes.ts`
- Modify: `packages/core/src/routes.spec.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Update route test dependency builder**

Extend the `buildServer` helper in `routes.spec.ts` with:

```ts
const bearerToken = 'test-token';
const authorization = { authorization: `Bearer ${bearerToken}` };
const policyCalls: PolicyDecisionInput[] = [];
const dependencies: ControlPlaneRouteDependencies = Object.assign({
  health: { isDatabaseReachable: async () => true },
  auth: { bearerToken },
  policy: { authorize: async (input) => { policyCalls.push(input); return { allowed: true }; } },
  probeResources: existingProbeRepository,
  configurationRecords: inMemoryConfigurationRepository,
  secrets: inMemorySecretStore
}, overrides);
```

Return `{ app, authorization, policyCalls }` instead of only app, or keep module-level helper state.

- [ ] **Step 2: Write negative auth tests for `/v1`**

Add route tests:

```ts
it('rejects protected v1 requests without a valid bearer token before handlers run', async () => {
  const create = vi.fn(async () => { throw new Error('handler should not run'); });
  const built = await buildServer({ probeResources: { create, findById: async () => null } });
  server = built.app;

  const missing = await server.inject({ method: 'POST', url: probeResourceCollectionPath, payload: { value: 'x' } });
  expect(missing.statusCode).toBe(401);
  expect(errorResponseSchema.parse(missing.json()).error.code).toBe('unauthorized');

  const invalid = await server.inject({
    method: 'POST',
    url: probeResourceCollectionPath,
    headers: { authorization: 'Bearer wrong' },
    payload: { value: 'x' }
  });
  expect(invalid.statusCode).toBe(401);
  expect(create).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Migrate existing probe and SSE tests to send auth**

Add `headers: built.authorization` to `POST /v1/probe-resources`, `GET /v1/probe-resources/:id`, and the real SSE fetch in `routes.spec.ts`. Keep `/health` without auth.

- [ ] **Step 4: Add policy consultation assertions for probe and events routes**

Assert exact values from the spec:

```ts
expect(policyCalls).toContainEqual({
  principal: hardcodedDevelopmentPrincipal,
  action: 'probe_resource.create',
  resource: { kind: 'probe_resource_collection', path: '/v1/probe-resources' }
});
expect(policyCalls).toContainEqual({
  principal: hardcodedDevelopmentPrincipal,
  action: 'probe_resource.read',
  resource: { kind: 'probe_resource', id: createdBody.id, path: '/v1/probe-resources/:id' }
});
```

For `/v1/events`, expect `events.stream` and `{ kind: 'event_stream', path: '/v1/events' }`.

- [ ] **Step 5: Refactor route registration to public health plus protected plugin**

In `routes.ts`, keep the existing public `app.get('/health', async (_request, reply) => { const health = healthResponseSchema.parse(await getHealth(dependencies.health)); const statusCode = health.status === 'ok' ? 200 : degradedHealthStatusCode; await reply.status(statusCode).send(health); })` registration before protected registration. Then register protected routes inside a child plugin; move the current probe-resource handler bodies into named functions so the route registration contains no omitted handler logic:

```ts
async function handleCreateProbeResource(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let body: CreateProbeResourceRequest;
  try {
    body = parseBody(request);
  } catch (error) {
    await sendValidationError(reply, error);
    return;
  }

  const resource = probeResourceSchema.parse(
    await createProbeResource(dependencies.probeResources, body)
  );
  await reply.status(createProbeResourceSuccessStatusCode).send(resource);
}

async function handleReadProbeResource(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let params: ProbeResourceIdParams;
  try {
    params = parseParams(request);
  } catch (error) {
    await sendValidationError(reply, error);
    return;
  }

  const resource = await getProbeResource(dependencies.probeResources, params.id);
  if (resource === null) {
    await reply.status(404).send(errorResponse(notFoundErrorCode, 'Probe resource not found.'));
    return;
  }

  await reply.status(200).send(probeResourceSchema.parse(resource));
}

await app.register(async (protectedApp) => {
  await registerBearerAuthHook(protectedApp, dependencies.auth);

  protectedApp.post(probeResourceCollectionPath, {
    preHandler: authorizePreHandler(dependencies.policy, 'probe_resource.create', () => ({
      kind: 'probe_resource_collection',
      path: '/v1/probe-resources'
    }))
  }, handleCreateProbeResource);

  protectedApp.get(`${probeResourceCollectionPath}/:id`, {
    preHandler: authorizePreHandler(dependencies.policy, 'probe_resource.read', (request) => ({
      kind: 'probe_resource',
      id: parseParams(request).id,
      path: '/v1/probe-resources/:id'
    }))
  }, handleReadProbeResource);
});
```

Define `authorizePreHandler` in `routes.ts` or `policy.ts`; it must call `requirePrincipalFromRequest(request)` and `authorizeRequest`. Since policy allows for now, no deny response is required yet; if `allowed` is false defensively, return `403` with `error.code` `forbidden`.

- [ ] **Step 6: Run route tests and commit**

Run:

```bash
pnpm nx test core -- --run packages/core/src/routes.spec.ts
```

Expected: `/health` public coverage passes, protected `/v1` auth failures pass, probe/SSE tests pass with valid auth, and policy calls are recorded.

Commit:

```bash
git add packages/core/src/routes.ts packages/core/src/routes.spec.ts packages/core/src/index.ts
git commit -m "feat(core): protect v1 routes with auth and policy"
```

### Task 11: Principal Diagnostic Route

**Files:**
- Modify: `packages/core/src/routes.ts`
- Modify: `packages/core/src/routes.spec.ts`

- [ ] **Step 1: Write diagnostic route test**

Add a test:

```ts
it('exposes the protected hardcoded principal diagnostic route', async () => {
  const built = await buildServer();
  server = built.app;

  const response = await server.inject({ method: 'GET', url: principalDiagnosticPath, headers: built.authorization });
  expect(response.statusCode).toBe(200);
  expect(principalDiagnosticResponseSchema.parse(response.json())).toEqual({
    principal: hardcodedDevelopmentPrincipal
  });
  expect(built.policyCalls).toContainEqual({
    principal: hardcodedDevelopmentPrincipal,
    action: 'principal.diagnostic.read',
    resource: { kind: 'principal_diagnostic', path: '/v1/principal' }
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
pnpm nx test core -- --run packages/core/src/routes.spec.ts
```

Expected: 404 for `/v1/principal`.

- [ ] **Step 3: Implement diagnostic route**

Inside the protected plugin:

```ts
protectedApp.get(principalDiagnosticPath, {
  preHandler: authorizePreHandler(dependencies.policy, 'principal.diagnostic.read', () => ({
    kind: 'principal_diagnostic',
    path: '/v1/principal'
  }))
}, async (request, reply) => {
  await reply.status(200).send(principalDiagnosticResponseSchema.parse({
    principal: requirePrincipalFromRequest(request)
  }));
});
```

- [ ] **Step 4: Run route tests and commit**

Run:

```bash
pnpm nx test core -- --run packages/core/src/routes.spec.ts
```

Expected: route tests pass.

Commit:

```bash
git add packages/core/src/routes.ts packages/core/src/routes.spec.ts
git commit -m "feat(core): expose protected principal diagnostic route"
```

### Task 12: Configuration Record Routes

**Files:**
- Modify: `packages/core/src/routes.ts`
- Modify: `packages/core/src/routes.spec.ts`

- [ ] **Step 1: Add in-memory config repository to route tests**

Implement a test helper repository in `routes.spec.ts` that stores `ConfigurationRecord` objects in a `Map`, supports PATCH semantics, and returns `null`/`false` for missing ids. Use fixed timestamps for predictable responses.

- [ ] **Step 2: Write route tests for create/read/list/update/delete**

Add tests that call:

```ts
POST /v1/configuration-records
GET /v1/configuration-records
GET /v1/configuration-records/:id
PATCH /v1/configuration-records/:id
DELETE /v1/configuration-records/:id
```

Each request includes `headers: built.authorization`. Assert schemas parse responses. Assert delete returns status `204` and `response.body === ''`.

- [ ] **Step 3: Write validation and not-found tests**

Add tests for:

```ts
POST /v1/configuration-records with settings.profileName: '' -> 400 validation_error
PATCH /v1/configuration-records/:id with {} -> 400 validation_error
GET /v1/configuration-records/missing -> 404 not_found
PATCH /v1/configuration-records/missing -> 404 not_found
DELETE /v1/configuration-records/missing -> 404 not_found
```

Assert repository mutation counts do not change for failed validation.

- [ ] **Step 4: Add policy assertions for config routes**

Assert exact actions/resources:

```ts
configuration_record.create -> { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
configuration_record.list -> { kind: 'configuration_record_collection', path: '/v1/configuration-records' }
configuration_record.read -> { kind: 'configuration_record', id, path: '/v1/configuration-records/:id' }
configuration_record.update -> { kind: 'configuration_record', id, path: '/v1/configuration-records/:id' }
configuration_record.delete -> { kind: 'configuration_record', id, path: '/v1/configuration-records/:id' }
```

- [ ] **Step 5: Run route tests and confirm failure**

Run:

```bash
pnpm nx test core -- --run packages/core/src/routes.spec.ts
```

Expected: 404 for configuration routes.

- [ ] **Step 6: Implement route handlers**

In `routes.ts`, add parsers for config params/body/update. Use `sendValidationError` for Zod failures, `errorResponse(notFoundErrorCode, 'Configuration record not found.')` for missing records, and response schema parsing before send.

For create:

```ts
const record = configurationRecordResponseSchema.parse(
  await createConfigurationRecord(dependencies.configurationRecords, body)
);
await reply.status(createConfigurationRecordSuccessStatusCode).send(record);
```

For list:

```ts
await reply.status(200).send(configurationRecordListResponseSchema.parse({
  records: await listConfigurationRecords(dependencies.configurationRecords)
}));
```

For delete:

```ts
const deleted = await deleteConfigurationRecord(dependencies.configurationRecords, params.id);
if (!deleted) { await reply.status(404).send(errorResponse(notFoundErrorCode, 'Configuration record not found.')); return; }
await reply.status(deleteConfigurationRecordSuccessStatusCode).send();
```

- [ ] **Step 7: Run route tests and commit**

Run:

```bash
pnpm nx test core -- --run packages/core/src/routes.spec.ts
```

Expected: all route tests pass.

Commit:

```bash
git add packages/core/src/routes.ts packages/core/src/routes.spec.ts
git commit -m "feat(core): add configuration record routes"
```

### Task 13: Minimal Create-Secret Route

**Files:**
- Modify: `packages/core/src/routes.ts`
- Modify: `packages/core/src/routes.spec.ts`

- [ ] **Step 1: Write secret route tests**

Add tests for authenticated `POST /v1/secrets`:

```ts
const response = await server.inject({
  method: 'POST',
  url: secretCollectionPath,
  headers: built.authorization,
  payload: { value: 'sk-test-secret' }
});
expect(response.statusCode).toBe(createSecretSuccessStatusCode);
expect(createSecretResponseSchema.parse(response.json())).toEqual({ handle: 'sec_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef' });
expect(response.body).not.toContain('sk-test-secret');
expect(built.policyCalls).toContainEqual({
  principal: hardcodedDevelopmentPrincipal,
  action: 'secret.create',
  resource: { kind: 'secret_collection', path: '/v1/secrets' }
});
```

Add tests for empty value `400 validation_error`, missing auth `401`, and `SecretStoreLockedError` mapping to `400` with `secret_store_locked` that does not echo the value.

- [ ] **Step 2: Run route tests and confirm failure**

Run:

```bash
pnpm nx test core -- --run packages/core/src/routes.spec.ts
```

Expected: 404 for `/v1/secrets`.

- [ ] **Step 3: Implement secret route**

Add protected route:

```ts
protectedApp.post(secretCollectionPath, {
  preHandler: authorizePreHandler(dependencies.policy, 'secret.create', () => ({
    kind: 'secret_collection',
    path: '/v1/secrets'
  }))
}, async (request, reply) => {
  let body: CreateSecretRequest;
  try {
    body = createSecretRequestSchema.parse(request.body);
  } catch (error) {
    await sendValidationError(reply, error);
    return;
  }

  try {
    const response = createSecretResponseSchema.parse(await createSecret(dependencies.secrets, body));
    await reply.status(createSecretSuccessStatusCode).send(response);
  } catch (error) {
    if (error instanceof SecretStoreLockedError) {
      await reply.status(400).send(errorResponse(secretStoreLockedErrorCode, 'Secret store is locked.'));
      return;
    }
    throw error;
  }
});
```

- [ ] **Step 4: Run route tests and commit**

Run:

```bash
pnpm nx test core -- --run packages/core/src/routes.spec.ts
```

Expected: all core route tests pass.

Commit:

```bash
git add packages/core/src/routes.ts packages/core/src/routes.spec.ts
git commit -m "feat(core): add secret handle creation route"
```

### Task 14: App Integration Tests for Principal, Policy, Configuration, Secrets, and Health

**Files:**
- Modify: `apps/control-plane/src/integration.spec.ts`

- [ ] **Step 1: Add a shared authenticated fetch helper**

Inside integration tests, define:

```ts
const bearerToken = 'integration-token';
const masterSecret = 'integration-master-secret';
const authHeaders = { authorization: `Bearer ${bearerToken}` };
function jsonHeaders() {
  return Object.assign({}, authHeaders, { 'content-type': 'application/json' });
}
```

- [ ] **Step 2: Migrate existing restart/probe test to new startup config**

Pass `{ port: 0, databasePath, bearerToken, masterSecret }` to `startControlPlaneServer`. Add `authorization` to `/v1/probe-resources` create/read/restart reads. Keep `/health` unauthenticated.

- [ ] **Step 3: Migrate SSE integration test to auth**

Pass bootstrap values and call `/v1/events` with `headers: authHeaders`.

- [ ] **Step 4: Replace caller-owned database degraded-health regression**

Use:

```ts
const app = await createControlPlaneServer({
  databasePath,
  bearerToken,
  masterSecret,
  health: { isDatabaseReachable: async () => false }
});
const response = await app.inject({ method: 'GET', url: '/health' });
expect(response.statusCode).toBe(degradedHealthStatusCode);
await app.close();
```

- [ ] **Step 5: Add principal and policy integration test**

Create a recording policy array, inject into `createControlPlaneServer`, call `GET /v1/principal` with auth, assert principal equals hardcoded response and policy received `principal.diagnostic.read` with `{ kind: 'principal_diagnostic', path: '/v1/principal' }`. Also call the same route missing auth and invalid auth and assert `401 unauthorized`.

- [ ] **Step 6: Add config CRUD integration test**

Boot real app, call create/read/list/update/delete over HTTP, parse all JSON through contract schemas, assert invalid create returns `400 validation_error`, and assert read-after-delete returns `404 not_found`.

- [ ] **Step 7: Add secret-handle separation integration test**

Boot real app, `POST /v1/secrets` with `{ value: 'sk-integration-secret' }`, create config record with `credentialSecretHandle`, read config, assert response includes handle and `JSON.stringify(responseBody)` excludes `sk-integration-secret`. Open the SQLite database after app close, query `configuration_records.settings_json` and `secrets.ciphertext`, and assert neither contains plaintext.

- [ ] **Step 8: Run integration tests and commit**

Run:

```bash
pnpm nx test control-plane -- --run apps/control-plane/src/integration.spec.ts
```

Expected: real app integration tests pass.

Commit:

```bash
git add apps/control-plane/src/integration.spec.ts apps/control-plane/src/server.ts apps/control-plane/src/server.spec.ts
git commit -m "test(control-plane): cover auth config and secrets end to end"
```

### Task 15: SDK Auth and Configuration/Secret Methods

**Files:**
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/src/client.spec.ts`
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/src/index.spec.ts`

- [ ] **Step 1: Write SDK auth header tests**

Update client tests so `createControlPlaneClient({ baseUrl, fetch, bearerToken: 'sdk-token' })` sends:

```ts
headers: expect.objectContaining({ authorization: 'Bearer sdk-token' })
```

for `createProbeResource`, `getProbeResource`, config CRUD, and `createSecret`. Assert `getHealth` still sends no required token and still works without `bearerToken`.

- [ ] **Step 2: Write SDK config method tests**

Add tests for methods:

```ts
client.createConfigurationRecord(request)
client.listConfigurationRecords()
client.getConfigurationRecord(id)
client.updateConfigurationRecord(id, patch)
client.deleteConfigurationRecord(id)
```

Mock `fetch` with contract-shaped responses. Assert `deleteConfigurationRecord` resolves `undefined` for status `204`.

- [ ] **Step 3: Write SDK create-secret tests**

Mock `fetch` for `POST /v1/secrets`, assert method returns `{ handle }`, includes auth header, and maps shared error envelopes to `ControlPlaneClientError` without including token or secret value in the error message.

- [ ] **Step 4: Run SDK tests and confirm failure**

Run:

```bash
pnpm nx test sdk -- --run packages/sdk/src/client.spec.ts packages/sdk/src/index.spec.ts
```

Expected: missing option/method failures.

- [ ] **Step 5: Implement auth header helper**

In `client.ts` add `readonly bearerToken?: string` to options. Add:

```ts
function protectedHeaders(options: { bearerToken?: string }, extra?: HeadersInit): HeadersInit {
  return options.bearerToken === undefined
    ? Object.assign({}, extra)
    : Object.assign({}, extra, { authorization: `Bearer ${options.bearerToken}` });
}
```

Use it for all protected calls; do not use it for `getHealth`.

- [ ] **Step 6: Implement config and secret methods**

Extend `ControlPlaneClient` with the six new methods. Parse request bodies with create/update schemas and responses with response/list/secret schemas. For delete, after `throwForError(response)`, require `response.status === deleteConfigurationRecordSuccessStatusCode` and return `undefined` without parsing JSON.

- [ ] **Step 7: Migrate SDK test server to protected routes**

When `registerControlPlaneRoutes` is used in SDK tests, pass `auth`, `policy`, in-memory config repository, and in-memory secret store dependencies. Instantiate SDK with `bearerToken` for protected method calls. Keep `getHealth` tests unauthenticated.

- [ ] **Step 8: Run SDK tests and commit**

Run:

```bash
pnpm nx test sdk -- --run packages/sdk/src/client.spec.ts packages/sdk/src/index.spec.ts
```

Expected: SDK tests pass.

Commit:

```bash
git add packages/sdk/src/client.ts packages/sdk/src/client.spec.ts packages/sdk/src/index.ts packages/sdk/src/index.spec.ts
git commit -m "feat(sdk): add auth config and secret client methods"
```

### Task 16: Migrate Remaining K3 Regression Tests and Main Tests

**Files:**
- Modify: `apps/control-plane/src/main.spec.ts`
- Modify: any remaining affected `*.spec.ts` in `apps/control-plane`, `packages/core`, `packages/sdk`

- [ ] **Step 1: Run affected package tests**

Run:

```bash
pnpm nx test control-plane -- --run
pnpm nx test core -- --run
pnpm nx test sdk -- --run
```

Expected: failures only where old tests still construct config, server, route dependencies, or protected clients without bearer/master values.

- [ ] **Step 2: Update main tests to include secret bootstrap values**

When calling `main(argv, env)` in tests, include `CONTROL_PLANE_BEARER_TOKEN` and `CONTROL_PLANE_MASTER_SECRET`. If tests capture logs, assert logs include `port` and `databasePath` and do not include token/master values.

- [ ] **Step 3: Update any remaining route dependency builders**

Every direct `registerControlPlaneRoutes` call must pass:

```ts
auth: { bearerToken: 'test-token' },
policy: permissivePolicyDecisionPoint,
configurationRecords: inMemoryConfigurationRepository,
secrets: inMemorySecretStore
```

Every `/v1` request in tests must include `Authorization: Bearer test-token`, except negative auth tests.

- [ ] **Step 4: Re-run affected tests and commit**

Run:

```bash
pnpm nx test control-plane -- --run
pnpm nx test core -- --run
pnpm nx test sdk -- --run
```

Expected: all affected package tests pass.

Commit:

```bash
git add apps/control-plane/src packages/core/src packages/sdk/src
git commit -m "test: migrate control plane regressions to protected v1"
```

### Task 17: Agent Documentation and Decision Record

**Files:**
- Modify: `context-agent/wiki/code-map.md`
- Add: `context-agent/decisions/core-api-request-type-aliases.md`

- [ ] **Step 1: Update code map entries**

Update `context-agent/wiki/code-map.md` with these exact facts:

- `apps/control-plane/src/config.ts` reads `CONTROL_PLANE_PORT`, `CONTROL_PLANE_DATABASE_PATH`, `CONTROL_PLANE_BEARER_TOKEN`, `CONTROL_PLANE_MASTER_SECRET` and matching flags.
- `apps/control-plane/src/server.ts` owns SQLite open/migrate/close, secret-store unlock, repository construction, health checker injection, and policy injection.
- `packages/core/src/auth.ts`, `principal.ts`, and `policy.ts` own bearer auth, hardcoded principal request context, and permissive policy seam.
- `packages/core/src/routes.ts` keeps `GET /health` public and protects `/v1` routes.
- `packages/api-contract/src/configuration-record.ts`, `secret.ts`, and `principal.ts` own new Zod contracts.
- `packages/persistence/src/configuration-record-repository.ts` and `secret-store.ts` own durable config and encrypted secrets.
- `packages/persistence/drizzle/0001_create_configuration_and_secrets.sql` creates config and secret-store tables.
- `packages/sdk/src/client.ts` accepts `bearerToken` and exposes config CRUD plus create-secret.
- Local run command now requires token and master secret:

```bash
CONTROL_PLANE_PORT=3000 \
CONTROL_PLANE_DATABASE_PATH=.data/control-plane.sqlite \
CONTROL_PLANE_BEARER_TOKEN=dev-token \
CONTROL_PLANE_MASTER_SECRET=dev-master-secret \
pnpm nx serve control-plane
```

- [ ] **Step 2: Add decision record**

Create `context-agent/decisions/core-api-request-type-aliases.md`:

```markdown
---
date: 2026-06-08
status: accepted
superseded_by: null
---
# Core API request type aliases
**Decision:** Core use-case modules may alias API-contract request types for intentional input seams while repositories and routes continue to depend on the contract-owned Zod schemas.
**Rationale:**
- Keeps API validation source-of-truth in `packages/api-contract`.
- Gives core stable names for use-case inputs without duplicating Zod schemas.
- Makes future domain-specific input divergence explicit when it becomes necessary.
**Constraints:**
- Core must not import persistence implementations.
- Response parsing remains at route boundaries before sending to clients.
**Rejected:** Duplicate core Zod schemas — they would drift from the public API contract during this feature.
```

- [ ] **Step 3: Commit documentation**

Run:

```bash
git diff -- context-agent/wiki/code-map.md context-agent/decisions/core-api-request-type-aliases.md
```

Expected: docs mention all new locations and no human-owned docs changed.

Commit:

```bash
git add context-agent/wiki/code-map.md context-agent/decisions/core-api-request-type-aliases.md
git commit -m "docs(agent): map auth config and secret seams"
```

### Task 18: Targeted and Full Validation

**Files:**
- No code files unless failures require fixes.

- [ ] **Step 1: Run targeted tests by package**

Run:

```bash
pnpm nx test api-contract -- --run
pnpm nx test core -- --run
pnpm nx test persistence -- --run
pnpm nx test sdk -- --run
pnpm nx test control-plane -- --run
```

Expected: all package tests pass.

- [ ] **Step 2: Run lint and build for changed packages**

Run:

```bash
pnpm nx run-many -t lint build -p api-contract core persistence sdk control-plane
```

Expected: lint and TypeScript build pass for changed packages.

- [ ] **Step 3: Run full repository validation**

Run:

```bash
pnpm validate
```

Expected: build, lint, test, and boundary checks pass.

- [ ] **Step 4: Inspect for forbidden secret exposure**

Run searches that should return no source/test fixture containing logged secrets outside test input strings:

```bash
rg "console\.(log|info|warn|error).*bearer|console\.(log|info|warn|error).*master|secretValue" apps packages context-agent
```

Expected: no runtime logging of bearer token, master secret, raw secret values, or response `secretValue` field. Test input literals are acceptable only where assertions prove they are not echoed.

- [ ] **Step 5: Commit validation fixes or record skipped checks**

If validation required code fixes, commit them:

```bash
git add apps packages context-agent package.json pnpm-lock.yaml
git commit -m "fix: address principal config secret validation"
```

If a check cannot run, record the exact command and reason in the implementation handoff. Do not skip `pnpm validate` unless dependencies are unavailable or the sandbox cannot execute the command.

---

## Self-Review Checklist

- Spec coverage:
  - Principal type/kinds: Tasks 2, 4, 11, 14.
  - Bearer auth on every `/v1` route: Tasks 4, 10, 12, 13, 16.
  - Public unauthenticated `GET /health`: Tasks 9, 10, 14.
  - Policy-decision point: Tasks 4, 10, 11, 12, 13, 14.
  - Service-owned config CRUD: Tasks 2, 5, 6, 7, 12, 14, 15.
  - API-boundary validation: Tasks 2, 12, 14.
  - Secret handle schema and encrypted store: Tasks 2, 6, 8, 13, 14.
  - Bootstrap token/master secret: Tasks 1, 9, 16.
  - SDK support: Task 15.
  - Agent docs: Task 17.
  - Full validation: Task 18.
- Placeholder scan: This plan intentionally avoids deferred implementation markers; every task states files, commands, and concrete behavior.
- Type consistency:
  - Contract types use `Principal`, `ConfigurationRecord`, `CreateConfigurationRecordRequest`, `UpdateConfigurationRecordRequest`, `CreateSecretRequest`, and `CreateSecretResponse` consistently.
  - Policy action/resource descriptors match the approved spec exactly, including `/v1/principal` for the diagnostic route.
  - Error code constants are `unauthorized`, `validation_error`, `not_found`, and `secret_store_locked`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-08-principal-config-secret-store.md`. Implementation must stay on the current Autocatalyst-managed branch. Do not create branches, switch branches, create worktrees, push, merge, or open PRs.

Two execution options for the next stage:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in one session using executing-plans, batch execution with checkpoints.
