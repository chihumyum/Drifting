import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const core = process.cwd();
const read = (path: string) => readFileSync(resolve(core, path), 'utf8');

describe('Ambient Editor frozen design boundary', () => {
  const index = read('docs/ambient-editor/README.md');
  const architecture = read('docs/ambient-editor/technical-architecture.md');
  const vision = read('docs/ambient-editor/product-vision.md');
  const delivery = read('docs/ambient-editor/delivery-and-acceptance.md');

  it('checks in the complete normative design set without claiming implementation', () => {
    expect(index).toContain('design_status: frozen');
    expect(index).toContain('shipping_status: not_implemented');
    expect(index).toContain('product_namespace: ambient-editor');
    expect(index).toContain('old_shadow_ci_restored: false');
    expect(index).toContain('technical-architecture.md');
    expect(index).toContain('product-vision.md');
    expect(index).toContain('delivery-and-acceptance.md');

    expect(delivery).toContain('## 3. Phase 0 — design freeze');
    expect(delivery).toContain('## 4. Phase 1 — source and projection backbone');
    expect(delivery).toContain('## 10. Phase 7 — general availability evidence');
    expect(delivery).toContain('None. Phase 0 authorizes implementation');
  });

  it('freezes authority, read-only runtime, freshness, and lifecycle boundaries', () => {
    for (const clause of [
      '**Live Yjs owns prose.**',
      '**The author owns Canon.**',
      '**World Model is derived.**',
      'Provider output never writes SQLite or Yjs directly.',
      'Every projection and reconciliation is guarded by a source manifest',
      'app exit preserves Review Debt but does not',
    ]) {
      expect(`${architecture}\n${index}`, clause).toContain(clause);
    }

    expect(architecture).toContain('no new `src/renderer/lib/shadow` tree');
    expect(architecture).toContain('Concern remains the lifecycle authority');
    expect(architecture).toContain('terminal `submit_projection_candidate`');
    expect(architecture).toContain('terminal `submit_reconciliation`');
    expect(architecture).toMatch(/Every Lens\s+family defines a versioned typed identity encoder/);
    expect(architecture).toContain('no pass/fail or automatic prose/Canon mutation');
  });

  it('defines the intended author experience without CI or autonomous edits', () => {
    expect(vision).toContain('Attention, not judgment');
    expect(vision).toContain('Evidence before explanation');
    expect(vision).toContain('Quiet by default');
    expect(vision).toContain('Explicit handoff before action');
    expect(vision).toContain('The best session may contain no new Concern.');
    expect(vision).toContain('a promise of work after the app process exits');
  });

  it('links the design from current truth while keeping Ambient explicitly unshipped', () => {
    const docsIndex = read('docs/README.md');
    const currentStatus = read('docs/agent-runtime/acceptance/CURRENT_STATUS.md');
    const roadmap = read('docs/agent-runtime/ROADMAP.md');
    const productReadme = read('README.md');
    const agentGuidance = read('AGENTS.md');

    expect(docsIndex).toContain('ambient-editor/README.md');
    expect(productReadme).toContain('docs/ambient-editor/README.md');
    expect(agentGuidance).toContain('docs/ambient-editor/README.md');
    expect(agentGuidance).toContain('shared renderer-owned Agent Runtime');
    expect(currentStatus).toContain('Approved future Ambient design — not shipped');
    expect(currentStatus).toContain('No Ambient route, World Model, Review Debt queue');
    expect(roadmap).toContain('Target design Phase 0 is frozen');
    expect(roadmap).toContain('phases 1–7 are not implemented');
  });
});
