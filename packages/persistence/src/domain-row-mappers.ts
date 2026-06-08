import type { ZodType } from 'zod';

export function stringifyJsonValue<T>(schema: ZodType<T>, value: T): string {
  return JSON.stringify(schema.parse(value));
}

export function parseJsonValue<T>(schema: ZodType<T>, value: string): T {
  return schema.parse(JSON.parse(value) as unknown);
}

export function parseNullableJsonValue<T>(schema: ZodType<T>, value: string | null): T | null {
  if (value === null) {
    return null;
  }
  return parseJsonValue(schema, value);
}

export function nullableJsonForRow<T>(schema: ZodType<T>, value: T | null | undefined): string | null {
  return value === null || value === undefined ? null : stringifyJsonValue(schema, value);
}

export function validateEntity<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
