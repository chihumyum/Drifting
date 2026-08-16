import { useCallback, useMemo, useState } from 'react';

// Per-project, per-relation-type presentation metadata. Semantic identity
// stays in SQLite; this localStorage record only stores optional UI color.

const STORAGE_PREFIX = 'drifting:edge-kind-meta';
const STORAGE_VERSION = 2;

export interface EdgeKindMetaEntry {
  color?: string;
}

interface StoredPayload {
  v: number;
  byRelationTypeId: Record<string, EdgeKindMetaEntry>;
}

function storageKey(projectId: string | null | undefined) {
  return projectId ? `${STORAGE_PREFIX}:${projectId}` : null;
}

function readMeta(projectId: string | null | undefined): Record<string, EdgeKindMetaEntry> {
  const key = storageKey(projectId);
  if (!key || typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredPayload;
    if (
      !parsed ||
      parsed.v !== STORAGE_VERSION ||
      typeof parsed.byRelationTypeId !== 'object'
    ) {
      return {};
    }
    return parsed.byRelationTypeId;
  } catch {
    return {};
  }
}

function writeMeta(
  projectId: string,
  byRelationTypeId: Record<string, EdgeKindMetaEntry>,
) {
  const key = storageKey(projectId);
  if (!key) return;
  const payload: StoredPayload = { v: STORAGE_VERSION, byRelationTypeId };
  localStorage.setItem(key, JSON.stringify(payload));
}

export interface EdgeKindMetaApi {
  // Snapshot keyed only by authoritative relation type id.
  meta: Record<string, EdgeKindMetaEntry>;
  setColor: (relationTypeId: string, color: string) => void;
  clearColor: (relationTypeId: string) => void;
  remove: (relationTypeId: string) => void;
}

export function useEdgeKindMeta(projectId: string | null | undefined): EdgeKindMetaApi {
  // Same shape as useTimelineMarkers: re-read on every render after a
  // bump so we don't have to mirror localStorage state in React.
  const [bump, setBump] = useState(0);
  const meta = useMemo(() => {
    void bump;
    return readMeta(projectId);
  }, [projectId, bump]);

  const persist = useCallback(
    (next: Record<string, EdgeKindMetaEntry>) => {
      if (!projectId) return;
      writeMeta(projectId, next);
      setBump((n) => n + 1);
    },
    [projectId],
  );

  const setColor = useCallback<EdgeKindMetaApi['setColor']>(
    (relationTypeId, color) => {
      const cur = meta[relationTypeId] ?? {};
      const next = { ...meta, [relationTypeId]: { ...cur, color } };
      persist(next);
    },
    [meta, persist],
  );

  const clearColor = useCallback<EdgeKindMetaApi['clearColor']>(
    (relationTypeId) => {
      if (!meta[relationTypeId]) return;
      const next = { ...meta };
      const cur = { ...next[relationTypeId] };
      delete cur.color;
      if (Object.keys(cur).length === 0) delete next[relationTypeId];
      else next[relationTypeId] = cur;
      persist(next);
    },
    [meta, persist],
  );

  const remove = useCallback<EdgeKindMetaApi['remove']>(
    (relationTypeId) => {
      if (!meta[relationTypeId]) return;
      const next = { ...meta };
      delete next[relationTypeId];
      persist(next);
    },
    [meta, persist],
  );

  return { meta, setColor, clearColor, remove };
}
