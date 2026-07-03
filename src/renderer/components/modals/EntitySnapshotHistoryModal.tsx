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
import { createPortal } from 'react-dom';
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
import type { ProseEntityType } from '../../lib/yjs-doc-id';

interface Target {
  entityKind: ProseEntityType;
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

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [target, close]);

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

  return createPortal(
    <>
      <div
        onMouseDown={close}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'hsl(var(--ink-1) / 0.32)',
          zIndex: 12000,
        }}
      />
      <div
        role="dialog"
        aria-label={t('snapshotHistory.aria')}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 520,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'min(620px, calc(100vh - 96px))',
          display: 'flex',
          flexDirection: 'column',
          background: 'hsl(var(--surface))',
          border: '1px solid hsl(var(--rule-strong))',
          borderRadius: 8,
          boxShadow: '0 18px 48px hsl(var(--ink-1) / 0.25)',
          zIndex: 12001,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 12,
            padding: '14px 18px 10px',
            borderBottom: '1px solid hsl(var(--rule))',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.14em',
                color: 'hsl(var(--ink-3))',
                marginBottom: 4,
              }}
            >
              {t('snapshotHistory.title')}
            </div>
            <div
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 16,
                color: 'hsl(var(--ink-1))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {header}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close')}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--ink-3))',
              fontSize: 16,
              cursor: 'pointer',
              padding: 4,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {note && (
          <div
            style={{
              padding: '8px 18px',
              fontSize: 12,
              color: 'hsl(var(--ink-2))',
              borderBottom: '1px solid hsl(var(--rule) / 0.6)',
              background: 'hsl(var(--ink-1) / 0.03)',
            }}
          >
            {note}
          </div>
        )}

        <div style={{ overflowY: 'auto', padding: '6px 10px 12px', flex: 1 }}>
          {rows === null ? (
            <EmptyLine text={t('snapshotHistory.loading')} />
          ) : rows.length === 0 ? (
            <EmptyLine text={t('snapshotHistory.empty')} />
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '10px 8px',
                  borderBottom: '1px dotted hsl(var(--rule))',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11.5,
                      color: 'hsl(var(--ink-1))',
                      flexShrink: 0,
                    }}
                  >
                    {formatTime(row.createdAt)}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10.5,
                      color: 'hsl(var(--ink-3))',
                      flexShrink: 0,
                    }}
                  >
                    {t('common.wordsCount', { count: row.words.toLocaleString() })}
                  </span>
                  {row.metaLabel && (
                    <span
                      style={{
                        fontFamily: 'var(--font-serif)',
                        fontStyle: 'italic',
                        fontSize: 12,
                        color: 'hsl(var(--ink-3))',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      {row.metaLabel}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', gap: 6 }}>
                    {confirmId === row.id ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRestore(row.id)}
                          style={rowBtn('hsl(var(--accent))')}
                        >
                          {busy ? t('snapshotHistory.restoring') : t('snapshotHistory.confirmRestore')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmId(null)}
                          style={rowBtn('hsl(var(--ink-3))')}
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmId(row.id)}
                        style={rowBtn('hsl(var(--ink-2))')}
                        title={t('snapshotHistory.restoreTitle')}
                      >
                        {t('snapshotHistory.restore')}
                      </button>
                    )}
                  </span>
                </div>
                {row.excerpt && (
                  <div
                    style={{
                      fontFamily: 'var(--font-serif)',
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: 'hsl(var(--ink-3))',
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitBoxOrient: 'vertical',
                      WebkitLineClamp: 2,
                    }}
                  >
                    {row.excerpt}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: '28px 12px',
        textAlign: 'center',
        fontFamily: 'var(--font-serif)',
        fontStyle: 'italic',
        fontSize: 12.5,
        color: 'hsl(var(--ink-3))',
      }}
    >
      {text}
    </div>
  );
}

function rowBtn(color: string): React.CSSProperties {
  return {
    border: '1px solid hsl(var(--rule))',
    borderRadius: 4,
    background: 'transparent',
    color,
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    padding: '3px 8px',
    cursor: 'pointer',
  };
}
