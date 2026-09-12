import { describe, expect, it, vi } from 'vitest';
import { measureGraphEdges, sameGraphEdgeGeometry, type GraphDomEdge } from './graph-edge-geometry';
import { projectSuperElementDriftEdges } from './super-element-drift-model';
import { createSyntheticWorkspaceProjection } from '../../performance/fixture';

const edge: GraphDomEdge = { id: 'edge', fromKind: 'node', fromId: 'drift', toKind: 'element', toId: 'element',
  relationTypeId: 'type', directed: true, color: '#123456' };
const endpoint = (left: number, top: number, width: number, height: number) => ({
  getBoundingClientRect: vi.fn(() => ({ left, top, width, height })),
});

describe('graph endpoint measurement', () => {
  it('measures unique DOM identities once, including aliases and self edges', () => {
    const a = endpoint(-10, 20, 40, 30); const b = endpoint(100, -30, 60, 20);
    const result = measureGraphEdges([edge, { ...edge, id: 'duplicate' }, { ...edge, id: 'alias', toId: 'alias' }],
      (_kind, id) => id === 'element' ? b : a);
    expect(a.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(b.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(result[0]).toEqual({ id: 'edge', relationTypeId: 'type', directed: true, color: '#123456',
      x1: 10, y1: 35, x2: 130, y2: -20, targetInsetX: 36, targetInsetY: 16 });
    expect(result[2]).toMatchObject({ x1: 10, x2: 10, y1: 35, y2: 35, targetInsetX: 26, targetInsetY: 21 });
  });

  it('does not retain measurements across frames or measure a dangling edge', () => {
    const a = endpoint(0, 0, 10, 20); const b = endpoint(20, 30, 40, 50);
    const resolve = (_kind: string, id: string) => id === 'drift' ? a : id === 'element' ? b : undefined;
    expect(measureGraphEdges([{ ...edge, toId: 'missing' }], resolve)).toEqual([]);
    expect(a.getBoundingClientRect).not.toHaveBeenCalled();
    const first = measureGraphEdges([edge], resolve);
    b.getBoundingClientRect.mockReturnValue({ left: 70, top: 30, width: 40, height: 50 });
    const second = measureGraphEdges([edge], resolve);
    expect(second[0].x2 - first[0].x2).toBe(50);
    expect(a.getBoundingClientRect).toHaveBeenCalledTimes(2);
  });

  it('skips equal output but invalidates geometry, styles, identity, order and removal', () => {
    const a = endpoint(1, 2, 30, 40);
    const first = measureGraphEdges([edge, { ...edge, id: 'other' }], () => a);
    expect(sameGraphEdgeGeometry(first, first.map((item) => ({ ...item })))).toBe(true);
    for (const change of [{ color: '#654321' }, { relationTypeId: 'other' }, { directed: false }, { targetInsetX: 1 }, { x2: 999 }]) {
      expect(sameGraphEdgeGeometry(first, [{ ...first[0], ...change }, first[1]])).toBe(false);
    }
    expect(sameGraphEdgeGeometry(first, [first[1], first[0]])).toBe(false);
    expect(sameGraphEdgeGeometry(first, [])).toBe(false);
  });

  it('projects drift to element links in either direction before resolving visible DOM', () => {
    const fixture = createSyntheticWorkspaceProjection('synthetic', 1, 1);
    const base = { id: 'edge', projectId: 'synthetic', fromKind: 'node' as const, fromId: fixture.bookNodes[0].id,
      toKind: 'element' as const, toId: fixture.bookElements[0].id, relationTypeId: 'type', createdAt: '', updatedAt: '' };
    const input = { entityRelations: [base, { ...base, id: 'reverse', fromKind: base.toKind, fromId: base.toId,
      toKind: base.fromKind, toId: base.fromId }, { ...base, id: 'hidden', relationTypeId: 'hidden' },
    { ...base, id: 'ordinary', fromId: 'chapter' }, { ...base, id: 'drifts', toKind: 'node' as const, toId: base.fromId }],
    hiddenRelationTypeIds: new Set(['hidden']), driftIds: new Set([base.fromId]),
    relationTypeById: new Map(), resolveRelationTypeColor: () => '#123456' };
    const edges = projectSuperElementDriftEdges(input);
    expect(edges.map((item) => item.id)).toEqual(['edge', 'reverse']);
    expect(edges[1]).toMatchObject({ fromKind: 'element', toKind: 'node', directed: false, color: '#123456' });
    expect(measureGraphEdges(edges, () => undefined)).toEqual([]);
    expect(projectSuperElementDriftEdges(input)).toEqual(edges);
  });
});
