import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  database: {} as object,
  composing: false,
  committed: (_event: { projectId: string }) => undefined as void,
  read: vi.fn(), build: vi.fn(), flush: vi.fn(), write: vi.fn(), info: vi.fn(), remove: vi.fn(), setOutputRoot: vi.fn(),
}));
vi.mock('../platform', () => ({ platform: { markdownProjection: { info: fixture.info, write: fixture.write, remove: fixture.remove, setOutputRoot: fixture.setOutputRoot } } }));
vi.mock('../lib/db', () => ({ getDbIfInitialized: () => fixture.database }));
vi.mock('../lib/active-editor', () => ({ getActiveEditor: () => ({ view: { composing: fixture.composing } }) }));
vi.mock('../sync/journal/authored-transaction', () => ({ onAuthoredChangeCommitted: (callback: typeof fixture.committed) => {
  fixture.committed = callback; return () => { fixture.committed = () => undefined; };
} }));
vi.mock('./yjs-local-durability.service', () => ({ flushAllOpenYjsDocuments: fixture.flush }));
vi.mock('./export/relational-markdown.local-source', () => ({ readLocalRelationalMarkdownSource: fixture.read }));
vi.mock('./export/relational-markdown.service', () => ({ buildRelationalMarkdownEntries: fixture.build }));
import { createProjectionWorker, installMarkdownProjection, refreshMarkdownProjection, setMarkdownProjectionOutputRoot } from './markdown-projection.service';
import { getMarkdownProjectionStatus } from './markdown-projection-status';
import { events } from '../lib/events';

beforeEach(() => {
  fixture.database = {};
  fixture.composing = false;
  vi.clearAllMocks();
  fixture.setOutputRoot.mockReset();
  fixture.info.mockResolvedValue({ directory: '/synthetic/projection', generatedAt: null, readOnly: true, reverseSync: false });
  fixture.write.mockResolvedValue({ directory: '/synthetic/projection', generatedAt: '2026-10-02T00:00:00Z', readOnly: true, reverseSync: false });
  fixture.read.mockResolvedValue({ books: [{ project: { id: 'synthetic' } }], proseByDocId: new Map() });
  fixture.build.mockResolvedValue({ entries: [{ path: 'README.md', text: 'Read-only' }], documentCount: 1 });
  fixture.flush.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());
describe('Markdown projection scheduling', () => {
  it('defers automatic full-project capture during IME but preserves explicit refresh', async () => {
    vi.useFakeTimers();
    fixture.composing = true;
    const dispose = installMarkdownProjection('synthetic');
    try {
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(3500);
      expect(fixture.flush).not.toHaveBeenCalled();
      expect(fixture.read).not.toHaveBeenCalled();
      fixture.composing = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledOnce();
      fixture.composing = true;
      await refreshMarkdownProjection('synthetic');
      expect(fixture.write).toHaveBeenCalledTimes(2);
    } finally { dispose(); }
  });

  it('rechecks composition after asynchronous preparation before capturing the project', async () => {
    vi.useFakeTimers();
    fixture.info.mockImplementationOnce(async () => {
      fixture.composing = true;
      return { directory: '/synthetic/projection', readOnly: true, reverseSync: false };
    });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(2500);
      expect(fixture.flush).not.toHaveBeenCalled();
      expect(fixture.build).not.toHaveBeenCalled();
      fixture.composing = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledOnce();
    } finally { dispose(); }
  });
  it('drains an active capture, persists the location, and refreshes there without overlap', async () => {
    vi.useFakeTimers();
    let finishWrite!: () => void;
    fixture.write.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    const nextInfo = { directory: '/synthetic/custom/markdown-projections/project', customRoot: '/synthetic/custom', generatedAt: null, readOnly: true, reverseSync: false };
    fixture.setOutputRoot.mockImplementation(async () => {
      fixture.info.mockResolvedValue(nextInfo);
      fixture.write.mockResolvedValue({ ...nextInfo, generatedAt: '2026-10-03T00:00:00Z' });
      return nextInfo;
    });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      const changing = setMarkdownProjectionOutputRoot('synthetic', '/synthetic/custom');
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(fixture.setOutputRoot).not.toHaveBeenCalled();
      expect(fixture.write).toHaveBeenCalledTimes(1);
      finishWrite();
      await changing;
      expect(fixture.setOutputRoot).toHaveBeenCalledWith('synthetic', '/synthetic/custom');
      expect(fixture.write).toHaveBeenCalledTimes(2);
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ ...nextInfo, generatedAt: '2026-10-03T00:00:00Z', state: 'ready' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(fixture.write).toHaveBeenCalledTimes(2);
    } finally { dispose(); }
  });

  it('keeps automatic refresh working when changing location fails', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      fixture.setOutputRoot.mockRejectedValueOnce(new Error('folder not writable'));
      await expect(setMarkdownProjectionOutputRoot('synthetic', '/synthetic/custom')).rejects.toThrow('folder not writable');
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledTimes(2);
      expect(getMarkdownProjectionStatus('synthetic')?.directory).toBe('/synthetic/projection');
    } finally { dispose(); }
  });

  it('reports a failed regeneration at the new path and allows retry', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      const nextInfo = { directory: '/synthetic/custom/projection', customRoot: '/synthetic/custom', generatedAt: null, readOnly: true, reverseSync: false };
      fixture.setOutputRoot.mockResolvedValue(nextInfo);
      fixture.info.mockResolvedValue(nextInfo);
      fixture.write.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(nextInfo);
      await expect(setMarkdownProjectionOutputRoot('synthetic', '/synthetic/custom')).rejects.toThrow('disk full');
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ ...nextInfo, state: 'error', error: 'disk full' });
      await refreshMarkdownProjection('synthetic');
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'ready', error: undefined });
    } finally { dispose(); }
  });
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
