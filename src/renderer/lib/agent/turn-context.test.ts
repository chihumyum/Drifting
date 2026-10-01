import { describe, expect, it } from 'vitest';
import { normalizeAgentTurnContext } from './turn-context';

describe('agent turn context', () => {
  it('normalizes and de-duplicates stable visible context refs', () => {
    const refs = normalizeAgentTurnContext([
      { kind: 'project', projectId: 'p1', label: '  My Book  ' },
      {
        kind: 'workspace',
        projectId: 'p1',
        label: 'Chapter One',
        entityType: 'node',
        entityId: 'node-1',
        blockId: 'block-1',
      },
      {
        kind: 'workspace',
        projectId: 'p1',
        label: 'Chapter One',
        entityType: 'node',
        entityId: 'node-1',
        blockId: 'block-1',
      },
    ]);

    expect(refs).toHaveLength(2);
    expect(refs[0]?.label).toBe('My Book');
    expect(refs[1]).toMatchObject({ entityId: 'node-1', blockId: 'block-1' });
  });
});
