import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import loglevel from 'loglevel';

import { useDataStoreFields } from '../../store/use-data-store-fields';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useBookNode } from '../../usecase/useBookNode';
import { useStoryline } from '../../usecase/useStoryline';
import { isChapter } from '../../domain/book-node';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { KindMark } from '../ui/KindMark';
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
            <EmptyState density="compact" mark="storyline" message={t('editChapterStoryline.empty')} />
          ) : (
            storylines.map((storyline) => {
              const selected = draftStorylineIds.includes(storyline.id);
              const isMain = draftMainStorylineId === storyline.id;
              const color = storyline.color || 'hsl(var(--accent))';
              // The whole row is the check box, in the storyline's colour;
              // "主线" is one never-changing word shaped like the scope toggle.
              return (
                <div key={storyline.id} className="edit-storyline-modal__row">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    aria-label={t('editChapterStoryline.include', { name: storyline.name })}
                    className={`ui-toggle-row glass${selected ? ' is-on' : ''}`}
                    style={{ '--toggle-color': color } as CSSProperties}
                    onClick={() => handleToggleDraftStoryline(storyline.id)}
                  >
                    <KindMark kind="storyline" color={color} />
                    <span className="ui-toggle-row__label">{storyline.name}</span>
                  </button>
                  <button
                    type="button"
                    className="scope-toggle glass glass--rest glass--small"
                    aria-pressed={isMain}
                    disabled={!selected}
                    onClick={() => handleSelectDraftMain(storyline.id)}
                  >
                    {t('editChapterStoryline.main')}
                  </button>
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
