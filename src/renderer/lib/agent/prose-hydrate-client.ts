/**
 * Client for the prose-hydration worker. Hydrates Yjs blobs → ProseMirror JSON
 * OFF the render thread when possible, so a heavily-edited chapter's hydration no
 * longer freezes the UI mid-review.
 *
 * SELF-VERIFYING + FAIL-SAFE. The first hydration runs both the worker AND the
 * inline (main-thread) path and compares them byte-for-byte. Only if they match
 * does it trust the worker for the rest of the session. On ANY mismatch, worker
 * construction failure, or runtime error, it permanently disables the worker and
 * falls back to inline — i.e. exactly the previous behavior. So shipping this can
 * never regress correctness; worst case it's a no-op that uses the main thread.
 */
import { yDocToProsemirrorJSON } from 'y-prosemirror';
import * as Y from 'yjs';

interface WorkerResponse {
  id: number;
  json?: string;
  error?: string;
}

let worker: Worker | null = null;
let workerDisabled = false;
let verified = false;
let seq = 0;
const pending = new Map<number, { resolve: (s: string) => void; reject: (e: unknown) => void }>();

function disableWorker(reason: string): void {
  if (!workerDisabled) {
    workerDisabled = true;
    console.warn(`[prose-hydrate] worker disabled, using main thread: ${reason}`);
  }
  for (const [, p] of pending) p.reject(new Error(reason));
  pending.clear();
  try {
    worker?.terminate();
  } catch {
    /* ignore */
  }
  worker = null;
}

function ensureWorker(): Worker | null {
  if (workerDisabled) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL('./prose-hydrate.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { id, json, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error !== undefined) p.reject(new Error(error));
      else p.resolve(json ?? '');
    };
    w.onerror = () => disableWorker('worker onerror');
    worker = w;
    return w;
  } catch (err) {
    disableWorker(err instanceof Error ? err.message : 'worker construct failed');
    return null;
  }
}

// Copy exactly a view's logical bytes into a fresh standalone ArrayBuffer. Robust
// where `.slice().buffer` is NOT: a Node Buffer (Uint8Array subclass from the DB/IPC
// layer) slices to a pooled view whose `.buffer` is the whole shared pool — sending
// that yields the wrong byteLength and Yjs decode fails ("Unexpected end of array").
function toTransferable(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

function hydrateInWorker(snapshot: Uint8Array | null, updates: Uint8Array[]): Promise<string> {
  const w = ensureWorker();
  if (!w) return Promise.reject(new Error('worker unavailable'));
  const id = ++seq;
  // Own, exactly-sized copies we can transfer (zero-copy) without detaching the
  // DB-layer blobs (which may be pooled views).
  const snapBuf = snapshot ? toTransferable(snapshot) : null;
  const updBufs = updates.map(toTransferable);
  const transfer = snapBuf ? [snapBuf, ...updBufs] : updBufs;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, snapshot: snapBuf, updates: updBufs }, transfer);
  });
}

async function hydrateInline(snapshot: Uint8Array | null, updates: Uint8Array[]): Promise<string> {
  const doc = new Y.Doc();
  try {
    if (snapshot) Y.applyUpdate(doc, snapshot, 'load');
    for (const u of updates) Y.applyUpdate(doc, u, 'load');
    return JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
  } finally {
    doc.destroy();
  }
}

/**
 * Hydrate Yjs blobs (snapshot + updates) into a ProseMirror JSON string, off the
 * main thread when the worker is available and verified. Always correct: falls
 * back to inline hydration on any worker problem.
 */
export async function hydrateProseJson(
  snapshot: Uint8Array | null,
  updates: Uint8Array[],
): Promise<string> {
  if (workerDisabled) return hydrateInline(snapshot, updates);

  if (!verified) {
    // One-time spike: prove the worker output is byte-identical to inline before
    // we start trusting it. Pays a double hydration exactly once.
    try {
      const [workerJson, inlineJson] = await Promise.all([
        hydrateInWorker(snapshot, updates),
        hydrateInline(snapshot, updates),
      ]);
      if (workerJson === inlineJson) {
        verified = true;
        console.info('[prose-hydrate] worker verified — hydration now runs off the main thread');
        return workerJson;
      }
      disableWorker('worker/inline output mismatch');
      return inlineJson;
    } catch (err) {
      disableWorker(err instanceof Error ? err.message : 'verification failed');
      return hydrateInline(snapshot, updates);
    }
  }

  try {
    return await hydrateInWorker(snapshot, updates);
  } catch {
    disableWorker('worker runtime failure');
    return hydrateInline(snapshot, updates);
  }
}
