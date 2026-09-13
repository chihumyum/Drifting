export interface StoryGraphDriftDragSnapshot {
  readonly dragged: { readonly id: string; readonly index: number } | null;
  readonly dropIndex: number | null;
}

const EMPTY: StoryGraphDriftDragSnapshot = Object.freeze({ dragged: null, dropIndex: null });
const DRIFT_SLOT_WIDTH = 168 + 10;

/** Per-view presentation state. Cards and their viewport edge layer subscribe;
 * the shell reads the latest source only when committing a marker drop.
 * No persistent ordering axis exists for drift nodes. */
export function createStoryGraphDriftDrag() {
  let snapshot = EMPTY;
  const listeners = new Set<() => void>();
  const publish = (next: StoryGraphDriftDragSnapshot) => {
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start(id: string, index: number) {
      if (!id || !Number.isSafeInteger(index) || index < 0) return;
      if (snapshot.dragged?.id === id && snapshot.dragged.index === index && snapshot.dropIndex === index) return;
      publish(Object.freeze({ dragged: Object.freeze({ id, index }), dropIndex: index }));
    },
    hover(dropIndex: number) {
      if (!snapshot.dragged || !Number.isSafeInteger(dropIndex) || dropIndex < 0 || snapshot.dropIndex === dropIndex) return;
      publish(Object.freeze({ dragged: snapshot.dragged, dropIndex }));
    },
    cancel() { publish(EMPTY); },
  };
}

export type StoryGraphDriftDrag = ReturnType<typeof createStoryGraphDriftDrag>;

export function storyGraphDriftShift(snapshot: StoryGraphDriftDragSnapshot, index: number): string {
  if (!snapshot.dragged || snapshot.dropIndex === null || index === snapshot.dragged.index) return '';
  const from = snapshot.dragged.index;
  const to = snapshot.dropIndex;
  if (from < to && index > from && index < to) return `translateX(-${DRIFT_SLOT_WIDTH}px)`;
  if (from > to && index >= to && index < from) return `translateX(${DRIFT_SLOT_WIDTH}px)`;
  return '';
}
