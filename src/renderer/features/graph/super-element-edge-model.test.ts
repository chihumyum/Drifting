import { describe, expect, it } from 'vitest';
import { createSyntheticWorkspaceProjection } from '../../performance/fixture';
import type { EntityRelationLink } from '../../store/data-store';
import type { EntityRelationType } from '../../domain/entity-relation-type';
import {
  buildSuperElementWorldEdges, projectSuperElementViewportEdges,
  type SuperElementEdgeInput, type SuperElementViewportInput, type SuperElementWorldEdge,
} from './super-element-edge-model';

const relation = (overrides: Partial<EntityRelationLink> = {}): EntityRelationLink => ({
  id: 'edge', projectId: 'synthetic', fromKind: 'element', fromId: 'synthetic-element-0',
  toKind: 'node', toId: 'synthetic-node-0', relationTypeId: 'directed',
  createdAt: '2026-09-12', updatedAt: '2026-09-12', ...overrides,
});
const directedType: EntityRelationType = {
  id: 'directed', projectId: 'synthetic', name: '合成关系', normalizedName: '合成关系',
  description: '', orientation: 'directed', systemKey: null, locked: false,
  sourceRole: '', targetRole: '', sourceKinds: ['node', 'element'], targetKinds: ['node', 'element'],
  createdAt: '2026-09-12', updatedAt: '2026-09-12',
};
function fixture(overrides: Partial<SuperElementEdgeInput> = {}): SuperElementEdgeInput {
  return {
    ...createSyntheticWorkspaceProjection('synthetic', 2, 2),
    entityRelations: [relation()], hiddenRelationTypeIds: new Set(), driftIds: new Set(),
    elementCenters: new Map([['synthetic-element-0', { x: 0, y: -10 }], ['synthetic-element-1', { x: 96, y: 56 }]]),
    nodeCenters: new Map([['synthetic-node-0', { x: -120, y: 28 }], ['synthetic-node-1', { x: 0, y: 28 }]]),
    relationTypeById: new Map([['directed', directedType]]),
    resolveRelationTypeColor: (id) => id === 'directed' ? '#123456' : '#654321',
    cellWidth: 96, cellHeight: 56, bandPillWidth: 110, ...overrides,
  };
}

describe('Super Element world edge projection', () => {
  it('preserves order, labels, colors, direction and target insets in either orientation', () => {
    const edges = buildSuperElementWorldEdges(fixture({ entityRelations: [relation(), relation({
      id: 'reverse', fromKind: 'node', fromId: 'synthetic-node-0',
      toKind: 'element', toId: 'synthetic-element-1', relationTypeId: 'unknown',
    }), relation({ id: 'elements', toKind: 'element', toId: 'synthetic-element-1' })] }));
    expect(edges[0]).toEqual({
      id: 'edge', refId: 'edge', fromKind: 'element', toKind: 'node',
      x1: 0, y1: -10, x2: -120, y2: 28, relationTypeId: 'directed', directed: true,
      targetInsetX: 61, targetInsetY: 34, color: '#123456', fromName: '合成人物0', toName: '合成章节0',
    });
    expect(edges[1]).toMatchObject({ id: 'reverse', x1: -120, y1: 28, x2: 96, y2: 56,
      fromKind: 'node', toKind: 'element', fromName: '合成章节0', toName: '合成人物1',
      directed: false, targetInsetX: 54, targetInsetY: 34, color: '#654321' });
    expect(edges[2]).toMatchObject({ id: 'elements', fromName: '合成人物0', toName: '合成人物1' });
  });

  it('excludes hidden, unsupported, missing-position and either-endpoint drift relations', () => {
    const edges = buildSuperElementWorldEdges(fixture({
      driftIds: new Set(['synthetic-node-1']), hiddenRelationTypeIds: new Set(['hidden']),
      entityRelations: [
        relation(), relation({ id: 'hidden', relationTypeId: 'hidden' }),
        relation({ id: 'missing', toId: 'missing' }),
        relation({ id: 'unsupported', toKind: 'category' }),
        relation({ id: 'nodes', fromKind: 'node', fromId: 'synthetic-node-0' }),
        relation({ id: 'to-drift', toId: 'synthetic-node-1' }),
        relation({ id: 'from-drift', fromKind: 'node', fromId: 'synthetic-node-1', toKind: 'element', toId: 'synthetic-element-0' }),
      ],
    }));
    // Classification has no dependency on the open panel or its filtered cards.
    expect(edges.map((edge) => edge.id)).toEqual(['edge']);
  });

  it('rebuilds labels for replacement snapshots and retains first-match and fallback labels', () => {
    const input = fixture();
    const duplicate = { ...input.bookElements[0], name: 'second' };
    input.bookElements = [...input.bookElements, duplicate];
    const first = buildSuperElementWorldEdges(input);
    expect(first[0].fromName).toBe('合成人物0');
    const renamed = buildSuperElementWorldEdges({ ...input, bookElements: [{ ...duplicate, name: 'renamed' }], bookNodes: [] });
    expect(renamed[0]).toMatchObject({ fromName: 'renamed', toName: '?' });
    expect(buildSuperElementWorldEdges(input)).toEqual(first);
  });
});

