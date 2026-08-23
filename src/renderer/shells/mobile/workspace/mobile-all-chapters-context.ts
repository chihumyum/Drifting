export interface MobileAllChaptersContextSnapshot {
  actName: string | null;
  chapterId: string | null;
  chapterTitle: string | null;
}

const EMPTY: MobileAllChaptersContextSnapshot = {
  actName: null,
  chapterId: null,
  chapterTitle: null,
};
let snapshot = EMPTY;
const listeners = new Set<() => void>();

export function getMobileAllChaptersContext(): MobileAllChaptersContextSnapshot {
  return snapshot;
}

export function subscribeMobileAllChaptersContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishMobileAllChaptersContext(
  next: MobileAllChaptersContextSnapshot | null,
): void {
  const normalized = next ?? EMPTY;
  if (
    snapshot.actName === normalized.actName &&
    snapshot.chapterId === normalized.chapterId &&
    snapshot.chapterTitle === normalized.chapterTitle
  ) {
    return;
  }
  snapshot = normalized;
  listeners.forEach((listener) => listener());
}
