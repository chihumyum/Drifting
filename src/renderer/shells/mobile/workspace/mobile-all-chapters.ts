export const MOBILE_ALL_CHAPTERS_LOAD_CONCURRENCY = 6;
export const MOBILE_ALL_CHAPTERS_TAP_DISTANCE_PX = 8;
export const MOBILE_ALL_CHAPTERS_TAP_MAX_MS = 450;

export interface MobileAllChaptersReadPosition {
  outlineId: string | null;
  focusNodeId: string | null;
  caretIntent: 'restore-selection' | null;
}

interface StoredMobileAllChaptersReadPosition extends MobileAllChaptersReadPosition {
  version: 1;
}

export interface MobileAllChaptersPointerSample {
  startX: number;
  startY: number;
  startTime: number;
  clientX: number;
  clientY: number;
  time: number;
}

function storageKey(projectId: string): string {
  return `drifting:mobile-v2:all-chapters:${projectId}`;
}

export function readMobileAllChaptersPosition(
  projectId: string,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): MobileAllChaptersReadPosition | null {
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredMobileAllChaptersReadPosition>;
    if (parsed.version !== 1) return null;
    if (parsed.outlineId !== null && typeof parsed.outlineId !== 'string') return null;
    if (parsed.focusNodeId !== null && typeof parsed.focusNodeId !== 'string') return null;
    if (parsed.caretIntent !== null && parsed.caretIntent !== 'restore-selection') return null;
    return {
      outlineId: parsed.outlineId ?? null,
      focusNodeId: parsed.focusNodeId ?? null,
      caretIntent: parsed.caretIntent ?? null,
    };
  } catch {
    return null;
  }
}

export function writeMobileAllChaptersPosition(
  projectId: string,
  position: MobileAllChaptersReadPosition,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): boolean {
  try {
    const stored: StoredMobileAllChaptersReadPosition = { version: 1, ...position };
    storage.setItem(storageKey(projectId), JSON.stringify(stored));
    return true;
  } catch {
    return false;
  }
}

export function isMobileAllChaptersTap(sample: MobileAllChaptersPointerSample): boolean {
  return (
    Math.hypot(sample.clientX - sample.startX, sample.clientY - sample.startY) <=
      MOBILE_ALL_CHAPTERS_TAP_DISTANCE_PX &&
    sample.time - sample.startTime <= MOBILE_ALL_CHAPTERS_TAP_MAX_MS
  );
}

export function mobileAllChaptersLivePlan(
  chapterIds: readonly string[],
  focusedNodeId: string | null,
): boolean[] {
  let claimed = false;
  return chapterIds.map((nodeId) => {
    if (claimed || nodeId !== focusedNodeId) return false;
    claimed = true;
    return true;
  });
}

/**
 * Deduplicating, bounded loader used by the 100/300-chapter read-through.
 * Rejected reads are removed so a later retry remains possible.
 */
export function createMobileAllChaptersLoader<Key, Value>(
  load: (key: Key) => Promise<Value>,
  concurrency = MOBILE_ALL_CHAPTERS_LOAD_CONCURRENCY,
): (key: Key) => Promise<Value> {
  const limit = Math.max(1, Math.floor(concurrency));
  const cached = new Map<Key, Promise<Value>>();
  const queue: Array<{
    key: Key;
    resolve: (value: Value) => void;
    reject: (reason: unknown) => void;
  }> = [];
  let active = 0;

  const pump = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      active += 1;
      void load(job.key)
        .then(job.resolve, (error) => {
          cached.delete(job.key);
          job.reject(error);
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return (key: Key) => {
    const existing = cached.get(key);
    if (existing) return existing;
    const pending = new Promise<Value>((resolve, reject) => {
      queue.push({ key, resolve, reject });
      pump();
    });
    cached.set(key, pending);
    return pending;
  };
}
