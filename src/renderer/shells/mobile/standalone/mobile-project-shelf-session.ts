export type MobileProjectShelfView = 'pager' | 'overview';
export type MobileProjectShelfFilter = 'all' | 'active' | 'paused';

export interface MobileProjectShelfSession {
  view: MobileProjectShelfView;
  focusedProjectId: string | null;
  overviewScrollTop: number;
  filter: MobileProjectShelfFilter;
  query: string;
}

interface ShelfSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MOBILE_PROJECT_SHELF_SESSION_KEY = 'drifting:mobile-project-shelf-session:v1';

export const DEFAULT_MOBILE_PROJECT_SHELF_SESSION: MobileProjectShelfSession = {
  view: 'pager',
  focusedProjectId: null,
  overviewScrollTop: 0,
  filter: 'all',
  query: '',
};

function browserSessionStorage(): ShelfSessionStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function normalizeSession(value: unknown): MobileProjectShelfSession {
  if (!value || typeof value !== 'object') return { ...DEFAULT_MOBILE_PROJECT_SHELF_SESSION };
  const candidate = value as Partial<MobileProjectShelfSession>;
  return {
    view: candidate.view === 'overview' ? 'overview' : 'pager',
    focusedProjectId:
      typeof candidate.focusedProjectId === 'string' && candidate.focusedProjectId.length > 0
        ? candidate.focusedProjectId
        : null,
    overviewScrollTop:
      typeof candidate.overviewScrollTop === 'number' &&
      Number.isFinite(candidate.overviewScrollTop) &&
      candidate.overviewScrollTop >= 0
        ? candidate.overviewScrollTop
        : 0,
    filter:
      candidate.filter === 'active' || candidate.filter === 'paused' ? candidate.filter : 'all',
    query: typeof candidate.query === 'string' ? candidate.query.slice(0, 256) : '',
  };
}

export function readMobileProjectShelfSession(
  storage: ShelfSessionStorage | null = browserSessionStorage(),
): MobileProjectShelfSession {
  if (!storage) return { ...DEFAULT_MOBILE_PROJECT_SHELF_SESSION };
  try {
    const raw = storage.getItem(MOBILE_PROJECT_SHELF_SESSION_KEY);
    return raw ? normalizeSession(JSON.parse(raw)) : { ...DEFAULT_MOBILE_PROJECT_SHELF_SESSION };
  } catch {
    return { ...DEFAULT_MOBILE_PROJECT_SHELF_SESSION };
  }
}

export function updateMobileProjectShelfSession(
  patch: Partial<MobileProjectShelfSession>,
  storage: ShelfSessionStorage | null = browserSessionStorage(),
): MobileProjectShelfSession {
  const next = normalizeSession({ ...readMobileProjectShelfSession(storage), ...patch });
  if (storage) {
    try {
      storage.setItem(MOBILE_PROJECT_SHELF_SESSION_KEY, JSON.stringify(next));
    } catch {
      // Navigation remains usable when WebView session storage is unavailable.
    }
  }
  return next;
}
