/**
 * The editor stage has, for the first time since it mounted, the surface it
 * wants in front with that surface's content: a book that was opening is now
 * ready to be seen. EditorMainArea announces it once per mount; the desktop
 * workspace waits for it before it comes out from under the opening wait.
 */
const listeners = new Set<() => void>();

export function announceEditorStageReady(): void {
  listeners.forEach((listener) => listener());
}

export function onEditorStageReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
