import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  database: {} as object,
  composing: false,
  committed: (_event: { projectId: string }) => undefined as void,
  read: vi.fn(), build: vi.fn(), flush: vi.fn(), write: vi.fn(), info: vi.fn(), remove: vi.fn(), setOutputRoot: vi.fn(), setEnabled: vi.fn(), setDefaultRoot: vi.fn(), nameFolder: vi.fn(),
  known: new Map<string, string>(), disposeRenderer: vi.fn(),
  mirror: {
    scan: vi.fn(), prepare: vi.fn(), settle: vi.fn(), relocate: vi.fn(), dispose: vi.fn(),
    exclusive: <T,>(work: () => Promise<T>) => work(),
  },
}));
vi.mock('../platform', () => ({ platform: { markdownProjection: { info: fixture.info, write: fixture.write, remove: fixture.remove, setOutputRoot: fixture.setOutputRoot, setEnabled: fixture.setEnabled, setDefaultRoot: fixture.setDefaultRoot, nameFolder: fixture.nameFolder } } }));
vi.mock('../lib/db', () => ({ getDbIfInitialized: () => fixture.database }));
vi.mock('../lib/active-editor', () => ({ getActiveEditor: () => ({ view: { composing: fixture.composing } }) }));
vi.mock('../sync/journal/authored-transaction', () => ({ onAuthoredChangeCommitted: (callback: typeof fixture.committed) => {
  fixture.committed = callback; return () => { fixture.committed = () => undefined; };
} }));
vi.mock('./yjs-local-durability.service', () => ({ flushAllOpenYjsDocuments: fixture.flush }));
vi.mock('./export/relational-markdown.local-source', () => ({ readLocalRelationalMarkdownSource: fixture.read }));
vi.mock('./markdown-mirror/mirror', () => ({ createMarkdownMirror: () => fixture.mirror }));
vi.mock('./export/markdown-projection-client', () => ({ createMarkdownProjectionRenderer: () => ({
  knownProseVersions: () => fixture.known, render: fixture.build, dispose: fixture.disposeRenderer,
}) }));
import {
  createProjectionWorker, installMarkdownProjection, MIRROR_SCAN_MS, PROJECTION_MAX_WAIT_MS, PROJECTION_QUIET_MS,
  refreshMarkdownProjection, setMarkdownFolderDefaultRoot, setMarkdownFolderEnabled, setMarkdownProjectionOutputRoot,
} from './markdown-projection.service';
import { getMarkdownProjectionStatus } from './markdown-projection-status';
import { flushMarkdownProjections } from './markdown-projection-lifecycle';
import { events } from '../lib/events';
import { useDataStore } from '../store/data-store';
import { useNotificationStore } from '../store/notification-store';

beforeEach(() => {
  fixture.database = {};
  useNotificationStore.setState({ items: [], centerOpen: false });
  fixture.composing = false;
  vi.clearAllMocks();
  fixture.setOutputRoot.mockReset();
  fixture.info.mockResolvedValue({ directory: '/synthetic/projection', generatedAt: null, readOnly: false, reverseSync: true });
  fixture.write.mockResolvedValue({ directory: '/synthetic/projection', generatedAt: '2026-10-02T00:00:00Z', readOnly: false, reverseSync: true });
  fixture.read.mockResolvedValue({ books: [{ project: { id: 'synthetic' } }], proseByDocId: new Map() });
  fixture.build.mockResolvedValue({ entries: [{ path: 'README.md', text: 'Read-only' }], documentCount: 1, assets: [], documents: [] });
  fixture.flush.mockResolvedValue(undefined);
  fixture.mirror.scan.mockResolvedValue({ merged: 0, issues: [] });
  fixture.mirror.prepare.mockResolvedValue({ entries: [], renders: [] });
  fixture.mirror.settle.mockResolvedValue(undefined);
});

