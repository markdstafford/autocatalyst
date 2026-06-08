# @autocatalyst/api-contract

This package is the source of truth for the control-plane HTTP API. Request and response shapes are Zod schemas; TypeScript types, runtime validation, OpenAPI output, and SDK calls derive from those schemas and exported route/status constants.

## Versioning rule

Application routes live under `/v1`. Within `/v1`, evolution is additive: add endpoints or optional fields; do not remove fields, rename fields, or change the meaning of existing fields. `GET /health` is operational and remains unversioned.

## Probe resources

`/v1/probe-resources` is proof-only scaffolding. It exists to prove request validation, repository persistence, SQLite storage, response validation, OpenAPI generation, and SDK consumption. Do not treat probe resources as an Autocatalyst domain entity.
