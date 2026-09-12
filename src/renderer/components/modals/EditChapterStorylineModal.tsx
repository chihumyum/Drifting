import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { useDataStoreFields } from '../../store/use-data-store-fields';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { isChapter } from '../../domain/book-node';
import { Button } from '../ui/Button';
import {
  ModalActions,
  ModalBody,
  ModalCard,
  ModalHeader,
  ModalRoot,
} from '../ui/Modal';

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
  const { bookNodes, storylines, nodeStorylineMapping, primaryStorylineByNode } = useDataStoreFields('bookNodes', 'storylines', 'nodeStorylineMapping', 'primaryStorylineByNode');
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
    <ModalRoot onClose={onClose} ariaLabel={t('editChapterStoryline.title')}>
      <ModalCard width={520}>
        <ModalHeader title={t('editChapterStoryline.title')} subtitle={curNode.title} />
        <ModalBody className="edit-storyline-modal__body">
          {storylines.length === 0 ? (
            <div
              style={{
                padding: '24px 12px',
                textAlign: 'center',
                color: 'hsl(var(--ink-3))',
                fontFamily: 'var(--font-sans)',
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
              const color = storyline.color || 'hsl(var(--accent))';
              return (
                <div
                  key={storyline.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '24px 1fr auto',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-md)',
                    border: selected ? `1px solid ${color}` : '1px solid hsl(var(--rule))',
                    background: selected
                      ? `color-mix(in srgb, ${color} 8%, transparent)`
                      : 'hsl(var(--paper))',
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
                      color: 'hsl(var(--ink-2))',
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
                        background: color,
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
                      color: selected ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
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
        </ModalBody>
        <ModalActions>
          <Button onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => void handleSave()}
          >
            {willUnaffiliate ? t('editChapterStoryline.unaffiliate') : t('common.save')}
          </Button>
        </ModalActions>
      </ModalCard>
    </ModalRoot>
  );
}
