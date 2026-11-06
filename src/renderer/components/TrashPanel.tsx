import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/auth';
import { useProjectStore } from '../store/project-store';
import { useBookNode } from '../usecase/useBookNode';
import { useBookElement } from '../usecase/useBookElement';
import { useStoryline } from '../usecase/useStoryline';
import { useElementCategory } from '../usecase/useElementCategory';
import { requestConfirmation } from '../store/confirmation-store';
import { BrushIcon } from './ui/BrushIcon';
import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';
import { KindMark } from './ui/KindMark';
import { LoadingStatus } from './ui/LoadingStatus';

/** The settings' trash is a list of cells (components.md): each deleted
 * thing with its sand mark, the ring under the pointer, and restore / delete
 * only on the row being pointed at. */

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

  if (!userId || !projectId) {
    return <EmptyState icon="trash" message={t('trashPanel.noProject')} />;
  }

  return <TrashPanelInner projectId={projectId} userId={userId} />;
}

function TrashPanelInner({ projectId, userId }: { projectId: string; userId: string }) {
  const { t, i18n } = useTranslation();
  const nodeUC = useBookNode({ projectId, userId });
  const elementUC = useBookElement({ projectId, userId });
  const storylineUC = useStoryline({ projectId, userId });
  const categoryUC = useElementCategory({ projectId, userId });

  const [items, setItems] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);
  // The last restore / delete that failed, shown under the head until the next
  // action: a failed write rolls back whole, so the row simply stays.
  const [failure, setFailure] = useState<string | null>(null);

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

  const describeFailure = (key: 'restoreFailed' | 'purgeFailed', error: unknown) =>
    t(`trashPanel.${key}`, { error: error instanceof Error ? error.message : String(error) });

  const restore = async (item: TrashItem) => {
    setFailure(null);
    try {
      if (item.kind === 'chapter' || item.kind === 'drift') {
        await nodeUC.restoreNode(item.id);
      } else if (item.kind === 'element') {
        await elementUC.restoreElement(item.id);
      } else if (item.kind === 'storyline') {
        await storylineUC.restoreStoryline(item.id);
      } else if (item.kind === 'category') {
        await categoryUC.restoreCategory(item.id);
      }
    } catch (error) {
      setFailure(describeFailure('restoreFailed', error));
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
    const confirmed = await requestConfirmation(
      t('trashPanel.confirmPurge', { label: item.label }),
    );
    if (!confirmed) return;
    setFailure(null);
    try {
      await purgeOne(item);
    } catch (error) {
      setFailure(describeFailure('purgeFailed', error));
    }
    await reload();
  };

  // Empty the whole bin in one go. Purge sequentially so a category's child
  // re-link runs before any element row that depends on it.
  const purgeAll = async () => {
    if (items.length === 0) return;
    const confirmed = await requestConfirmation(
      t('trashPanel.confirmPurgeAll', { count: items.length }),
    );
    if (!confirmed) return;
    setFailure(null);
    setBusy(true);
    try {
      for (const item of items) {
        await purgeOne(item);
      }
    } catch (error) {
      // Each row is its own transaction: the ones before the failure are gone,
      // the failed one and the rest stay listed.
      setFailure(describeFailure('purgeFailed', error));
    } finally {
      setBusy(false);
    }
    await reload();
  };

  return (
    <div className="set-trash">
      <div className="set-trash__head">
        <span className="set-trash__retention">
          {t('trashPanel.retention')}
          {items.length > 0 && ` · ${items.length}`}
        </span>
        <Button variant="danger" size="sm" disabled={busy || items.length === 0} onClick={() => void purgeAll()}>
          <BrushIcon name="trash" size={12} />
          {t('trashPanel.clear')}
        </Button>
      </div>
      {failure && (
        <p role="alert" className="set-trash__failure">
          {failure}
        </p>
      )}
      {busy && items.length === 0 ? (
        <LoadingStatus label={t('referencesPanel.loading')} />
      ) : items.length === 0 ? (
        <EmptyState icon="trash" message={t('trashPanel.empty')} />
      ) : (
        <div className="set-trash__list">
          {items.map((it) => (
            <div key={`${it.kind}:${it.id}`} className="set-trash__row menu-surface__item">
              <KindMark kind={it.kind} seed={it.id} title={t(`trashPanel.kind.${it.kind}`)} />
              <span className="set-trash__label">{it.label}</span>
              <span className="set-trash__when">{new Date(it.deletedAt).toLocaleString(i18n.language)}</span>
              <span className="set-trash__actions">
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void restore(it)}>
                  <BrushIcon name="rotate" size={12} />
                  {t('trashPanel.restore')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="set-trash__purge"
                  disabled={busy}
                  onClick={() => void purge(it)}
                >
                  <BrushIcon name="trash" size={12} />
                  {t('trashPanel.purgeNow')}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
