import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const prelude = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateNativeGraphReport, assertNativeGraphPersistence } from './scripts/renderer-native-graph-contract.mjs';
`;
const synthetic = `
const fixture={projectId:'synthetic',placedId:'placed',unplacedId:'unplaced',driftIds:['drift0','drift1'],lineIds:['line0','line1','line2'],typeId:'type',elementId:'element'};
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const snapshot={nodes:[{id:'placed',kind:'chapter',bookOrder:47,narrativeOrder:4.25},{id:'unplaced',kind:'chapter',bookOrder:48,narrativeOrder:2.5},...['drift0','drift1'].map((id,i)=>({id,kind:'drift',bookOrder:null,narrativeOrder:i+1}))],
 links:['placed','unplaced'].flatMap(nodeId=>['line1','line2'].map((storylineId,i)=>({nodeId,storylineId,isPrimary:i===0}))),
 relations:[{id:uuid(1),fromKind:'node',fromId:'drift0',toKind:'node',toId:'placed',relationTypeId:'type'},
 {id:uuid(2),fromKind:'node',fromId:'unplaced',toKind:'node',toId:'drift1',relationTypeId:'type'},
 {id:uuid(3),fromKind:'element',fromId:'element',toKind:'node',toId:'drift1',relationTypeId:'type'}],
 markers:[{id:uuid(4),narrativeOrder:6.75,label:'',driftNodeId:'drift0'}]};
const report={kind:'renderer_native_composition',status:'passed',fixture:{graph:fixture,reproducible:true},
 runs:[false,true].map(restart=>({status:'passed',exitCode:0,uncaughtErrors:0,checks:{graphInteractions:true},graphInteractions:{fixture,restart,snapshot:structuredClone(snapshot),
 checks:restart?{restoredCoordinates:true,restoredRelations:true,restoredMarker:true,restoredGraphPresentation:true}:{unplacedDrop:true,placedDrop:true,cancelledDrop:true,storyRelations:true,driftMarker:true,elementRelation:true,specialEdgesHiddenRetained:true}}})),
 persistence:{graph:{independentReadOnlySqlite:true,unrelatedStructurePreserved:true,createdRelations:3,createdMarkers:1}}};
`;
function run(script: string, captured = false) {
  const input = captured ? "const report = JSON.parse(fs.readFileSync('docs/renderer-performance/acceptance/f5-graph-interactions-native.json'));\n" : synthetic;
  return spawnSync(process.execPath, ['--input-type=module', '-e', prelude + input + script], { cwd: root, encoding: 'utf8' });
}

describe('native graph persistence evidence', () => {
  it('validates captured commits and restart without inferring current device performance', () => {
    const result = run('validateNativeGraphReport(report);', true);
    expect(result.status, result.stderr).toBe(0);
  });
  it('rejects missing or semantically different graph outcomes', () => {
    const result = run(`
validateNativeGraphReport(report);
for (const mutate of [
  r => r.runs[0].graphInteractions.snapshot.nodes.find(n => n.id === r.fixture.graph.unplacedId).narrativeOrder = 2,
  r => r.runs[0].graphInteractions.snapshot.links.pop(),
  r => r.runs[0].graphInteractions.snapshot.relations[0].fromId = r.fixture.graph.elementId,
  r => r.runs[1].graphInteractions.snapshot.markers[0].driftNodeId = r.fixture.graph.driftIds[1],
  r => r.runs[0].graphInteractions.checks.cancelledDrop = false,
  r => r.runs[1].graphInteractions.checks.restoredGraphPresentation = false,
  r => r.persistence.graph.independentReadOnlySqlite = false,
  r => r.runs.pop(),
]) { const changed = structuredClone(report); mutate(changed); assert.throws(() => validateNativeGraphReport(changed)); }
`);
    expect(result.status, result.stderr).toBe(0);
  });
  it('checks unrelated structure, book order and exact added rows against independent SQLite snapshots', () => {
    const result = run(`
const f = report.fixture.graph; const evidence = report.runs[0].graphInteractions;
const s = evidence.snapshot; const byId = rows => rows.sort((a,b) => a.id.localeCompare(b.id));
const after = { nodes: byId([...s.nodes.map(n => ({...n, projectId:f.projectId})), {id:'foreign-node',projectId:'foreign',kind:'chapter',bookOrder:7,narrativeOrder:9}]),
 links:s.links.map(l => ({...l,isPrimary:Number(l.isPrimary)})),
 relations:byId([...s.relations.map(r => ({...r,projectId:f.projectId})), {id:'foreign-relation',projectId:'foreign',fromKind:'node',fromId:'foreign-node',toKind:'node',toId:'foreign-target',relationTypeId:'foreign-type'}]),
 markers:byId([...s.markers.map(m => ({...m,projectId:f.projectId})), {id:'foreign-marker',projectId:'foreign',narrativeOrder:3,label:'synthetic',driftNodeId:null}]) };
const before = structuredClone(after);
for (const n of before.nodes) { if(n.id===f.placedId)n.narrativeOrder=0; if(n.id===f.unplacedId)n.narrativeOrder=null; }
for (const l of before.links) if(l.storylineId===f.lineIds[1]) l.storylineId=f.lineIds[0];
before.relations=before.relations.filter(r=>r.projectId==='foreign'); before.markers=before.markers.filter(m=>m.projectId==='foreign');
assertNativeGraphPersistence(before, after, f, evidence);
for (const mutate of [
 r=>r.nodes.find(n=>n.id==='foreign-node').narrativeOrder=10,
 r=>r.nodes.find(n=>n.id===f.placedId).bookOrder=900,
 r=>r.links.pop(), r=>r.relations.pop(), r=>r.markers.find(m=>m.projectId===f.projectId).narrativeOrder=7,
]) { const changed=structuredClone(after); mutate(changed); assert.throws(()=>assertNativeGraphPersistence(before,changed,f,evidence)); }
`);
    expect(result.status, result.stderr).toBe(0);
  });
});
