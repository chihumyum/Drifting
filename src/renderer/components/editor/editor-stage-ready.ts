/**
 * The editor stage has, for the first time since the book opened, the surface
 * it wants in front with that surface's content: the book is ready to be seen.
 * EditorMainArea announces it once per mount; the desktop workspace waits for
 * it before it comes out from under the opening wait, and the background work
 * a project starts on opening waits for it before it touches the database.
 */
const listeners = new Set<() => void>();
let stageReady = false;

/** A book begins to open: its stage has shown nothing yet. */
export function resetEditorStageReady(): void {
  stageReady = false;
}

export function announceEditorStageReady(): void {
  stageReady = true;
  listeners.forEach((listener) => listener());
}

export function onEditorStageReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// After the stage is ready, background work waits this much longer, so the
// page in front finishes its own first work (outline, decorations, links).
const STAGE_SETTLE_MS = 250;

/**
 * Runs `work` once the stage of the book now opening has shown its first page
 * and settled, or `limitMs` after the call at most (0: at once, for shells
 * without the stage). The returned function cancels it.
 */
export function afterEditorStageReady(work: () => void, limitMs: number): () => void {
  let done = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const run = () => {
    if (done) return;
    done = true;
    stop();
    clearTimeout(limit);
    clearTimeout(settle);
    work();
  };
  const limit = setTimeout(run, limitMs);
  const ready = () => {
    stop();
    settle = setTimeout(run, STAGE_SETTLE_MS);
  };
  if (stageReady) ready();
  else stop = onEditorStageReady(ready);
  return () => {
    done = true;
    stop();
    clearTimeout(limit);
    clearTimeout(settle);
  };
}