afterEach(() => vi.useRealTimers());
describe('Markdown projection scheduling', () => {
  it('defers automatic full-project capture during IME but preserves explicit refresh', async () => {
    vi.useFakeTimers();
    fixture.composing = true;
    const dispose = installMarkdownProjection('synthetic');
    try {
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS + 500);
      expect(fixture.flush).not.toHaveBeenCalled();
      expect(fixture.read).not.toHaveBeenCalled();
      fixture.composing = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledOnce();
      fixture.composing = true;
      await refreshMarkdownProjection('synthetic');
      expect(fixture.write).toHaveBeenCalledTimes(2);
    } finally { await dispose(); }
  });

  it('rechecks composition after asynchronous preparation before capturing the project', async () => {
    vi.useFakeTimers();
    fixture.info.mockImplementationOnce(async () => {
      fixture.composing = true;
      return { directory: '/synthetic/projection', readOnly: false, reverseSync: true };
    });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(2500);
      expect(fixture.flush).not.toHaveBeenCalled();
      expect(fixture.build).not.toHaveBeenCalled();
      fixture.composing = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(fixture.write).toHaveBeenCalledOnce();
    } finally { await dispose(); }
  });
  it('drains an active capture, persists the location, and refreshes there without overlap', async () => {
    vi.useFakeTimers();
    let finishWrite!: () => void;
    fixture.write.mockImplementationOnce(() => new Promise(resolve => {
      finishWrite = () => resolve({ directory: '/synthetic/projection', generatedAt: null, readOnly: false, reverseSync: true, conflicts: [], preserved: [] });
    }));
    const nextInfo = { directory: '/synthetic/custom/markdown-projections/project', customRoot: '/synthetic/custom', generatedAt: null, readOnly: false, reverseSync: true };
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
    } finally { await dispose(); }
  });

  it('keeps automatic refresh working when changing location fails', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      fixture.setOutputRoot.mockRejectedValueOnce(new Error('folder not writable'));
      await expect(setMarkdownProjectionOutputRoot('synthetic', '/synthetic/custom')).rejects.toThrow('folder not writable');
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
      expect(fixture.write).toHaveBeenCalledTimes(2);
      expect(getMarkdownProjectionStatus('synthetic')?.directory).toBe('/synthetic/projection');
    } finally { await dispose(); }
  });

  it('reports a failed regeneration at the new path and allows retry', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      const nextInfo = { directory: '/synthetic/custom/projection', customRoot: '/synthetic/custom', generatedAt: null, readOnly: false, reverseSync: true };
      fixture.setOutputRoot.mockResolvedValue(nextInfo);
      fixture.info.mockResolvedValue(nextInfo);
      fixture.write.mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(nextInfo);
      await expect(setMarkdownProjectionOutputRoot('synthetic', '/synthetic/custom')).rejects.toThrow('disk full');
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ ...nextInfo, state: 'error', error: 'disk full' });
      await refreshMarkdownProjection('synthetic');
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'ready' });
      // Cleared fields are removed: the status reaches durable Agent payloads.
      expect(getMarkdownProjectionStatus('synthetic')).not.toHaveProperty('error');
    } finally { await dispose(); }
  });
  it('automatically captures the mounted project on local and remote changes and stops on database switch', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.read).toHaveBeenCalledWith('synthetic', { knownProseVersions: fixture.known });
      expect(fixture.write).toHaveBeenCalledOnce();
      expect(fixture.flush.mock.invocationCallOrder[0]).toBeLessThan(fixture.read.mock.invocationCallOrder[0]!);
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'ready', readOnly: false, reverseSync: true });
      fixture.committed({ projectId: 'other' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
      expect(fixture.write).toHaveBeenCalledOnce();
      fixture.committed({ projectId: 'synthetic' });
      events.emit('sync:project-changed', { projectId: 'synthetic', projectionImpact: 'prose-only' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
      expect(fixture.write).toHaveBeenCalledTimes(2);
      fixture.database = {};
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
      expect(fixture.write).toHaveBeenCalledTimes(2);
    } finally { await dispose(); }
    expect(fixture.disposeRenderer).toHaveBeenCalledOnce();
  });

  it('waits for the author to pause, without starving a continuous writer or overlapping captures', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const refresh = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const worker = createProjectionWorker(refresh, () => undefined);
    // Typing: each commit pushes the capture back.
    for (let i = 0; i < 10; i++) { worker.request(); await vi.advanceTimersByTimeAsync(500); }
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS - 500);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A commit during the capture waits for it, then for a pause.
    worker.request();
    await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    // Never pausing: the capture still runs once the oldest change has waited the maximum.
    const started = Date.now();
    while (refresh.mock.calls.length === 2 && Date.now() - started < PROJECTION_MAX_WAIT_MS * 2) {
      worker.request();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeLessThanOrEqual(PROJECTION_MAX_WAIT_MS + 500);
    worker.dispose();
    release();
    await vi.advanceTimersByTimeAsync(PROJECTION_MAX_WAIT_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
  it('publishes what was written since the last capture when the project closes, then releases it', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.write).toHaveBeenCalledOnce();
    fixture.committed({ projectId: 'synthetic' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixture.write).toHaveBeenCalledOnce();
    await dispose();
    expect(fixture.write).toHaveBeenCalledTimes(2);
    expect(fixture.disposeRenderer).toHaveBeenCalledOnce();
    fixture.committed({ projectId: 'synthetic' });
    await vi.advanceTimersByTimeAsync(PROJECTION_MAX_WAIT_MS);
    expect(fixture.write).toHaveBeenCalledTimes(2);
    // A project closed with nothing pending publishes nothing more.
    const reopened = installMarkdownProjection('synthetic');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.write).toHaveBeenCalledTimes(3);
    await reopened();
    expect(fixture.write).toHaveBeenCalledTimes(3);
    // The last keystroke's save lands only while the editors unmount.
    const third = installMarkdownProjection('synthetic');
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.write).toHaveBeenCalledTimes(4);
    fixture.flush.mockImplementationOnce(async () => { fixture.committed({ projectId: 'synthetic' }); });
    await third();
    expect(fixture.write).toHaveBeenCalledTimes(5);
  });

  it('starts a reopened project only after its closing capture published', async () => {
    vi.useFakeTimers();
    const first = installMarkdownProjection('synthetic');
    await vi.advanceTimersByTimeAsync(0);
    let finish!: () => void;
    fixture.write.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ directory: '/synthetic/projection', generatedAt: '2026-10-02T00:00:01Z', readOnly: false, reverseSync: true });
    }));
    fixture.committed({ projectId: 'synthetic' });
    const closing = first();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.write).toHaveBeenCalledTimes(2);
    const second = installMarkdownProjection('synthetic');
    await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
    expect(fixture.read).toHaveBeenCalledTimes(2);
    finish();
    await closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.read).toHaveBeenCalledTimes(3);
    expect(fixture.write).toHaveBeenCalledTimes(3);
    await second();
  });

  it('captures pending changes before quitting without waiting for a pause, and nothing when current', async () => {
    vi.useFakeTimers();
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      await flushMarkdownProjections();
      expect(fixture.write).toHaveBeenCalledOnce();
      fixture.committed({ projectId: 'synthetic' });
      await flushMarkdownProjections();
      expect(fixture.write).toHaveBeenCalledTimes(2);
      // A failed capture is retried on quit even with nothing new written.
      fixture.write.mockRejectedValueOnce(new Error('disk full'));
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
      expect(fixture.write).toHaveBeenCalledTimes(3);
      await flushMarkdownProjections();
      expect(fixture.write).toHaveBeenCalledTimes(4);
    } finally { await dispose(); }
  });

  it('merges edited files first, writes authored files guarded, and retries a conflict', async () => {
    vi.useFakeTimers();
    useDataStore.setState({ bookNodes: [{ id: 'c2', projectId: 'synthetic', title: '晨雾' }] } as never);
    const order: string[] = [];
    fixture.mirror.scan.mockImplementation(async (_directory: string, options: { force?: boolean }) => {
      order.push(`scan:${options.force ? 'force' : 'stat'}`);
      return { merged: 0, issues: [{ path: '正文/002 晨雾.md', reason: 'frontmatter', docId: 'node-content:c2' }] };
    });
    fixture.read.mockImplementation(async () => { order.push('capture'); return { books: [{ project: { id: 'synthetic' } }], proseByDocId: new Map() }; });
    fixture.build.mockResolvedValue({
      entries: [{ path: '开始阅读.md', text: 'home' }, { path: '正文/001 雨夜.md', text: 'generated' }],
      documentCount: 2, assets: [], documents: [{ key: 'node:c1', path: '正文/001 雨夜.md', title: '雨夜', anchor: null, sourceVersion: null }],
    });
    const authored = { path: '正文/001 雨夜.md', text: 'authored', authored: true, expectedSha256: 'a'.repeat(64) };
    fixture.mirror.prepare.mockResolvedValue({ entries: [authored], renders: [{ docId: 'node-content:c1' }] });
    fixture.write
      .mockResolvedValueOnce({ directory: '/synthetic/projection', generatedAt: 'one', readOnly: false, reverseSync: true, conflicts: ['正文/001 雨夜.md'], preserved: [] })
      .mockResolvedValue({ directory: '/synthetic/projection', generatedAt: 'two', readOnly: false, reverseSync: true, conflicts: [], preserved: ['正文/003 旧稿.md'] });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(['scan:force', 'capture']);
      expect(fixture.write.mock.calls[0]![2]).toEqual([{ path: '开始阅读.md', text: 'home' }, authored]);
      expect(fixture.mirror.settle).toHaveBeenCalledWith([{ docId: 'node-content:c1' }], '/synthetic/projection', expect.objectContaining({ conflicts: ['正文/001 雨夜.md'] }));
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ mirrorIssues: [{ path: '正文/002 晨雾.md', reason: 'frontmatter' }] });
      expect(useNotificationStore.getState().items.filter(item => item.source === 'markdown-folder')).toMatchObject([{
        id: 'markdown-folder:synthetic:正文/002 晨雾.md', state: 'failed', title: '晨雾',
        target: { projectId: 'synthetic', entityType: 'node', id: 'c2' },
      }]);
      // The conflicted file is merged and written on the next pass.
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
      // Polling scans run meanwhile; the capture still scans right before it reads.
      expect(order.filter(step => step === 'capture')).toHaveLength(2);
      expect(order.slice(-2)).toEqual(['scan:stat', 'capture']);
      expect(fixture.write).toHaveBeenCalledTimes(2);
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ preserved: ['正文/003 旧稿.md'], reverseSync: true });
      const folder = useNotificationStore.getState().items.filter(item => item.source === 'markdown-folder');
      // Notified once, not on every scan; the preserved copy is its own row.
      expect(folder.map(item => item.state)).toEqual(['completed', 'failed']);
      expect(folder[0]).toMatchObject({ outcome: 'issues' });
    } finally { await dispose(); }
  });

  it('looks for edits made elsewhere only while the window is visible', async () => {
    vi.useFakeTimers();
    let visibility = 'visible';
    vi.stubGlobal('document', { get visibilityState() { return visibility; } });
    fixture.mirror.scan.mockResolvedValue({ merged: 0, issues: [] });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.mirror.scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(MIRROR_SCAN_MS);
      expect(fixture.mirror.scan).toHaveBeenCalledTimes(2);
      visibility = 'hidden';
      await vi.advanceTimersByTimeAsync(MIRROR_SCAN_MS * 3);
      expect(fixture.mirror.scan).toHaveBeenCalledTimes(2);
      // A merged edit schedules the write-back like any authored change.
      visibility = 'visible';
      fixture.mirror.scan.mockResolvedValueOnce({ merged: 1, issues: [] });
      await vi.advanceTimersByTimeAsync(MIRROR_SCAN_MS);
      expect(fixture.write).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS);
      expect(fixture.write).toHaveBeenCalledTimes(2);
    } finally {
      await dispose();
      vi.unstubAllGlobals();
    }
  });

  it('neither scans nor writes while no location is chosen, then captures once one is', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const info = { customRoot: null, generatedAt: null, readOnly: false, reverseSync: true, enabled: true };
    fixture.info.mockResolvedValue({ ...info, directory: null });
    fixture.setDefaultRoot.mockImplementation(async (location: string) => {
      fixture.info.mockResolvedValue({ ...info, directory: `${location}/markdown-projections/project` });
      return { directory: `${location}/markdown-projections`, root: location, enabled: true };
    });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'unset', directory: null });
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS + MIRROR_SCAN_MS * 3);
      expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.mirror.scan).not.toHaveBeenCalled();
      await setMarkdownFolderDefaultRoot('/synthetic/chosen');
      expect(fixture.setDefaultRoot).toHaveBeenCalledWith('/synthetic/chosen');
      expect(fixture.write).toHaveBeenCalledOnce();
      expect(fixture.mirror.scan).toHaveBeenLastCalledWith('/synthetic/chosen/markdown-projections/project', { force: true });
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'ready' });
    } finally {
      await dispose();
      vi.unstubAllGlobals();
    }
  });

  it('captures pending work before the folder is turned off, then neither scans nor writes until it is back on', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { visibilityState: 'visible' });
    const info = { directory: '/synthetic/projection', customRoot: null, generatedAt: null, readOnly: false, reverseSync: true };
    fixture.info.mockResolvedValue({ ...info, enabled: true });
    fixture.setEnabled.mockImplementation(async (enabled: boolean) => {
      fixture.info.mockResolvedValue({ ...info, enabled });
      return { directory: '/synthetic', customRoot: null, enabled };
    });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.write).toHaveBeenCalledOnce();
      fixture.committed({ projectId: 'synthetic' });
      await setMarkdownFolderEnabled(false);
      // What was written since the last capture reached the folder first.
      expect(fixture.write).toHaveBeenCalledTimes(2);
      expect(fixture.write.mock.invocationCallOrder[1]).toBeLessThan(fixture.setEnabled.mock.invocationCallOrder[0]!);
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'off', enabled: false });
      const scans = fixture.mirror.scan.mock.calls.length;
      fixture.committed({ projectId: 'synthetic' });
      await vi.advanceTimersByTimeAsync(PROJECTION_QUIET_MS + MIRROR_SCAN_MS * 3);
      expect(fixture.write).toHaveBeenCalledTimes(2);
      expect(fixture.mirror.scan).toHaveBeenCalledTimes(scans);
      await setMarkdownFolderEnabled(true);
      expect(fixture.write).toHaveBeenCalledTimes(3);
      // Every file is hashed again, so edits made there meanwhile merge.
      expect(fixture.mirror.scan).toHaveBeenLastCalledWith('/synthetic/projection', { force: true });
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'ready', enabled: true });
    } finally {
      await dispose();
      vi.unstubAllGlobals();
    }
  });

  it('names the folder after the book before writing, and moves the ledger with a renamed folder', async () => {
    vi.useFakeTimers();
    const old = '/synthetic/markdown-projections/old-name';
    const named = '/synthetic/markdown-projections/潮汐灯塔-北岬';
    fixture.info.mockResolvedValue({ directory: old, customRoot: null, generatedAt: null, readOnly: false, reverseSync: true, enabled: true });
    fixture.read.mockResolvedValue({ books: [{ project: { id: 'synthetic', name: '潮汐灯塔/北岬' } }], proseByDocId: new Map() });
    fixture.nameFolder.mockResolvedValue({ directory: named, customRoot: null, generatedAt: null, readOnly: false, reverseSync: true, enabled: true, previousDirectory: old });
    fixture.write.mockResolvedValue({ directory: named, generatedAt: 'now', readOnly: false, reverseSync: true, enabled: true, conflicts: [], preserved: [] });
    const dispose = installMarkdownProjection('synthetic');
    try {
      await vi.advanceTimersByTimeAsync(0);
      // Scanned where the files were, then named with the file-name rules.
      expect(fixture.mirror.scan).toHaveBeenCalledWith(old, { force: true });
      expect(fixture.nameFolder).toHaveBeenCalledWith('synthetic', '潮汐灯塔-北岬');
      expect(fixture.mirror.relocate).toHaveBeenCalledWith(old, named);
      expect(fixture.mirror.relocate.mock.invocationCallOrder[0]).toBeLessThan(fixture.mirror.prepare.mock.invocationCallOrder[0]!);
      expect(fixture.mirror.prepare).toHaveBeenCalledWith(expect.anything(), [], named);
      expect(fixture.mirror.settle).toHaveBeenCalledWith([], named, expect.anything());
      expect(getMarkdownProjectionStatus('synthetic')).toMatchObject({ state: 'ready', directory: named });
      expect(getMarkdownProjectionStatus('synthetic')).not.toHaveProperty('previousDirectory');
      // An unchanged name moves nothing.
      fixture.nameFolder.mockResolvedValue({ directory: named, customRoot: null, generatedAt: 'now', readOnly: false, reverseSync: true, enabled: true, previousDirectory: null });
      await refreshMarkdownProjection('synthetic');
      expect(fixture.mirror.relocate).toHaveBeenCalledOnce();
    } finally { await dispose(); }
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
