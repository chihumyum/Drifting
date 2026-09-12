import { buildSuperElementWorldEdges, projectSuperElementViewportEdges, type SuperElementEdgeInput } from '../features/graph/super-element-edge-model';
import { createSyntheticWorkspaceProjection } from './fixture';

export function createGraphProjectionFixture(elements: number) {
  const projectId = 'synthetic-graph-project';
  const fixture = createSyntheticWorkspaceProjection(projectId, Math.max(1, Math.floor(elements / 5)), elements);
  const input: SuperElementEdgeInput = {
    ...fixture,
    entityRelations: Array.from({ length: elements * 3 }, (_, index) => ({
      id: `synthetic-edge-${index}`, projectId, fromKind: 'element', fromId: fixture.bookElements[index % elements].id,
      toKind: index % 3 === 0 ? 'node' : 'element',
      toId: index % 3 === 0 ? fixture.bookNodes[index % fixture.bookNodes.length].id : fixture.bookElements[(index * 7 + 1) % elements].id,
      relationTypeId: 'synthetic-type', createdAt: '2026-09-12', updatedAt: '2026-09-12',
    })),
    hiddenRelationTypeIds: new Set(), driftIds: new Set(), relationTypeById: new Map(),
    elementCenters: new Map(fixture.bookElements.map((element, index) => [element.id, { x: index % 50 * 100, y: Math.floor(index / 50) * 60 }])),
    nodeCenters: new Map(fixture.bookNodes.map((node, index) => [node.id, { x: index * 120, y: -60 }])),
    resolveRelationTypeColor: () => '#56789a', cellWidth: 96, cellHeight: 56, bandPillWidth: 110,
  };
  return input;
}

export async function runGraphProjectionScenarios() {
  const results = [];
  for (const elements of [100, 1_000, 5_000]) {
    const input = createGraphProjectionFixture(elements);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([input.bookElements, input.bookNodes, input.entityRelations])));
    const fixtureHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    let reads = 0; let counting = true;
    const instrument = <T extends { id: string }>(records: readonly T[]) => records.map((record) => ({
      ...record, get id() { if (counting) reads++; return record.id; },
    }));
    input.bookElements = instrument(input.bookElements); input.bookNodes = instrument(input.bookNodes);
    const first = buildSuperElementWorldEdges(input);
    const firstProjectionIdReads = reads; reads = 0;
    const repeat = buildSuperElementWorldEdges(input);
    const repeatedProjectionIdReads = reads;
    reads = 0;
    for (const [bandSticky, edgesViewportOnly] of [[true, false], [false, true], [true, true]]) {
      projectSuperElementViewportEdges(first, {
        pan: { x: 10, y: -100 }, zoom: 1.5, viewportWidth: 1_280, viewportHeight: 900,
        bandSticky, edgesViewportOnly, bandTopWorldY: -88, bandHeightCells: 1, cellWidth: 96, cellHeight: 56,
      });
    }
    const viewportProjectionIdReads = reads;
    counting = false;
    if (first.length !== input.entityRelations.length || JSON.stringify(first) !== JSON.stringify(repeat)) throw new Error('Graph fixture projection mismatch');
    // Expected output comes from the fixture's sequence and grid, independently
    // of the model's indexes, labels, relation filtering and geometry helpers.
    const expected = first.map((_, index) => {
      const source = index % elements;
      const isNode = index % 3 === 0;
      const target = isNode ? index % input.bookNodes.length : (index * 7 + 1) % elements;
      return {
        fromKind: 'element', toKind: isNode ? 'node' : 'element',
        id: `synthetic-edge-${index}`, refId: `synthetic-edge-${index}`,
        x1: source % 50 * 100, y1: Math.floor(source / 50) * 60,
        x2: isNode ? target * 120 : target % 50 * 100, y2: isNode ? -60 : Math.floor(target / 50) * 60,
        relationTypeId: 'synthetic-type', directed: false, targetInsetX: isNode ? 61 : 54,
        targetInsetY: 34, color: '#56789a', fromName: `合成人物${source}`, toName: isNode ? `合成章节${target}` : `合成人物${target}`,
      };
    });
    if (JSON.stringify(first) !== JSON.stringify(expected)) throw new Error('Graph edges differ from fixture contract');
    const samplesMs = [];
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now(); buildSuperElementWorldEdges(input); samplesMs.push(performance.now() - start);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    results.push({ elements, nodes: input.bookNodes.length, relations: input.entityRelations.length, fixtureHash,
      firstProjectionIdReads, repeatedProjectionIdReads, viewportProjectionIdReads,
      worldProjectionMatchesFixture: true, projectedEdges: first.length,
      samplesMs, medianMs: [...samplesMs].sort((a, b) => a - b)[2] });
  }
  return { implementation: 'shared-id-index', results,
    boundary: 'Actual Super Element world projection and three viewport modes. Synthetic getter counters; world timing uses warm inputs with counting disabled. Fixture output equivalence checked independently. No full graph UI/native acceptance.' };
}