const viewport: SuperElementViewportInput = {
  pan: { x: 10, y: -300 }, zoom: 2, viewportWidth: 500, viewportHeight: 400,
  bandSticky: true, edgesViewportOnly: false, bandTopWorldY: 100,
  bandHeightCells: 1, cellWidth: 96, cellHeight: 56,
};
function worldEdge(overrides: Partial<SuperElementWorldEdge> = {}): SuperElementWorldEdge {
  return { ...buildSuperElementWorldEdges(fixture())[0], x1: 20, y1: 250, x2: 40, y2: 128, ...overrides };
}

describe('Super Element viewport edge projection', () => {
  it('aligns top-sticky nodes without double-counting the band world offset', () => {
    const edge = worldEdge();
    const [projected] = projectSuperElementViewportEdges([edge], viewport);
    expect(projected).toEqual({ ...edge, x1: 50, y1: 200, x2: 90, y2: 56, targetInsetX: 122, targetInsetY: 68 });
    expect(edge.y2).toBe(128);
  });

  it('aligns the bottom-sticky and naturally visible band in both endpoint directions', () => {
    const reversed = worldEdge({ fromKind: 'node', toKind: 'element', y1: 128, y2: 250 });
    const [bottom] = projectSuperElementViewportEdges([reversed], { ...viewport, pan: { x: 0, y: 150 } });
    expect(bottom).toMatchObject({ y1: 344, y2: 650 });
    const [natural] = projectSuperElementViewportEdges([reversed], { ...viewport, pan: { x: 0, y: -100 } });
    expect(natural).toMatchObject({ y1: 156, y2: 400 });
  });

  it('keeps non-sticky node endpoints at the natural position when only focus is enabled', () => {
    const [projected] = projectSuperElementViewportEdges([worldEdge()], { ...viewport, bandSticky: false, edgesViewportOnly: true });
    expect(projected).toMatchObject({ y1: 200, y2: -44 });
    expect(projectSuperElementViewportEdges([worldEdge()], { ...viewport, bandSticky: false })).toEqual([]);
  });

  it('filters element cards outside the viewport or behind the sticky band, retaining touching boundaries', () => {
    const edges = [
      worldEdge({ id: 'visible' }),
      worldEdge({ id: 'outside', x1: -54 }), // screen center -98, half-width 96
      worldEdge({ id: 'touching', x1: -53 }), // right edge touches x=0
      worldEdge({ id: 'behind', y1: 178 }), // screen center 56, inside band
      worldEdge({ id: 'band-boundary', y1: 150 }),
      worldEdge({ id: 'target-outside', toKind: 'element', x2: 400, y2: 250 }),
    ];
    expect(projectSuperElementViewportEdges(edges, { ...viewport, edgesViewportOnly: true }).map((edge) => edge.id))
      .toEqual(['visible', 'touching', 'band-boundary']);
    expect(projectSuperElementViewportEdges(edges, viewport)).toHaveLength(edges.length);
  });

  it('matches the band transform for a band taller than the viewport and fractional zoom', () => {
    const edge = worldEdge();
    const [tall] = projectSuperElementViewportEdges([edge], { ...viewport, bandHeightCells: 5, pan: { x: 0, y: 0 } });
    expect(tall.y2).toBe(-104); // clamped top -160 plus local center 56
    const [fractional] = projectSuperElementViewportEdges([edge], { ...viewport, zoom: 0.5, pan: { x: -5, y: -20 } });
    expect(fractional).toMatchObject({ x1: 5, y1: 105, x2: 15, y2: 44, targetInsetX: 30.5, targetInsetY: 17 });
  });
});
