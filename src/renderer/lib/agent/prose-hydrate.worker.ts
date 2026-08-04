/**
 * Prose-hydration worker. Rebuilding a chapter's Y.Doc (apply snapshot + every
 * update) and converting it to ProseMirror JSON is the single heaviest CPU burst
 * on the render thread during a large closed-document read — and it's an atomic call that
 * cooperative yielding can't split. It's also a PURE transform with serializable
 * I/O (binary blobs in → JSON string out), so it moves cleanly off-thread.
 *
 * Deps are pure JS (yjs + y-prosemirror, no DOM/schema), which is the one thing
 * the spike verifies at runtime (see prose-hydrate-client.ts) before trusting it.
 */
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';

interface HydrateRequest {
  id: number;
  snapshot: ArrayBuffer | null;
  updates: ArrayBuffer[];
}
interface HydrateResponse {
  id: number;
  json?: string;
  error?: string;
}

// Cast around the DOM `self`/`postMessage` typings (this file runs in a worker).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<HydrateRequest>) => void) | null;
  postMessage: (msg: HydrateResponse) => void;
};

ctx.onmessage = (e: MessageEvent<HydrateRequest>) => {
  const { id, snapshot, updates } = e.data;
  const doc = new Y.Doc();
  try {
    if (snapshot) Y.applyUpdate(doc, new Uint8Array(snapshot), 'load');
    for (const u of updates) Y.applyUpdate(doc, new Uint8Array(u), 'load');
    const json = JSON.stringify(yDocToProsemirrorJSON(doc, 'default'));
    ctx.postMessage({ id, json });
  } catch (err) {
    ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    doc.destroy();
  }
};
