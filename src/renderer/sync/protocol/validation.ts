import type { Static, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export interface ProtocolValidationIssue {
  path: string;
  message: string;
}

export type ProtocolValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly ProtocolValidationIssue[] };

export function validateSchema<T extends TSchema>(
  schema: T,
  value: unknown,
): ProtocolValidationResult<Static<T>> {
  if (Value.Check(schema, value)) return { ok: true, value };
  return {
    ok: false,
    issues: [...Value.Errors(schema, value)].map((error) => ({
      path: error.path || '$',
      message: error.message,
    })),
  };
}

export function assertSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  label: string,
): asserts value is Static<T> {
  const result = validateSchema(schema, value);
  if (result.ok) return;
  const detail = result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
  throw new TypeError(`${label} failed runtime validation: ${detail}`);
}
