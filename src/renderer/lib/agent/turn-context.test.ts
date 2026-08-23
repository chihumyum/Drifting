import { describe, expect, it } from 'vitest';
import { agentTurnContextPrompt, normalizeAgentTurnContext } from './turn-context';

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

  it('builds an answer-only provider note from the same visible stable ids', () => {
    const prompt = agentTurnContextPrompt([
      { kind: 'project', projectId: 'p1', label: 'My Book' },
      {
        kind: 'workspace',
        projectId: 'p1',
        label: 'Chapter One',
        entityType: 'node',
        entityId: 'node-1',
        blockId: 'block-1',
      },
    ]);

    expect(prompt).toContain('node-1');
    expect(prompt).toContain('stableBlockId="block-1"');
    expect(prompt).toContain('answer-only');
    expect(prompt).toContain('Read current authored evidence');
  });
});
