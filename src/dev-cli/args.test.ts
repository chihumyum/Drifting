import { describe, expect, it } from 'vitest';
import { globalOptions, parseCliArgs, resolveInput } from './args';

describe('developer CLI argument protocol', () => {
  it('merges a JSON body with explicit flags and keeps JSON as default output', async () => {
    const parsed = parseCliArgs([
      'workspace',
      'call',
      'create_chapter',
      '--project',
      'p1',
      '--input',
      '{"title":"A","summary":"old"}',
      '--summary',
      'new',
    ]);
    expect(parsed.command).toEqual(['workspace', 'call', 'create_chapter']);
    expect(await resolveInput(parsed)).toEqual({ title: 'A', summary: 'new' });
    expect(globalOptions(parsed)).toMatchObject({ output: 'json', projectId: 'p1', yes: false });
  });

  it('parses booleans, numbers, arrays and camel-case domain flags', () => {
    const parsed = parseCliArgs([
      'capabilities',
      '--limit',
      '12',
      '--source-kinds',
      '["node"]',
      '--dry-run',
    ]);
    expect(parsed.values).toEqual({ limit: 12, sourceKinds: ['node'], dryRun: true });
  });
});
