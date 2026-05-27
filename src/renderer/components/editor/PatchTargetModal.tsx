import { useEffect, useMemo, useState } from 'react';
import loglevel from 'loglevel';
import { useDataStore } from '../../store/data-store';
import { useBookElement } from '../../usecase/useBookElement';
import { useAuthStore } from '../../store/auth';
import { createElementPatchRepository } from '../../sqlite-repo/element-patch-repo';
import { syncElementPatchCreate } from '../../usecase/sync-helpers';

const log = loglevel.getLogger('PatchTargetModal');
log.setLevel(loglevel.levels.ERROR);

// Where in the current chapter the patch will be anchored. ProjectId is owned
// by the parent (the chapter editor) and passed as a separate prop so this
// component can mount unconditionally without needing a placeholder project.
export interface PatchAnchor {
  sourceNodeId: string;
  sourceBlockId: string | null;
}

interface PatchTargetModalProps {
  projectId: string;
  anchor: PatchAnchor | null;
  onClose: () => void;
  onCreated?: (patchId: string, elementId: string) => void;
}

// Triggered after the user picks /patch in a chapter editor. Lets them choose
// an existing element (or create a new one) as the patch target, then creates
// the patch with the cursor's chapter/block anchor.
export function PatchTargetModal({
  projectId,
  anchor,
  onClose,
  onCreated,
}: PatchTargetModalProps) {
  const { bookElements } = useDataStore();
  const userId = useAuthStore((state) => state.user?.id);
  // userId can briefly be undefined during initial auth load; useBookElement
  // requires a non-empty string, so guard the hook call with a stable fallback.
  // Modal actions early-return when userId is missing.
  const elementUsecases = useBookElement({
    projectId,
    userId: userId ?? '__unauthenticated__',
  });
  const { createElement } = elementUsecases;

  const [query, setQuery] = useState('');

  // Reset state whenever modal reopens
  useEffect(() => {
    if (anchor) setQuery('');
  }, [anchor]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bookElements
      .filter((el) => (q ? el.name.toLowerCase().includes(q) : true))
      .slice(0, 50);
  }, [bookElements, query]);

  const handlePickElement = async (elementId: string) => {
    if (!anchor) return;
    try {
      const repo = createElementPatchRepository();
      const created = await repo.create({
        projectId,
        elementId,
        sourceNodeId: anchor.sourceNodeId,
        sourceBlockId: anchor.sourceBlockId,
      });
      // Push to server — without this the patch would survive locally but
      // get cascade-deleted on the next full hydrate (see sync fix
      // 43db040). enqueue is fire-and-forget; the sync queue handles retry.
      syncElementPatchCreate(created.id, projectId, {
        id: created.id,
        elementId: created.elementId,
        sourceNodeId: created.sourceNodeId,
        sourceBlockId: created.sourceBlockId,
        title: created.title,
        contentJson: created.contentJson,
        orderKey: created.orderKey,
      });
      onCreated?.(created.id, elementId);
      onClose();
    } catch (error) {
      log.error('Failed to create patch:', error);
    }
  };

  const handleCreateAndPick = async () => {
    if (!anchor || !query.trim()) return;
    const categoryId = useDataStore.getState().bookElementCategories[0]?.id;
    if (!categoryId) {
      log.warn('Cannot create element from /patch — project has no element categories');
      return;
    }
    try {
      const created = await createElement({ categoryId, name: query.trim() });
      if (created) {
        await handlePickElement(created.id);
      }
    } catch (error) {
      log.error('Failed to create element from /patch:', error);
    }
  };

  if (!anchor) return null;

  const noExactMatch = query.trim() && !bookElements.some(
    (e) => e.name.toLowerCase() === query.trim().toLowerCase(),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-32 bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-h-[60vh] bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-gray-100">
              {anchor.sourceBlockId ? '为此段添加元素补丁' : '为本章添加元素补丁'}
            </div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              选择目标元素 — 补丁内容稍后在元素页编辑
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-lg leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
        <div className="p-3 space-y-2">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索元素..."
            className="w-full px-2 py-1.5 text-sm bg-gray-800 text-gray-100 rounded border border-gray-700 focus:border-gray-500 focus:outline-none"
          />
          <div className="max-h-72 overflow-y-auto">
            {candidates.length === 0 && !noExactMatch ? (
              <div className="text-xs text-gray-500 italic py-2">没有匹配的元素</div>
            ) : (
              candidates.map((el) => (
                <button
                  key={el.id}
                  type="button"
                  onClick={() => handlePickElement(el.id)}
                  className="w-full text-left px-2 py-1.5 text-sm text-gray-200 hover:bg-gray-800 rounded flex items-center gap-2"
                >
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                    元素
                  </span>
                  <span className="truncate">{el.name}</span>
                </button>
              ))
            )}
            {noExactMatch && (
              <button
                type="button"
                onClick={handleCreateAndPick}
                className="w-full text-left px-2 py-1.5 text-sm text-gray-200 hover:bg-gray-800 rounded flex items-center gap-2 border-t border-gray-800 mt-1"
              >
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                  新建
                </span>
                <span className="truncate">创建元素「{query.trim()}」</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
