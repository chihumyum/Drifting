import assert from 'node:assert/strict';

const byId = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
const linksById = rows => [...rows].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.storylineId.localeCompare(b.storylineId));
const relationTuple = row => [row.fromKind, row.fromId, row.toKind, row.toId, row.relationTypeId];
const tuples = rows => rows.map(relationTuple).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const expectedTuples = f => tuples([
  { fromKind: 'node', fromId: f.driftIds[0], toKind: 'node', toId: f.placedId, relationTypeId: f.typeId },
  { fromKind: 'node', fromId: f.unplacedId, toKind: 'node', toId: f.driftIds[1], relationTypeId: f.typeId },
  { fromKind: 'element', fromId: f.elementId, toKind: 'node', toId: f.driftIds[1], relationTypeId: f.typeId },
]);
function validateSnapshot(snapshot, f) {
  assert.deepEqual(snapshot.nodes.map(row => row.id).sort(), [f.placedId, f.unplacedId, ...f.driftIds].sort());
  for (const [id, order] of [[f.placedId, 4.25], [f.unplacedId, 2.5]]) {
    const node = snapshot.nodes.find(row => row.id === id);
    assert.equal(node.kind, 'chapter'); assert.equal(node.narrativeOrder, order); assert(Number.isFinite(node.bookOrder));
  }
  for (const id of f.driftIds) {
    const node = snapshot.nodes.find(row => row.id === id);
    assert.equal(node.kind, 'drift'); assert.equal(node.bookOrder, null); assert(node.narrativeOrder === null || Number.isFinite(node.narrativeOrder));
  }
  assert.deepEqual(linksById(snapshot.links), linksById([f.placedId, f.unplacedId].flatMap(nodeId => f.lineIds.slice(1).map((storylineId, index) => ({ nodeId, storylineId, isPrimary: index === 0 })))));
  assert.deepEqual(tuples(snapshot.relations), expectedTuples(f));
  assert.equal(new Set(snapshot.relations.map(row => row.id)).size, 3);
  for (const row of snapshot.relations) assert.match(row.id, /^[a-f0-9-]{36}$/);
  assert.equal(snapshot.markers.length, 1);
  assert.deepEqual({ ...snapshot.markers[0], id: undefined }, { id: undefined, narrativeOrder: 6.75, label: '', driftNodeId: f.driftIds[0] });
  assert.match(snapshot.markers[0].id, /^[a-f0-9-]{36}$/);
}

/** Semantic evidence contract, also checked by ordinary CI without claiming a fresh native run. */
export function validateNativeGraphReport(report) {
  assert.equal(report.kind, 'renderer_native_composition'); assert.equal(report.status, 'passed');
  assert.equal(report.fixture.reproducible, true);
  const f = report.fixture.graph;
  assert(f && f.lineIds.length === 3 && f.driftIds.length === 2, 'Missing native graph fixture');
  for (const [index, run] of report.runs.entries()) {
    assert.equal(run.status, 'passed'); assert.equal(run.exitCode, 0); assert.equal(run.uncaughtErrors, 0);
    assert.equal(run.checks.graphInteractions, true);
    const evidence = run.graphInteractions;
    assert.deepEqual(evidence.fixture, f); assert.equal(evidence.restart, index === 1);
    assert.deepEqual(evidence.checks, index === 0 ? { unplacedDrop: true, placedDrop: true, cancelledDrop: true, storyRelations: true, driftMarker: true, elementRelation: true, specialEdgesHiddenRetained: true }
      : { restoredCoordinates: true, restoredRelations: true, restoredMarker: true, restoredGraphPresentation: true });
    validateSnapshot(evidence.snapshot, f);
  }
  assert.equal(report.runs.length, 2);
  assert.deepEqual(report.runs[0].graphInteractions.snapshot, report.runs[1].graphInteractions.snapshot, 'Native restart changed graph records');
  assert.deepEqual(report.persistence.graph, { independentReadOnlySqlite: true, unrelatedStructurePreserved: true, createdRelations: 3, createdMarkers: 1 });
}

/** Full before/after structural witness from a separate read-only SQLite process.
 * Only the two coordinates/primary memberships, three typed links and one pin may change. */
export function assertNativeGraphPersistence(before, after, f, evidence) {
  validateSnapshot(evidence.snapshot, f);
  const nodes = before.nodes.map(row => ({ ...row, narrativeOrder: row.id === f.placedId ? 4.25 : row.id === f.unplacedId ? 2.5 : row.narrativeOrder }));
  assert.deepEqual(after.nodes, nodes, 'Graph gesture changed unrelated node structure or book order');
  const movedIds = [f.placedId, f.unplacedId];
  const initialLinks = movedIds.flatMap(nodeId => [
    { nodeId, storylineId: f.lineIds[0], isPrimary: 1 },
    { nodeId, storylineId: f.lineIds[2], isPrimary: 0 },
  ]);
  assert.deepEqual(linksById(before.links.filter(row => movedIds.includes(row.nodeId))), linksById(initialLinks), 'Fixture must begin with a primary and an independent secondary');
  // A timeline move replaces the old primary membership; the independent
  // secondary remains. It does not demote the old primary into a new secondary.
  const links = [...before.links.filter(row => !movedIds.includes(row.nodeId)),
    ...movedIds.flatMap(nodeId => [
      { nodeId, storylineId: f.lineIds[1], isPrimary: 1 },
      { nodeId, storylineId: f.lineIds[2], isPrimary: 0 },
    ])];
  assert.deepEqual(linksById(after.links), linksById(links), 'Graph gesture lost secondary membership or changed unrelated links');
  const relations = evidence.snapshot.relations.map(row => ({ id: row.id, projectId: f.projectId, fromKind: row.fromKind, fromId: row.fromId, toKind: row.toKind, toId: row.toId, relationTypeId: row.relationTypeId }));
  assert.deepEqual(byId(after.relations), byId([...before.relations, ...relations]), 'Unexpected durable relation changes');
  const markers = evidence.snapshot.markers.map(row => ({ id: row.id, projectId: f.projectId, narrativeOrder: row.narrativeOrder, label: row.label, driftNodeId: row.driftNodeId }));
  assert.deepEqual(byId(after.markers), byId([...before.markers, ...markers]), 'Unexpected durable marker changes');
}
