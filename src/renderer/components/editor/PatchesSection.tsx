import { useCallback, useEffect, useState } from 'react';
import loglevel from 'loglevel';
import {
  createElementPatchRepository,
  type PatchWithSourceTitle,
} from '../../sqlite-repo/element-patch-repo';
import { PatchEditorCard } from './PatchEditorCard';

const log = loglevel.getLogger('PatchesSection');
log.setLevel(loglevel.levels.ERROR);

interface PatchesSectionProps {
  elementId: string;
  projectId: string;
}

// Renders the patches list for one element and offers a "+ 新建补丁" button
// that creates a floating patch (no chapter affiliation). Chapter-anchored
// patches are created from the chapter side via the /patch slash command.
export function PatchesSection({ elementId, projectId }: PatchesSectionProps) {
  const [patches, setPatches] = useState<PatchWithSourceTitle[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const repo = createElementPatchRepository();
      const list = await repo.listByElement(elementId);
      setPatches(list);
    } catch (error) {
      log.error('Failed to load patches:', error);
    } finally {
      setLoading(false);
    }
  }, [elementId]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  const handleAddFloating = useCallback(async () => {
    try {
      const repo = createElementPatchRepository();
      await repo.create({ projectId, elementId });
      void reload();
    } catch (error) {
      log.error('Failed to create floating patch:', error);
    }
  }, [elementId, projectId, reload]);

  if (loading) {
    return <div className="refs-loading">加载中…</div>;
  }

  return (
    <section className="refs-section patches-section">
      <div className="refs-section__header">
        <span className="refs-section__num">六</span>
        <span className="refs-section__title">补丁</span>
        <span className="refs-section__count">{patches.length}</span>
        <button type="button" onClick={handleAddFloating} className="refs-section__action">
          ＋ 新建
        </button>
      </div>
      {patches.length === 0 ? (
        <div className="refs-empty">
          — 尚无补丁。在章节里用 /patch 可创建关联到此元素的批注 —
        </div>
      ) : (
        <div>
          {patches.map((patch) => (
            <PatchEditorCard
              key={patch.id}
              patch={patch}
              projectId={projectId}
              onChange={reload}
              onDelete={reload}
            />
          ))}
        </div>
      )}
    </section>
  );
}
