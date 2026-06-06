/**
 * Pure-function tests for the dep-graph value snapshot + diff (no LLM, no DB).
 * Drives the in-memory data store directly and checks snapshotConsulted /
 * computeChangedDeps — the engine that turns "an entity changed" into the
 * old→new hint fed to the judge.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { useDataStore } from '../../store/data-store';
import { snapshotConsulted, computeChangedDeps } from './dep-snapshot';
import type { BookElement } from '../../domain/book-element';
import type {
  ShadowJob,
  ShadowConsultedRef,
  ConsultedSnapshotRef,
} from '../../domain/shadow-job';

const kvJson = (o: Record<string, string>) =>
  JSON.stringify(Object.entries(o).map(([key, value]) => ({ key, value })));

function el(id: string, name: string, facts: Record<string, string>, summary = ''): BookElement {
  return { id, projectId: 'p1', name, summary, kvJson: kvJson(facts) } as unknown as BookElement;
}

function doneJob(
  chapterId: string,
  finishedAt: string,
  consultedSnapshot: ConsultedSnapshotRef[],
): ShadowJob {
  return {
    id: `j-${finishedAt}`,
    projectId: 'p1',
    chapterId,
    chapterTitle: '',
    status: 'done',
    decision: 'finished',
    findingCount: 0,
    error: null,
    trace: [],
    consulted: [],
    consultedCaptured: true,
    consultedSnapshot,
    archived: false,
    startedAt: finishedAt,
    finishedAt,
    createdAt: finishedAt,
    updatedAt: finishedAt,
  };
}

beforeEach(() => {
  useDataStore.setState({ bookElements: [], storylines: [], bookNodes: [], shadowJobs: [] });
});

describe('snapshotConsulted', () => {
  test('freezes facts + summary for a consulted element', () => {
    useDataStore.setState({
      bookElements: [el('e1', '林澈', { 隐蔽性: '极隐蔽，常借他人之手' }, '冷峻')],
    });
    const refs: ShadowConsultedRef[] = [{ kind: 'element', id: 'e1', label: '林澈' }];
    expect(snapshotConsulted(refs)).toEqual([
      { kind: 'element', id: 'e1', label: '林澈', summary: '冷峻', facts: { 隐蔽性: '极隐蔽，常借他人之手' } },
    ]);
  });

  test('skips refs whose entity is gone from the store', () => {
    const refs: ShadowConsultedRef[] = [{ kind: 'element', id: 'missing', label: 'x' }];
    expect(snapshotConsulted(refs)).toEqual([]);
  });
});

describe('computeChangedDeps', () => {
  test('diffs a changed KV fact: prior snapshot vs current canon', () => {
    useDataStore.setState({
      bookElements: [el('e1', '林澈', { 隐蔽性: '高调张扬，凡事亲自出面' }, '冷峻')],
      shadowJobs: [
        doneJob('c1', '2026-01-01T00:00:00Z', [
          { kind: 'element', id: 'e1', label: '林澈', summary: '冷峻', facts: { 隐蔽性: '极隐蔽，常借他人之手' } },
        ]),
      ],
    });
    expect(computeChangedDeps('p1', 'c1')).toEqual([
      { name: '林澈', fact: '隐蔽性', from: '极隐蔽，常借他人之手', to: '高调张扬，凡事亲自出面' },
    ]);
  });

  test('no prior snapshot → empty (cold first review)', () => {
    useDataStore.setState({ bookElements: [el('e1', 'x', { a: '1' })] });
    expect(computeChangedDeps('p1', 'c1')).toEqual([]);
  });

  test('unchanged canon → no hint', () => {
    useDataStore.setState({
      bookElements: [el('e1', 'x', { a: '1' }, 's')],
      shadowJobs: [
        doneJob('c1', '2026-01-01T00:00:00Z', [
          { kind: 'element', id: 'e1', label: 'x', summary: 's', facts: { a: '1' } },
        ]),
      ],
    });
    expect(computeChangedDeps('p1', 'c1')).toEqual([]);
  });

  test('uses the LATEST completed review as the diff baseline', () => {
    useDataStore.setState({
      bookElements: [el('e1', 'x', { a: '3' })],
      shadowJobs: [
        doneJob('c1', '2026-01-01T00:00:00Z', [{ kind: 'element', id: 'e1', label: 'x', facts: { a: '1' } }]),
        doneJob('c1', '2026-02-01T00:00:00Z', [{ kind: 'element', id: 'e1', label: 'x', facts: { a: '2' } }]),
      ],
    });
    // Baseline = the Feb review (a:'2'), not the Jan one → diff to current a:'3'.
    expect(computeChangedDeps('p1', 'c1')).toEqual([{ name: 'x', fact: 'a', from: '2', to: '3' }]);
  });

  test('flags an added and a removed KV key', () => {
    useDataStore.setState({
      bookElements: [el('e1', 'x', { b: '2' })], // 'a' removed, 'b' added
      shadowJobs: [
        doneJob('c1', '2026-01-01T00:00:00Z', [{ kind: 'element', id: 'e1', label: 'x', facts: { a: '1' } }]),
      ],
    });
    const deps = computeChangedDeps('p1', 'c1');
    expect(deps).toContainEqual({ name: 'x', fact: 'a', from: '1', to: '（已删除）' });
    expect(deps).toContainEqual({ name: 'x', fact: 'b', from: '（无）', to: '2' });
    expect(deps).toHaveLength(2);
  });
});
