import type { TFunction } from 'i18next';
import { isChapter } from '../../domain/book-node';
import { commentBlockIds, getBlockSnapshotsFromAnchor, getSelectedTextFromAnchor, getTextAnchorFromAnchor, type Comment } from '../../domain/comment';
import { isStructuralEntityKind, type EntityKind } from '../../domain/entity-kinds';
import type { useDataStore } from '../../store/data-store';

export interface CommentSourceRelation { toKind: EntityKind; toId: string }
type SourceState = Pick<ReturnType<typeof useDataStore.getState>, 'bookNodes' | 'bookElements' | 'bookElementCategories' | 'storylines'>;

/** Metadata and creation snapshots only: hovering never loads or rewrites prose. */
export function buildCommentSourcePreview(comment: Comment, relations: CommentSourceRelation[], state: SourceState, t: TFunction) {
  const targets = [
    ...(comment.targetKind && comment.targetId ? [{ toKind: comment.targetKind, toId: comment.targetId }] : []),
    ...relations,
  ].filter((target, index, all) => isStructuralEntityKind(target.toKind)
    && all.findIndex((other) => other.toKind === target.toKind && other.toId === target.toId) === index);
  const entities = targets.map(({ toKind, toId }) => {
    const matches = (entity: { id: string; projectId: string }) => entity.id === toId && entity.projectId === comment.projectId;
    const node = toKind === 'node' ? state.bookNodes.find(matches) : undefined;
    const entity = toKind === 'element' ? state.bookElements.find(matches)
      : toKind === 'category' ? state.bookElementCategories.find(matches)
        : toKind === 'storyline' ? state.storylines.find(matches) : undefined;
    return {
      key: `${toKind}:${toId}`,
      kind: node ? t(isChapter(node) ? 'nodeEditor.folio.chapter' : 'nodeEditor.folio.drift') : t(`relationTypes.entityKinds.${toKind}`),
      name: node ? node.title.trim() || t('common.untitled')
        : entity ? entity.name.trim() || t('common.untitled') : t('reviewPanel.sourceUnavailable'),
    };
  });
  const textAnchor = getTextAnchorFromAnchor(comment.anchorJson);
  const snapshots = getBlockSnapshotsFromAnchor(comment.anchorJson);
  const text = textAnchor?.text.trim() || getSelectedTextFromAnchor(comment.anchorJson).trim()
    || snapshots.map((snapshot) => snapshot.blockText).join('\n\n').trim();
  return { entities, text, hasTextAnchor: Boolean(text || textAnchor || snapshots.length || commentBlockIds(comment).length) };
}
