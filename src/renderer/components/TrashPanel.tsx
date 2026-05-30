import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { useProjectStore } from '../store/project-store';
import { useBookNode } from '../usecase/useBookNode';
import { useBookElement } from '../usecase/useBookElement';
import { useStoryline } from '../usecase/useStoryline';
import { useElementCategory } from '../usecase/useElementCategory';
import { useCanUseFeature } from '../lib/feature-access';

// Minimal trash UI. Lists soft-deleted entities across the 4 core domains.
// Each row can be restored, or permanently deleted right away ("立刻删除")
// instead of waiting for the 30-day server cron to purge it.
interface TrashItem {
  kind: 'chapter' | 'drift' | 'element' | 'storyline' | 'category';
  id: string;
  label: string;
  deletedAt: string;
}

export function TrashPanel() {
  const userId = useAuthStore((s) => s.user?.id);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const canTrash = useCanUseFeature('trash');

  if (!userId || !projectId) {
    return (
      <div style={{ padding: 24, color: 'hsl(var(--ink-4))' }}>请先打开一个项目。</div>
    );
  }

  if (!canTrash) {
    return (
      <div style={{ padding: 24, color: 'hsl(var(--ink-4))', maxWidth: 480 }}>
        <h3 style={{ marginBottom: 8 }}>回收站 · Pro</h3>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          软删除与回收站是 Pro / Studio 功能。当前账号为免费版，删除操作仍为永久删除。
        </p>
      </div>
    );
  }

  return <TrashPanelInner projectId={projectId} userId={userId} />;
}

function TrashPanelInner({ projectId, userId }: { projectId: string; userId: string }) {
  const nodeUC = useBookNode({ projectId, userId });
  const elementUC = useBookElement({ projectId, userId });
  const storylineUC = useStoryline({ projectId, userId });
  const categoryUC = useElementCategory({ projectId, userId });

  const [items, setItems] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const [nodes, elements, storylines, categories] = await Promise.all([
        nodeUC.listTrashedNodes(),
        elementUC.listTrashedElements(),
        storylineUC.listTrashedStorylines(),
        categoryUC.listTrashedCategories(),
      ]);
      const next: TrashItem[] = [];
      for (const n of nodes) {
        next.push({
          kind: n.kind === 'chapter' ? 'chapter' : 'drift',
          id: n.id,
          label: n.title || '(无标题)',
          deletedAt: n.deletedAt,
        });
      }
      for (const e of elements) {
        next.push({ kind: 'element', id: e.id, label: e.name, deletedAt: e.deletedAt });
      }
      for (const s of storylines) {
        next.push({ kind: 'storyline', id: s.id, label: s.name, deletedAt: s.deletedAt });
      }
      for (const c of categories) {
        next.push({ kind: 'category', id: c.id, label: c.name, deletedAt: c.deletedAt });
      }
      next.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
      setItems(next);
    } finally {
      setBusy(false);
    }
  }, [nodeUC, elementUC, storylineUC, categoryUC]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const restore = async (item: TrashItem) => {
    if (item.kind === 'chapter' || item.kind === 'drift') {
      await nodeUC.restoreNode(item.id);
    } else if (item.kind === 'element') {
      await elementUC.restoreElement(item.id);
    } else if (item.kind === 'storyline') {
      await storylineUC.restoreStoryline(item.id);
    } else if (item.kind === 'category') {
      await categoryUC.restoreCategory(item.id);
    }
    await reload();
  };

  // Skip the 30-day wait and drop the row for good. Irreversible, so gate it
  // behind a confirm — once purged there's no restore.
  const purge = async (item: TrashItem) => {
    const confirmed = window.confirm(
      `彻底删除「${item.label}」？此操作无法撤销，将立即永久删除。`,
    );
    if (!confirmed) return;
    if (item.kind === 'chapter' || item.kind === 'drift') {
      await nodeUC.purgeNode(item.id);
    } else if (item.kind === 'element') {
      await elementUC.purgeElement(item.id);
    } else if (item.kind === 'storyline') {
      await storylineUC.purgeStoryline(item.id);
    } else if (item.kind === 'category') {
      await categoryUC.purgeCategory(item.id);
    }
    await reload();
  };

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>回收站</h3>
        <span style={{ fontSize: 11, color: 'hsl(var(--ink-4))' }}>
          30 天后自动彻底删除
        </span>
      </div>
      {busy && items.length === 0 ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>加载中…</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>回收站是空的。</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'hsl(var(--ink-4))', fontSize: 11 }}>
              <th style={{ padding: '8px 4px' }}>类型</th>
              <th style={{ padding: '8px 4px' }}>名称</th>
              <th style={{ padding: '8px 4px' }}>删除时间</th>
              <th style={{ padding: '8px 4px' }}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={`${it.kind}:${it.id}`} style={{ borderTop: '1px solid hsl(var(--rule))' }}>
                <td style={{ padding: '8px 4px', color: 'hsl(var(--ink-3))' }}>{KIND_LABEL[it.kind]}</td>
                <td style={{ padding: '8px 4px' }}>{it.label}</td>
                <td style={{ padding: '8px 4px', color: 'hsl(var(--ink-4))', fontSize: 11 }}>
                  {new Date(it.deletedAt).toLocaleString()}
                </td>
                <td style={{ padding: '8px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="set-btn" disabled={busy} onClick={() => void restore(it)}>
                    恢复
                  </button>
                  <button
                    className="set-btn set-btn--danger"
                    disabled={busy}
                    style={{ marginLeft: 8 }}
                    onClick={() => void purge(it)}
                  >
                    立刻删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const KIND_LABEL: Record<TrashItem['kind'], string> = {
  chapter: '章节',
  drift: '浮缀',
  element: '元素',
  storyline: '故事线',
  category: '元素类别',
};
