import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { describe, expect, it, vi } from 'vitest';
import type { loadPdfRuntime } from '../../lib/pdf-runtime-loader';
import { startPdfPreviewDocument } from './pdf-preview-document';

function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const doc = { numPages: 2 } as PDFDocumentProxy;
  const pending = deferred<PDFDocumentProxy>();
  const destroy = vi.fn(async () => {});
  const task = { promise: pending.promise, destroy } as unknown as PDFDocumentLoadingTask;
  const getDocument = vi.fn(() => task);
  const engine = { getDocument } as unknown as Awaited<ReturnType<typeof loadPdfRuntime>>;
  const readBytes = vi.fn(async () => ({ ok: true as const, bytes: new ArrayBuffer(10) }));
  const loadRuntime = vi.fn(async () => engine);
  const callbacks = { onReady: vi.fn(), onError: vi.fn() };
  const dependencies = { readBytes, loadRuntime };
  return { doc, pending, destroy, getDocument, engine, callbacks, dependencies };
}

describe('PDF preview document ownership across deferred engine loading', () => {
  it('does not load the engine after a preview closes during the native read', async () => {
    const f = fixture(); const read = deferred<{ ok: true; bytes: ArrayBuffer }>();
    f.dependencies.readBytes.mockReturnValue(read.promise);
    const session = startPdfPreviewDocument('synthetic.pdf', f.callbacks, f.dependencies);
    session.dispose(); read.resolve({ ok: true, bytes: new ArrayBuffer(10) }); await session.completion;
    expect(f.dependencies.loadRuntime).not.toHaveBeenCalled(); expect(f.callbacks.onReady).not.toHaveBeenCalled();
  });

  it('does not allocate a PDF worker/task after closing during the module load', async () => {
    const f = fixture(); const loading = deferred<typeof f.engine>(); f.dependencies.loadRuntime.mockReturnValue(loading.promise);
    const session = startPdfPreviewDocument('synthetic.pdf', f.callbacks, f.dependencies);
    await vi.waitFor(() => expect(f.dependencies.loadRuntime).toHaveBeenCalledOnce());
    session.dispose(); loading.resolve(f.engine); await session.completion;
    expect(f.getDocument).not.toHaveBeenCalled(); expect(f.callbacks.onReady).not.toHaveBeenCalled();
  });

  it('destroys once and ignores a document that resolves after close', async () => {
    const f = fixture(); const session = startPdfPreviewDocument('synthetic.pdf', f.callbacks, f.dependencies);
    await vi.waitFor(() => expect(f.getDocument).toHaveBeenCalledOnce());
    session.dispose(); session.dispose(); f.pending.resolve(f.doc); await session.completion;
    expect(f.destroy).toHaveBeenCalledOnce(); expect(f.callbacks.onReady).not.toHaveBeenCalled(); expect(f.callbacks.onError).not.toHaveBeenCalled();
  });

  it('retains a ready document until its preview owner closes', async () => {
    const f = fixture(); const session = startPdfPreviewDocument('synthetic.pdf', f.callbacks, f.dependencies);
    f.pending.resolve(f.doc); await session.completion;
    expect(f.callbacks.onReady).toHaveBeenCalledExactlyOnceWith(f.doc); expect(f.destroy).not.toHaveBeenCalled();
    session.dispose(); session.dispose(); expect(f.destroy).toHaveBeenCalledOnce();
  });

  it('releases a failed loading task before reporting the document error', async () => {
    const f = fixture(); const error = new Error('Synthetic invalid PDF');
    const session = startPdfPreviewDocument('synthetic.pdf', f.callbacks, f.dependencies);
    await vi.waitFor(() => expect(f.getDocument).toHaveBeenCalledOnce());
    f.pending.reject(error); await session.completion;
    expect(f.destroy).toHaveBeenCalledOnce(); expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(error);
    session.dispose(); expect(f.destroy).toHaveBeenCalledOnce();
  });

  it('reports a native read error without loading the PDF engine', async () => {
    const f = fixture(); const readBytes = vi.fn(async () => ({ ok: false as const, error: 'Synthetic read failure' }));
    const session = startPdfPreviewDocument('synthetic.pdf', f.callbacks, { ...f.dependencies, readBytes });
    await session.completion;
    expect(f.dependencies.loadRuntime).not.toHaveBeenCalled(); expect(f.callbacks.onError.mock.calls[0]?.[0].message).toBe('Synthetic read failure');
  });

  it('lets a fresh preview request load again after its loader rejected', async () => {
    const f = fixture(); const error = new Error('Synthetic loader failure'); f.dependencies.loadRuntime.mockRejectedValueOnce(error);
    const first = startPdfPreviewDocument('synthetic.pdf', f.callbacks, f.dependencies); await first.completion; first.dispose();
    expect(f.callbacks.onError).toHaveBeenCalledExactlyOnceWith(error); expect(f.getDocument).not.toHaveBeenCalled();
    const second = startPdfPreviewDocument('synthetic.pdf', f.callbacks, f.dependencies); f.pending.resolve(f.doc); await second.completion;
    expect(f.dependencies.loadRuntime).toHaveBeenCalledTimes(2); expect(f.callbacks.onReady).toHaveBeenCalledOnce(); second.dispose();
  });

  it('keeps replacement previews isolated when an older read fails late', async () => {
    const old = fixture(); const current = fixture(); const read = deferred<{ ok: true; bytes: ArrayBuffer }>(); old.dependencies.readBytes.mockReturnValue(read.promise);
    const first = startPdfPreviewDocument('old.pdf', old.callbacks, old.dependencies); first.dispose();
    const second = startPdfPreviewDocument('current.pdf', current.callbacks, current.dependencies); current.pending.resolve(current.doc); await second.completion;
    read.reject(new Error('Old read failed')); await first.completion;
    expect(old.callbacks.onError).not.toHaveBeenCalled(); expect(old.callbacks.onReady).not.toHaveBeenCalled();
    expect(current.callbacks.onReady).toHaveBeenCalledExactlyOnceWith(current.doc); second.dispose();
  });
});
