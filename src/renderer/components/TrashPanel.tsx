import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/auth';
import { useProjectStore } from '../store/project-store';
import { useBookNode } from '../usecase/useBookNode';
import { useBookElement } from '../usecase/useBookElement';
import { useStoryline } from '../usecase/useStoryline';
import { useElementCategory } from '../usecase/useElementCategory';
import { useCanUseFeature } from '../lib/feature-access';

// Minimal trash UI. Lists soft-deleted entities across the core domains.
// Each row remains local until it is restored or permanently deleted here.
interface TrashItem {
  kind: 'chapter' | 'drift' | 'element' | 'storyline' | 'category';
  id: string;
  label: string;
  deletedAt: string;
}

export function TrashPanel() {
  const { t } = useTranslation();
  const userId = useAuthStore((s) => s.user?.id);
  const projectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const canTrash = useCanUseFeature('trash');

  if (!userId || !projectId) {
    return (
      <div style={{ padding: 24, color: 'hsl(var(--ink-4))' }}>{t('trashPanel.noProject')}</div>
    );
  }

  if (!canTrash) {
    return (
      <div style={{ padding: 24, color: 'hsl(var(--ink-4))', maxWidth: 480 }}>
        <h3 style={{ marginBottom: 8 }}>{t('trashPanel.proTitle')}</h3>
        <p style={{ fontSize: 13, lineHeight: 1.6 }}>
          {t('trashPanel.proDesc')}
        </p>
      </div>
    );
  }

  return <TrashPanelInner projectId={projectId} userId={userId} />;
}

function TrashPanelInner({ projectId, userId }: { projectId: string; userId: string }) {
  const { t } = useTranslation();
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
          label: n.title || t('globalSearch.fallback.untitled'),
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
  }, [nodeUC, elementUC, storylineUC, categoryUC, t]);

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

  // Permanently drop one row, routing to the right domain usecase. No confirm /
  // reload here — callers (single purge, clear-all) own those.
  const purgeOne = useCallback(
    async (item: TrashItem) => {
      if (item.kind === 'chapter' || item.kind === 'drift') {
        await nodeUC.purgeNode(item.id);
      } else if (item.kind === 'element') {
        await elementUC.purgeElement(item.id);
      } else if (item.kind === 'storyline') {
        await storylineUC.purgeStoryline(item.id);
      } else if (item.kind === 'category') {
        await categoryUC.purgeCategory(item.id);
      }
    },
    [nodeUC, elementUC, storylineUC, categoryUC],
  );

  // Drop the row for good. Irreversible, so gate it behind a confirm — once
  // purged there's no restore.
  const purge = async (item: TrashItem) => {
    const confirmed = window.confirm(
      t('trashPanel.confirmPurge', { label: item.label }),
    );
    if (!confirmed) return;
    await purgeOne(item);
    await reload();
  };

  // Empty the whole bin in one go. Purge sequentially so a category's child
  // re-link runs before any element row that depends on it.
  const purgeAll = async () => {
    if (items.length === 0) return;
    const confirmed = window.confirm(
      t('trashPanel.confirmPurgeAll', { count: items.length }),
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      for (const item of items) {
        await purgeOne(item);
      }
    } finally {
      setBusy(false);
    }
    await reload();
  };

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>{t('trashPanel.title')}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, color: 'hsl(var(--ink-4))' }}>
            {t('trashPanel.retention')}
          </span>
          <button
            className="set-btn set-btn--danger"
            disabled={busy || items.length === 0}
            onClick={() => void purgeAll()}
          >
            {t('trashPanel.clear')}
          </button>
        </div>
      </div>
      {busy && items.length === 0 ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>{t('referencesPanel.loading')}</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'hsl(var(--ink-4))', fontSize: 13 }}>{t('trashPanel.empty')}</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'hsl(var(--ink-4))', fontSize: 11 }}>
              <th style={{ padding: '8px 4px' }}>{t('trashPanel.columns.type')}</th>
              <th style={{ padding: '8px 4px' }}>{t('trashPanel.columns.name')}</th>
              <th style={{ padding: '8px 4px' }}>{t('trashPanel.columns.deletedAt')}</th>
              <th style={{ padding: '8px 4px' }}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={`${it.kind}:${it.id}`} style={{ borderTop: '1px solid hsl(var(--rule))' }}>
                <td style={{ padding: '8px 4px', color: 'hsl(var(--ink-3))' }}>{t(`trashPanel.kind.${it.kind}`)}</td>
                <td style={{ padding: '8px 4px' }}>{it.label}</td>
                <td style={{ padding: '8px 4px', color: 'hsl(var(--ink-4))', fontSize: 11 }}>
                  {new Date(it.deletedAt).toLocaleString()}
                </td>
                <td style={{ padding: '8px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="set-btn" disabled={busy} onClick={() => void restore(it)}>
                    {t('trashPanel.restore')}
                  </button>
                  <button
                    className="set-btn set-btn--danger"
                    disabled={busy}
                    style={{ marginLeft: 8 }}
                    onClick={() => void purge(it)}
                  >
                    {t('trashPanel.purgeNow')}
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
