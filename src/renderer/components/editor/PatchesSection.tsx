import { useCallback, useEffect, useMemo, useState } from 'react';
import loglevel from 'loglevel';
import {
  createElementPatchRepository,
  type PatchWithSourceTitle,
} from '../../sqlite-repo/element-patch-repo';
import { syncElementPatchCreate } from '../../usecase/sync-helpers';
import { eventBus } from '../../lib/events';
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../../lib/agent/tool-entity-ref';
import { PatchEditorCard } from './PatchEditorCard';

const log = loglevel.getLogger('PatchesSection');
log.setLevel(loglevel.levels.ERROR);

interface PatchesSectionProps {
  elementId: string;
  projectId: string;
}

// Renders the patches list for one element and offers a "+ 新建补丁" button
// that creates a floating patch (no chapter affiliation). Chapter-anchored
// patches are created from the chapter side: select text → 右键「新建补丁」.
export function PatchesSection({ elementId, projectId }: PatchesSectionProps) {
  const [patches, setPatches] = useState<PatchWithSourceTitle[]>([]);
  const [loading, setLoading] = useState(true);
  // Pending agent review op per patch, used to KEY each card: when the op changes
  // (e.g. an agent UPDATE records a 'changed' review, or it resolves), the card
  // remounts so its editor re-seeds from the new contentJson instead of showing
  // stale content (useEntityEditor only loads on sourceId change, not content).
  const pendingEntry = useAgentEditStore((s) => s.pending[entityKey('element', elementId)]);
  const reviewOpByPatch = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of pendingEntry?.changes ?? []) {
      if (c.field?.kind === 'patch' && c.field.key) m.set(c.field.key, c.op);
    }
    return m;
  }, [pendingEntry]);

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

  // Reload when an agent (or another surface) changes this element's patches —
  // PatchesSection keeps local state with no store subscription of its own.
  useEffect(() => {
    const onChanged = (p: { elementId?: string }) => {
      if (!p.elementId || p.elementId === elementId) void reload();
    };
    eventBus.on('element:patches-changed', onChanged);
    return () => eventBus.off('element:patches-changed', onChanged);
  }, [elementId, reload]);

  const handleAddFloating = useCallback(async () => {
    try {
      const repo = createElementPatchRepository();
      const created = await repo.create({ projectId, elementId });
      syncElementPatchCreate(created.id, projectId, {
        id: created.id,
        elementId: created.elementId,
        sourceNodeId: created.sourceNodeId,
        sourceBlockId: created.sourceBlockId,
        sourceBlockText: created.sourceBlockText,
        textAnchorJson: created.textAnchorJson,
        invalidatedAt: created.invalidatedAt,
        title: created.title,
        contentJson: created.contentJson,
        orderKey: created.orderKey,
      });
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
        <span className="refs-section__title">补丁</span>
        <span className="refs-section__count">{patches.length}</span>
        <button type="button" onClick={handleAddFloating} className="refs-section__action">
          ＋ 新建
        </button>
      </div>
      {patches.length === 0 ? (
        <div className="refs-empty">
          — 尚无补丁。在章节里选中文本 → 右键「新建补丁」可锚定到此元素 —
        </div>
      ) : (
        <div>
          {patches.map((patch) => (
            <PatchEditorCard
              key={`${patch.id}:${reviewOpByPatch.get(patch.id) ?? ''}`}
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
