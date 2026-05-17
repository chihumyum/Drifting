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
    return (
      <div className="patches-section p-4">
        <div className="text-sm text-gray-400">加载中...</div>
      </div>
    );
  }

  return (
    <div className="patches-section p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300">补丁 ({patches.length})</h3>
        <button
          type="button"
          onClick={handleAddFloating}
          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200"
        >
          + 新建补丁
        </button>
      </div>
      {patches.length === 0 ? (
        <div className="text-xs text-gray-500 italic">
          尚无补丁。可在章节里用 /patch 创建关联到该章节或某段文字的补丁。
        </div>
      ) : (
        <div className="space-y-2">
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
    </div>
  );
}
