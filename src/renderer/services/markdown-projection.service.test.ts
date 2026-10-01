import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  database: {} as object,
  committed: (_event: { projectId: string }) => undefined as void,
  read: vi.fn(), build: vi.fn(), flush: vi.fn(), write: vi.fn(), info: vi.fn(), remove: vi.fn(),
}));
vi.mock('../platform', () => ({ platform: { markdownProjection: { info: fixture.info, write: fixture.write, remove: fixture.remove } } }));
vi.mock('../lib/db', () => ({ getDbIfInitialized: () => fixture.database }));
vi.mock('../sync/journal/authored-transaction', () => ({ onAuthoredChangeCommitted: (callback: typeof fixture.committed) => {
  fixture.committed = callback; return () => { fixture.committed = () => undefined; };
} }));
vi.mock('./yjs-local-durability.service', () => ({ flushAllOpenYjsDocuments: fixture.flush }));
vi.mock('./export/relational-markdown.local-source', () => ({ readLocalRelationalMarkdownSource: fixture.read }));
vi.mock('./export/relational-markdown.service', () => ({ buildRelationalMarkdownEntries: fixture.build }));
import { createProjectionWorker, installMarkdownProjection } from './markdown-projection.service';
import { getMarkdownProjectionStatus } from './markdown-projection-status';
import { events } from '../lib/events';

beforeEach(() => {
  fixture.database = {};
  vi.clearAllMocks();
  fixture.info.mockResolvedValue({ directory: '/synthetic/projection', generatedAt: null, readOnly: true, reverseSync: false });
  fixture.write.mockResolvedValue({ directory: '/synthetic/projection', generatedAt: '2026-10-02T00:00:00Z', readOnly: true, reverseSync: false });
  fixture.read.mockResolvedValue({ books: [{ project: { id: 'synthetic' } }], proseByDocId: new Map() });
  fixture.build.mockResolvedValue({ entries: [{ path: 'README.md', text: 'Read-only' }], documentCount: 1 });
  fixture.flush.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());
describe('Markdown projection scheduling', () => {
  it('automatically captures the mounted project on local and remote changes and stops on database switch', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.read).toHaveBeenCalledWith('synthetic');
      expect(fixture.write).toHaveBeenCalledOnce();
      expect(fixture.flush.mock.invocationCallOrder[0]).toBeLessThan(fixture.read.mock.invocationCallOrder[0]!);
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'ready', readOnly: true, reverseSync: false });
      fixture.committed({ projectId: 'other' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledOnce();
      fixture.committed({ projectId: 'synthetic' });
      events.emit('sync:project-changed', { projectId: 'synthetic', projectionImpact: 'prose-only' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledTimes(2);
      fixture.database = {};
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledTimes(2);
    } finally { dispose(); }
  });

  it('coalesces continuous commits without starving refresh or overlapping captures', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const worker = createProjectionWorker(refresh, () => undefined);
    for (let i = 0; i < 10; i++) { worker.request(); await vi.advanceTimersByTimeAsync(100); }
    expect(refresh).toHaveBeenCalledTimes(1);
    worker.request();
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    worker.dispose();
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('reports failure and allows a later refresh without blocking the author', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const failed = vi.fn();
    const worker = createProjectionWorker(refresh, failed);
    worker.request(); await worker.flush();
    expect(failed).toHaveBeenCalledOnce();
    worker.request(); await worker.flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    worker.dispose();
  });
});
