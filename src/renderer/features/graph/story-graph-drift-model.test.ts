import { describe, expect, it } from 'vitest';
import { projectStoryGraphDriftEdges } from './story-graph-drift-model';
import type { EntityRelationType } from '../../domain/entity-relation-type';

const relationType: EntityRelationType = {
  id: 'type', projectId: 'synthetic', name: '合成', normalizedName: '合成', description: '', orientation: 'directed',
  systemKey: null, locked: false, sourceRole: '', targetRole: '', sourceKinds: ['node'], targetKinds: ['node'], createdAt: '', updatedAt: '',
};
const input = () => ({
  edges: [
    { id: 'from-drift', sourceNodeId: 'drift', targetNodeId: 'chapter', relationTypeId: 'type' },
    { id: 'to-drift', sourceNodeId: 'chapter', targetNodeId: 'drift', relationTypeId: 'type' },
    { id: 'both-drift', sourceNodeId: 'drift', targetNodeId: 'drift-2', relationTypeId: 'other' },
    { id: 'ordinary', sourceNodeId: 'chapter', targetNodeId: 'chapter-2', relationTypeId: 'type' },
  ],
  driftIds: new Set(['drift', 'drift-2']), hiddenRelationTypeIds: new Set<string>(),
  relationTypeById: new Map([['type', relationType]]),
  positionedById: new Map([['chapter', { storyline: { color: '#112233' } }]]),
  typeMeta: {} as Record<string, { color?: string }>,
});

describe('Story Graph drift read model', () => {
  it('classifies either drift endpoint, keeps direction/order and excludes hidden/ordinary edges', () => {
    const data = input();
    expect(projectStoryGraphDriftEdges(data)).toEqual([
      { id: 'from-drift', fromKind: 'node', fromId: 'drift', toKind: 'node', toId: 'chapter', relationTypeId: 'type', directed: true, color: '#112233' },
      { id: 'to-drift', fromKind: 'node', fromId: 'chapter', toKind: 'node', toId: 'drift', relationTypeId: 'type', directed: true, color: '#112233' },
      { id: 'both-drift', fromKind: 'node', fromId: 'drift', toKind: 'node', toId: 'drift-2', relationTypeId: 'other', directed: false, color: 'hsl(var(--accent))' },
    ]);
    expect(projectStoryGraphDriftEdges({ ...data, hiddenRelationTypeIds: new Set(['type']) }).map((edge) => edge.id)).toEqual(['both-drift']);
  });

  it('preserves override, source-storyline, target-storyline and accent precedence', () => {
    const data = input();
    data.positionedById.set('drift', { storyline: { color: '#445566' } });
    const edges = projectStoryGraphDriftEdges(data);
    expect(edges[0].color).toBe('#445566');
    expect(edges[1].color).toBe('#112233');
    expect(projectStoryGraphDriftEdges({ ...data, typeMeta: { type: { color: '#abcdef' } } }).slice(0, 2).map((edge) => edge.color))
      .toEqual(['#abcdef', '#abcdef']);
    expect(projectStoryGraphDriftEdges({ ...data, typeMeta: { type: { color: '' } } })[0].color).toBe('#445566');
  });
});
