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
  // Visible cards occupy dense slots. A hover only changes the interval between
  // the old/new insertion boundaries; it must not walk all mounted cards.
  const cardListeners: Array<Set<() => void> | undefined> = [];
  const publish = (next: StoryGraphDriftDragSnapshot) => {
    if (next === snapshot) return;
    const previous = snapshot;
    snapshot = next;
    const boundaries = new Set([0, cardListeners.length]);
    for (const state of [previous, next]) {
      if (!state.dragged) continue;
      for (const index of [state.dragged.index, state.dragged.index + 1, state.dropIndex ?? state.dragged.index]) {
        boundaries.add(Math.min(index, cardListeners.length));
      }
    }
    const ordered = [...boundaries].sort((a, b) => a - b);
    for (let boundary = 0; boundary < ordered.length - 1; boundary++) {
      const start = ordered[boundary]; const end = ordered[boundary + 1];
      if (cardSnapshot(previous, start) === cardSnapshot(next, start)) continue;
      for (let index = start; index < end; index++) {
        for (const listener of [...(cardListeners[index] ?? [])]) listener();
      }
    }
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => snapshot,
    getCardSnapshot: (index: number) => cardSnapshot(snapshot, index),
    subscribeCard(index: number, listener: () => void) {
      const slot = cardListeners[index] ??= new Set();
      slot.add(listener);
      return () => {
        slot.delete(listener);
        if (slot.size || cardListeners[index] !== slot) return;
        cardListeners[index] = undefined;
        while (cardListeners.length && !cardListeners[cardListeners.length - 1]) cardListeners.pop();
      };
    },
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

function cardSnapshot(snapshot: StoryGraphDriftDragSnapshot, index: number): string {
  return snapshot.dragged?.index === index ? 'dragged' : storyGraphDriftShift(snapshot, index);
}

export function storyGraphDriftShift(snapshot: StoryGraphDriftDragSnapshot, index: number): string {
  if (!snapshot.dragged || snapshot.dropIndex === null || index === snapshot.dragged.index) return '';
  const from = snapshot.dragged.index;
  const to = snapshot.dropIndex;
  if (from < to && index > from && index < to) return `translateX(-${DRIFT_SLOT_WIDTH}px)`;
  if (from > to && index >= to && index < from) return `translateX(${DRIFT_SLOT_WIDTH}px)`;
  return '';
}
