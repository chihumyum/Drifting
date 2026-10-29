/**
 * EntitySnapshotHistoryModal — the entity "time machine".
 *
 * Self-mounting (rendered once in App's modal layer): listens for
 * `snapshot-history:open` and shows the local snapshot trail of one prose
 * entity, newest first. Each row: capture time · word count · a plain-text
 * excerpt. Restoring covers the entity's body + metadata with the selected
 * version (see snapshot-restore.service — the pre-restore state is captured
 * first, so a restore is itself always undoable).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { events } from '../../lib/events';
import {
  createEntitySnapshotRepository,
  type EntitySnapshotSummary,
} from '../../sqlite-repo/entity-snapshot-repo';
import { restoreEntitySnapshot } from '../../services/snapshot-restore.service';
import type { SnapshotMeta } from '../../services/snapshot-history.service';
import { docToPlainText } from '../../lib/agent/serialize';
import { countWordsInPmJson } from '../../lib/word-count';
import { useDataStore } from '../../store/data-store';
import type { SnapshotEntityKind } from '../../lib/yjs-doc-id';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { LoadingStatus } from '../ui/LoadingStatus';
import { ModalBody, ModalCard, ModalHeader, ModalRoot } from '../ui/Modal';

interface Target {
  entityKind: SnapshotEntityKind;
  entityId: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return sameYear ? `${m}/${day} ${hh}:${mm}` : `${d.getFullYear()}/${m}/${day} ${hh}:${mm}`;
}

/** Row view-model derived once per load — parsing contentJson per render
 *  would re-walk potentially large docs on every state change. */
interface RowVm {
  id: string;
  createdAt: string;
  words: number;
  excerpt: string;
  metaLabel: string;
}

function toVm(row: EntitySnapshotSummary): RowVm {
  let metaLabel = '';
  try {
    const meta = row.metaJson ? (JSON.parse(row.metaJson) as SnapshotMeta) : {};
    metaLabel = meta.title ?? meta.name ?? '';
  } catch {
    /* legacy/malformed meta — label stays empty */
  }
  const text = row.contentJson ? docToPlainText(row.contentJson) : '';
  return {
    id: row.id,
    createdAt: row.createdAt,
    words: row.contentJson ? countWordsInPmJson(row.contentJson) : 0,
    excerpt: text.replace(/\s+/g, ' ').slice(0, 120),
    metaLabel,
  };
}

export function EntitySnapshotHistoryModal() {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  const [rows, setRows] = useState<RowVm[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const handler = (payload: Target) => {
      setTarget(payload);
      setRows(null);
      setConfirmId(null);
      setNote(null);
    };
    events.on('snapshot-history:open', handler);
    return () => events.off('snapshot-history:open', handler);
  }, []);

  const close = useCallback(() => {
    if (busy) return;
    setTarget(null);
  }, [busy]);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    void createEntitySnapshotRepository()
      .listForEntity(target.entityKind, target.entityId)
      .then((list) => {
        if (alive) setRows(list.map(toVm));
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [target]);

  // Resolve the entity's current display name from the live store.
  const entityName = useDataStore((s) => {
    if (!target) return '';
    switch (target.entityKind) {
      case 'node':
        return s.bookNodes.find((n) => n.id === target.entityId)?.title ?? '';
      case 'element':
        return s.bookElements.find((e) => e.id === target.entityId)?.name ?? '';
      case 'storyline':
        return s.storylines.find((sl) => sl.id === target.entityId)?.name ?? '';
      case 'category':
        return s.bookElementCategories.find((c) => c.id === target.entityId)?.name ?? '';
      case 'library_item':
        return s.libraryItems.find((item) => item.id === target.entityId)?.title ?? '';
    }
  });

  const handleRestore = useCallback(
    async (id: string) => {
      if (!target) return;
      setBusy(true);
      setNote(null);
      try {
        await restoreEntitySnapshot(id);
        setNote(t('snapshotHistory.restoreSuccess'));
        // Reload: the pre-restore capture (and possibly a post-restore one)
        // changed the list.
        const list = await createEntitySnapshotRepository().listForEntity(
          target.entityKind,
          target.entityId,
        );
        setRows(list.map(toVm));
      } catch (err) {
        setNote(t('snapshotHistory.restoreFailed', { error: err instanceof Error ? err.message : String(err) }));
      } finally {
        setBusy(false);
        setConfirmId(null);
      }
    },
    [target, t],
  );

  const header = useMemo(() => {
    if (!target) return '';
    const kind = t(`snapshotHistory.kind.${target.entityKind}`);
    return entityName ? `${kind} · ${entityName}` : kind;
  }, [target, entityName, t]);

  if (!target) return null;

  return (
    <ModalRoot onClose={close} ariaLabel={t('snapshotHistory.aria')} closeOnBackdrop={!busy}>
      <ModalCard className="snapshot-history-modal" width={520}>
        <ModalHeader
          kicker={t('snapshotHistory.title')}
          title={header}
          onClose={close}
          closeLabel={t('common.close')}
        />

        {note && <div className="snapshot-history-modal__note">{note}</div>}

        <ModalBody className="snapshot-history-modal__body">
          {rows === null ? (
            <LoadingStatus label={t('snapshotHistory.loading')} />
          ) : rows.length === 0 ? (
            <EmptyState density="compact" message={t('snapshotHistory.empty')} />
          ) : (
            rows.map((row) => (
              <div key={row.id} className="snapshot-history-modal__row">
                <div className="snapshot-history-modal__top">
                  <span className="snapshot-history-modal__time">{formatTime(row.createdAt)}</span>
                  <span className="snapshot-history-modal__words">
                    {t('common.wordsCount', { count: row.words.toLocaleString() })}
                  </span>
                  {row.metaLabel && <span className="snapshot-history-modal__meta">{row.metaLabel}</span>}
                  <span className="snapshot-history-modal__actions">
                    {confirmId === row.id ? (
                      <>
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmId(null)}>
                          {t('common.cancel')}
                        </Button>
                        <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleRestore(row.id)}>
                          {busy ? t('snapshotHistory.restoring') : t('snapshotHistory.confirmRestore')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirmId(row.id)}
                        title={t('snapshotHistory.restoreTitle')}
                      >
                        {t('snapshotHistory.restore')}
                      </Button>
                    )}
                  </span>
                </div>
                {row.excerpt && <div className="snapshot-history-modal__excerpt">{row.excerpt}</div>}
              </div>
            ))
          )}
        </ModalBody>
      </ModalCard>
    </ModalRoot>
  );
}
