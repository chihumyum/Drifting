import { getTableName, is, Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as schema from '../renderer/schema/drizzle';
import {
  DEV_CLI_MODEL_CAPABILITIES,
  DEV_CLI_PROVIDER_TOOLS,
  DEV_CLI_TABLE_MODEL_COVERAGE,
} from './manifest';

describe('developer CLI capability manifest', () => {
  it('accounts for every checked-in Drizzle table exactly once', () => {
    const schemaTables = (Object.values(schema) as unknown[])
      .filter((value): value is Table => is(value, Table))
      .map((table) => getTableName(table))
      .sort();
    expect(Object.keys(DEV_CLI_TABLE_MODEL_COVERAGE).sort()).toEqual(schemaTables);
    const modelNames = new Set(DEV_CLI_MODEL_CAPABILITIES.map((model) => model.name));
    expect(
      Object.values(DEV_CLI_TABLE_MODEL_COVERAGE).every((model) => modelNames.has(model)),
    ).toBe(true);
  });

  it('keeps provider tool names unique and separates read from write', () => {
    const read = new Set<string>(DEV_CLI_PROVIDER_TOOLS.read);
    const write = new Set<string>(DEV_CLI_PROVIDER_TOOLS.write);
    expect(read.size).toBe(DEV_CLI_PROVIDER_TOOLS.read.length);
    expect(write.size).toBe(DEV_CLI_PROVIDER_TOOLS.write.length);
    expect([...read].filter((name) => write.has(name))).toEqual([]);
  });

  it('never gives generic CRUD to append-only, derived, secret, or runtime evidence', () => {
    for (const model of DEV_CLI_MODEL_CAPABILITIES) {
      if (
        !['workflow_only', 'derived_rebuild', 'inspect_reconcile', 'excluded'].includes(
          model.coverage,
        )
      )
        continue;
      expect(
        model.commands.some((command) =>
          /workspace resource (create|update|delete)/u.test(command),
        ),
      ).toBe(false);
    }
  });
});
