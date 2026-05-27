import { useCallback, useEffect, useState } from 'react';

import type { CommentTargetKind } from '../domain/manuscript-comment';
import { events } from '../lib/events';

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

  // Listen for Copilot suggesting on this exact (kind, id) — auto-open the
  // rail so the user actually sees what was created. Respects the toggle
  // immediately afterwards; if user re-closes, a future copilot persist
  // will re-open. Cheap heuristic: nudging is preferred to silent writes.
  useEffect(() => {
    if (!entityId) return;
    const handler = (payload: { targetKind: string; targetId: string }) => {
      if (payload.targetKind !== kind || payload.targetId !== entityId) return;
      update(true);
    };
    events.on('copilot:suggestion-persisted', handler);
    return () => events.off('copilot:suggestion-persisted', handler);
  }, [kind, entityId, update]);

  return [value, update];
}
