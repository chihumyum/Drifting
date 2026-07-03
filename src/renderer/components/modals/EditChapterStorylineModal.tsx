import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { useDataStore } from '../../store/data-store';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { isChapter } from '../../domain/book-node';

const log = loglevel.getLogger('EditChapterStorylineModal');
log.setLevel(loglevel.levels.ERROR);

interface Props {
  nodeId: string;
  onClose: () => void;
}

// Reusable Edit Chapter Storyline modal. Opened either from the chapter
// editor's top bar or from the BottomTimeline / StoryGraphView chapter
// context menus. Saving with an empty selection demotes the chapter to
// 未归属 — the save button label switches in that case to make the intent
// explicit.
export function EditChapterStorylineModal({ nodeId, onClose }: Props) {
  const { t } = useTranslation();
  const { bookNodes, storylines, nodeStorylineMapping, primaryStorylineByNode } = useDataStore();
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id);

  const { updateNode } = useBookNode({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });
  const { setNodeStorylines } = useStoryline({
    projectId: projectId ?? '',
    userId: userId ?? '',
  });

  const curNode = useMemo(() => bookNodes.find((n) => n.id === nodeId) ?? null, [bookNodes, nodeId]);
  const storylineById = useMemo(
    () => new Map(storylines.map((s) => [s.id, s])),
    [storylines],
  );
  const curPrimaryId = primaryStorylineByNode[nodeId] ?? null;
  const currentStorylineIds = useMemo(() => {
    const mappedIds = nodeStorylineMapping[nodeId] ?? [];
    const ids = curPrimaryId
      ? [curPrimaryId, ...mappedIds.filter((id) => id !== curPrimaryId)]
      : mappedIds;
    return ids.filter((id, index) => ids.indexOf(id) === index && storylineById.has(id));
  }, [nodeId, nodeStorylineMapping, curPrimaryId, storylineById]);

  const [draftStorylineIds, setDraftStorylineIds] = useState<string[]>(currentStorylineIds);
  const [draftMainStorylineId, setDraftMainStorylineId] = useState<string | null>(
    curPrimaryId && currentStorylineIds.includes(curPrimaryId)
      ? curPrimaryId
      : currentStorylineIds[0] ?? null,
  );

  // Auto-elect a main when the draft set changes (matches the behavior the
  // old inline modal had via its useEffect — keeps the radio selection from
  // pointing at a now-deselected storyline).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (draftStorylineIds.length === 0) {
        if (draftMainStorylineId) setDraftMainStorylineId(null);
        return;
      }
      if (!draftMainStorylineId || !draftStorylineIds.includes(draftMainStorylineId)) {
        setDraftMainStorylineId(draftStorylineIds[0]);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftMainStorylineId, draftStorylineIds]);

  const handleToggleDraftStoryline = useCallback((storylineId: string) => {
    setDraftStorylineIds((prev) => {
      if (prev.includes(storylineId)) {
        // Deselecting down to zero is allowed — saving with an empty
        // selection demotes the chapter to 未归属.
        return prev.filter((id) => id !== storylineId);
      }
      return [...prev, storylineId];
    });
  }, []);

  const handleSelectDraftMain = useCallback((storylineId: string) => {
    setDraftStorylineIds((prev) => (prev.includes(storylineId) ? prev : [...prev, storylineId]));
    setDraftMainStorylineId(storylineId);
  }, []);

  const handleSave = useCallback(async () => {
    if (!curNode) return;
    const nextMain = draftStorylineIds.length === 0 ? null : draftMainStorylineId;
    const selectedIds =
      nextMain == null ? [] : Array.from(new Set([nextMain, ...draftStorylineIds]));
    try {
      if (nextMain !== curPrimaryId) {
        await updateNode(nodeId, { mainStorylineId: nextMain });
      }
      await setNodeStorylines(nodeId, selectedIds);
      onClose();
    } catch (error) {
      log.error('Failed to update chapter storylines:', error);
      alert(t('editChapterStoryline.updateFailed'));
    }
  }, [curNode, curPrimaryId, draftMainStorylineId, draftStorylineIds, nodeId, onClose, setNodeStorylines, t, updateNode]);

  // The modal only makes sense for chapters — drift nodes are 1:1 with their
  // own kind and never carry storyline membership. Bail out silently if
  // someone hands us the wrong nodeId.
  if (!curNode || !isChapter(curNode)) return null;

  const willUnaffiliate = draftStorylineIds.length === 0;
  const disabled = !willUnaffiliate && !draftMainStorylineId;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        background: 'rgba(35, 28, 20, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(520px, 100%)',
          maxHeight: '80vh',
          overflow: 'auto',
          background: '#fefdfb',
          border: '1px solid hsl(var(--accent-border))',
          borderRadius: 10,
          boxShadow: '0 18px 50px rgba(42, 26, 10, 0.22)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            padding: '20px 22px 14px',
            borderBottom: '1px solid rgba(184, 153, 104, 0.18)',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, color: '#2a1a0a' }}>
            {t('editChapterStoryline.title')}
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: '#7a6a56' }}>{curNode.title}</div>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {storylines.length === 0 ? (
            <div
              style={{
                padding: '24px 12px',
                textAlign: 'center',
                color: '#7a6a56',
                fontFamily: 'var(--font-serif)',
                fontStyle: 'italic',
                fontSize: 13,
              }}
            >
              {t('editChapterStoryline.empty')}
            </div>
          ) : (
            storylines.map((storyline) => {
              const selected = draftStorylineIds.includes(storyline.id);
              const isMain = draftMainStorylineId === storyline.id;
              return (
                <div
                  key={storyline.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 1fr auto',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: selected
                      ? `1px solid ${storyline.color || '#b89968'}66`
                      : '1px solid rgba(184, 153, 104, 0.18)',
                    background: selected ? `${storyline.color || '#b89968'}12` : '#fffaf2',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => handleToggleDraftStoryline(storyline.id)}
                    aria-label={t('editChapterStoryline.include', { name: storyline.name })}
                  />
                  <button
                    type="button"
                    onClick={() => handleToggleDraftStoryline(storyline.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0,
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      color: '#3c3025',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: storyline.color || '#b89968',
                        flex: '0 0 auto',
                      }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: 14,
                        fontWeight: selected ? 700 : 500,
                      }}
                    >
                      {storyline.name}
                    </span>
                  </button>
                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      color: selected ? '#5a4a3a' : '#a39787',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    <input
                      type="radio"
                      name="main-storyline"
                      checked={isMain}
                      disabled={!selected}
                      onChange={() => handleSelectDraftMain(storyline.id)}
                    />
                    {t('editChapterStoryline.main')}
                  </label>
                </div>
              );
            })
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 18px 18px',
            borderTop: '1px solid rgba(184, 153, 104, 0.18)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid hsl(var(--accent-border))',
              background: '#fefdfb',
              color: '#5a4a3a',
              cursor: 'pointer',
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void handleSave()}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: 'none',
              background: disabled ? '#d8d0c3' : 'hsl(var(--accent))',
              color: '#fefdfb',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontWeight: 700,
            }}
          >
            {willUnaffiliate ? t('editChapterStoryline.unaffiliate') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
