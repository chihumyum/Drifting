import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = path.join(root, 'docs/renderer-performance/acceptance');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const plan = read(path.join(directory, 'optimization-plan.json'));
const phases = new Map(plan.phases.map((phase) => [phase.id, phase]));
assert.equal(phases.size, plan.phases.length, 'duplicate phase ID');
assert.equal(new Set(plan.recommendedOrder).size, phases.size, 'invalid phase order');
const visited = new Set();
const criteria = new Set();
for (const id of plan.recommendedOrder) {
  const phase = phases.get(id);
  assert(phase, `unknown phase ${id}`);
  assert(['planned', 'in_progress', 'complete'].includes(phase.status), `invalid status ${id}`);
  assert(phase.dependsOn.every((parent) => visited.has(parent)), `cyclic or out-of-order dependency ${id}`);
  for (const item of phase.acceptance) {
    assert(!criteria.has(item.id) && item.id.startsWith(`${id}-`), `invalid acceptance ID ${item.id}`);
    criteria.add(item.id);
    assert(Array.isArray(item.evidence));
    for (const evidence of item.evidence) {
      assert(typeof evidence === 'string' && evidence.startsWith('docs/renderer-performance/acceptance/'));
      assert(!evidence.split('/').includes('..') && existsSync(path.join(root, evidence)), `missing evidence ${evidence}`);
    }
    if (phase.status === 'complete') {
      assert.equal(item.status, 'passed', `${item.id} has not passed`);
      assert(item.evidence.length > 0, `${item.id} lacks evidence`);
    }
  }
  visited.add(id);
}
if (plan.optimizationImplementationStatus === 'complete') {
  assert(plan.phases.every((phase) => phase.status === 'complete'));
}

const reportPath = process.argv.find((arg) => arg.startsWith('--report='))?.slice(9)
  ?? path.join(directory, 'baseline-editor.json');
const report = read(reportPath);
assert.equal(report.schemaVersion, 1);
assert.equal(report.kind, 'renderer_performance_run');
assert.equal(report.status, 'measured');
assert.match(report.source.commit, /^[0-9a-f]{40}$/);
assert.match(report.source.rendererFingerprint, /^[0-9a-f]{64}$/);
assert(report.limitations.length > 0);
assert(report.scenarios.length > 0);
for (const check of [...(report.behaviorChecks ?? []), ...(report.budgetChecks ?? [])]) {
  assert.equal(check.passed, true, `failed check ${check.id}`);
}
const scenarioIds = new Set();
for (const scenario of report.scenarios) {
  assert(!scenarioIds.has(scenario.id));
  scenarioIds.add(scenario.id);
  assert.match(scenario.fixture.hash, /^[0-9a-f]{64}$/);
  assert.equal(scenario.finalLinks, scenario.fixture.links);
  assert.equal(scenario.finalCharacters, scenario.fixture.characters + scenario.warmupOperations + scenario.countedOperations + scenario.timingOperations);
  for (const count of Object.values(scenario.counts)) assert(Number.isSafeInteger(count) && count >= 0);
  for (const metric of [scenario.transactionMs, scenario.transactionToAnimationFrameMs]) {
    assert.equal(metric.samples.length, scenario.timingOperations);
    assert(metric.samples.every((value) => Number.isFinite(value) && value >= 0));
    const sorted = [...metric.samples].sort((a, b) => a - b);
    assert.equal(metric.median, sorted[Math.floor(sorted.length / 2)]);
    assert.equal(metric.p95, sorted[Math.ceil(sorted.length * 0.95) - 1]);
  }
}
console.log(`Renderer performance contract passed: ${phases.size} phases, ${criteria.size} criteria, ${report.scenarios.length} measured scenarios. No native acceptance inferred.`);
