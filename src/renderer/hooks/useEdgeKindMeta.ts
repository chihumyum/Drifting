import { useCallback, useMemo, useState } from 'react';

// Per-project, per-kind metadata. Right now this is just an optional
// color override — the displayed kind name still lives on the edges
// themselves (rename rewrites every edge's `kind` field). Stored in
// localStorage because edge kinds are an interactively-tuned label set
// rather than schema-modeled data; persisting them in the DB would
// require a separate table and migrations for a feature that's purely
// presentational.

const STORAGE_PREFIX = 'drifting:edge-kind-meta';
const STORAGE_VERSION = 1;

export interface EdgeKindMetaEntry {
  color?: string;
}

interface StoredPayload {
  v: number;
  // Sentinel for the kind=null (uncategorized) bucket.
  byKind: Record<string, EdgeKindMetaEntry>;
}

export const UNCATEGORIZED_META_KEY = '__uncategorized__';

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
    if (!parsed || parsed.v !== STORAGE_VERSION || typeof parsed.byKind !== 'object') return {};
    return parsed.byKind;
  } catch {
    return {};
  }
}

function writeMeta(projectId: string, byKind: Record<string, EdgeKindMetaEntry>) {
  const key = storageKey(projectId);
  if (!key) return;
  const payload: StoredPayload = { v: STORAGE_VERSION, byKind };
  localStorage.setItem(key, JSON.stringify(payload));
}

export interface EdgeKindMetaApi {
  // Snapshot keyed by kind (or `UNCATEGORIZED_META_KEY` for null kind).
  meta: Record<string, EdgeKindMetaEntry>;
  setColor: (kind: string | null, color: string) => void;
  clearColor: (kind: string | null) => void;
  // Reassign metadata when a kind is renamed (so the override follows
  // the renamed edges). The caller is still responsible for the bulk
  // `updateEdge` calls that change the actual `kind` field.
  reassign: (oldKind: string | null, newKind: string | null) => void;
  // Drop the entire entry — called after a kind is deleted (all edges
  // of that kind removed).
  remove: (kind: string | null) => void;
}

function keyFor(kind: string | null): string {
  return kind ?? UNCATEGORIZED_META_KEY;
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
    (kind, color) => {
      const k = keyFor(kind);
      const cur = meta[k] ?? {};
      const next = { ...meta, [k]: { ...cur, color } };
      persist(next);
    },
    [meta, persist],
  );

  const clearColor = useCallback<EdgeKindMetaApi['clearColor']>(
    (kind) => {
      const k = keyFor(kind);
      if (!meta[k]) return;
      const next = { ...meta };
      const cur = { ...next[k] };
      delete cur.color;
      if (Object.keys(cur).length === 0) delete next[k];
      else next[k] = cur;
      persist(next);
    },
    [meta, persist],
  );

  const reassign = useCallback<EdgeKindMetaApi['reassign']>(
    (oldKind, newKind) => {
      const a = keyFor(oldKind);
      const b = keyFor(newKind);
      if (a === b) return;
      if (!meta[a]) return;
      const next = { ...meta };
      next[b] = { ...(next[b] ?? {}), ...next[a] };
      delete next[a];
      persist(next);
    },
    [meta, persist],
  );

  const remove = useCallback<EdgeKindMetaApi['remove']>(
    (kind) => {
      const k = keyFor(kind);
      if (!meta[k]) return;
      const next = { ...meta };
      delete next[k];
      persist(next);
    },
    [meta, persist],
  );

  return { meta, setColor, clearColor, reassign, remove };
}
