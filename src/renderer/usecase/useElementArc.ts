import { useCallback, useEffect, useMemo, useState } from 'react';
import loglevel from 'loglevel';
import { createElementArcRepository } from '../sqlite-repo/element-arc-repo';
import { deriveElementArc } from '../lib/shadow/arc/derive-arc';
import type { ElementArcJob } from '../domain/element-arc';

const log = loglevel.getLogger('useElementArc');

// Loads the persisted arc row for an element and runs derivation. Status is
// persisted (running → done/failed) so the editor's arc section survives reloads.
// `deriving` tracks the IN-FLIGHT run, distinct from a stale 'running' row left by
// an interrupted session (which the user can simply re-derive over).
export function useElementArc(elementId: string, projectId: string) {
  const repo = useMemo(() => createElementArcRepository(), []);
  const [job, setJob] = useState<ElementArcJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(false);
  const [syncedEl, setSyncedEl] = useState(elementId);

  // Reset when the element changes — adjust-state-DURING-RENDER (the supported React
  // pattern), NOT in the effect, so the set-state-in-effect lint stays happy.
  if (syncedEl !== elementId) {
    setSyncedEl(elementId);
    setJob(null);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const j = await repo.findByElement(elementId);
      if (!cancelled) {
        setJob(j);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, elementId]);

  const derive = useCallback(
    async (includeDrafts: boolean) => {
      setActive(true);
      try {
        const started = await repo.start(projectId, elementId, includeDrafts);
        setJob(started);
        try {
          const arc = await deriveElementArc(elementId, projectId, { includeDrafts });
          setJob(await repo.finish(started.id, arc));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log.error('arc derive failed', e);
          setJob(await repo.fail(started.id, msg));
        }
      } finally {
        setActive(false);
      }
    },
    [repo, elementId, projectId],
  );

  return { job, loading, deriving: active, derive };
}
