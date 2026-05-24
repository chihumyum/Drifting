import { useCallback, useEffect, useState } from 'react';

import type { CommentTargetKind } from '../domain/manuscript-comment';

const STORAGE_PREFIX = 'editor:margin-notes:';

function storageKey(kind: CommentTargetKind, id: string): string {
  return `${STORAGE_PREFIX}${kind}:${id}`;
}

function readInitial(kind: CommentTargetKind, id: string | null | undefined): boolean {
  if (!id) return false;
  try {
    return localStorage.getItem(storageKey(kind, id)) === '1';
  } catch {
    return false;
  }
}

/**
 * Per-entity margin-notes toggle. State lives in localStorage keyed by
 * `(kind, entityId)` so each storyline / category / element / node remembers
 * its own value independently and across page reloads. Device-local on
 * purpose; not synced via preferences-sync.
 */
export function useEntityMarginNotes(
  kind: CommentTargetKind,
  entityId: string | null | undefined,
): [boolean, (on: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => readInitial(kind, entityId));

  useEffect(() => {
    setValue(readInitial(kind, entityId));
  }, [kind, entityId]);

  const update = useCallback(
    (on: boolean) => {
      setValue(on);
      if (!entityId) return;
      try {
        if (on) localStorage.setItem(storageKey(kind, entityId), '1');
        else localStorage.removeItem(storageKey(kind, entityId));
      } catch {
        // Quota / privacy mode — fall back to in-memory only.
      }
    },
    [kind, entityId],
  );

  return [value, update];
}
