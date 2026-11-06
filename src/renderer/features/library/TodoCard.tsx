import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Comment } from '../../domain/comment';
import { extractTextFromCommentBody } from '../../domain/comment';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { selectCommentHighlight } from '../../lib/comment-highlight';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { CommentBodyEditor } from '../comments/CommentBodyEditor';
import { TodoStatusToggle } from '../comments/TodoStatusToggle';
import { CommentSourceHoverCard } from '../comments/CommentSourceHoverCard';
import { useCommentSourceHover } from '../comments/use-comment-source-hover';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { GhostIconButton } from '../../components/ui/GhostIconButton';

export function TodoCard({
  todo,
  relations,
  showRelations = true,
  onToggleResolved,
  onDelete,
  onSave,
  onAddRelation,
  onRemoveRelation,
}: {
  todo: Comment;
  relations: { id: string; toKind: EntityKind; toId: string }[];
  showRelations?: boolean;
  onToggleResolved: () => void;
  onDelete: () => void;
  onSave: (body: string) => Promise<unknown>;
  onAddRelation: (t: RelationTarget) => void;
  onRemoveRelation: (t: RelationTarget) => void;
}) {
  const { t } = useTranslation();
  const { open } = useWorkspaceNavigator();
  const text = extractTextFromCommentBody(todo.bodyJson);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const sourceHover = useCommentSourceHover(!editing && !pickerOpen);
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.toKind}:${r.toId}`)),
    [relations],
  );
  const showPicker = pickerOpen || (showRelations && selectedSet.size > 0);
  const canJump = Boolean(todo.targetKind && todo.targetKind !== 'patch' && todo.targetId);
  const statusToggle = <TodoStatusToggle resolved={todo.status === 'resolved'} onToggle={onToggleResolved} />;

  // Open the source entity, then reveal its block when an anchor is available.
  const jumpToAnchor = useCallback(() => {
    if (!todo.targetKind || todo.targetKind === 'patch' || !todo.targetId) return;
    open({ entityType: todo.targetKind, id: todo.targetId });
    // The anchor is drawn again in sand rather than flashing its block.
    selectCommentHighlight(todo.id);
    if (todo.targetBlockId) scrollToBlockWhenReady(todo.targetId, todo.targetBlockId, { flash: false });
  }, [open, todo.id, todo.targetKind, todo.targetId, todo.targetBlockId]);

  const picker = (onPicked: boolean) => (
    <EntityRelationPicker
      selected={selectedSet}
      onAdd={(t) => {
        onAddRelation(t);
        if (onPicked) setPickerOpen(false);
      }}
      onRemove={(t) => onRemoveRelation(t)}
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      trailingAction={statusToggle}
    />
  );

  // A card with no fill and the resting line of glass that flows under the
  // pointer.
  const resolved = todo.status === 'resolved';
  return (
    <div
      className={`todo-card todo-card--glass glass glass--rest glass--surface${resolved ? ' todo-card--resolved' : ''}`}
      aria-describedby={sourceHover.anchor ? sourceHover.id : undefined}
      onPointerDownCapture={sourceHover.dismiss}
      onKeyDownCapture={sourceHover.dismiss}
      onContextMenuCapture={sourceHover.dismiss}
      onMouseEnter={(event) => sourceHover.onEnter(event.currentTarget)}
      onMouseLeave={sourceHover.onLeave}
    >
      <div className="todo-card__header">
        <span className="todo-card__kind">TODO</span>
        {canJump && (
          <GhostIconButton
            size="sm"
            icon={<BrushIcon name="arrow-back" size={10} />}
            onClick={jumpToAnchor}
            title={t('reviewPanel.jumpToText')}
            aria-label={t('reviewPanel.jumpToText')}
          />
        )}
        <span style={{ flex: 1 }} />
        <GhostIconButton
          size="sm"
          className="todo-card__delete"
          icon={<BrushIcon name="trash" size={11} />}
          onClick={onDelete}
          title={t('common.delete')}
          aria-label={t('common.delete')}
        />
      </div>
      {editing ? (
        <CommentBodyEditor text={text} onSave={onSave} onClose={() => setEditing(false)} />
      ) : (
        <div
          className="todo-card__body"
          onDoubleClick={(event) => {
            event.stopPropagation();
            sourceHover.dismiss();
            setEditing(true);
          }}
        >
          {text || <em style={{ color: 'hsl(var(--ink-4))' }}>{t('memoMaterial.todo.empty')}</em>}
        </div>
      )}
      {showPicker ? (
        <div style={{ marginTop: 2 }}>{picker(true)}</div>
      ) : (
        <div className="todo-card__footer">
          <button type="button" className="relation-add-button" onClick={() => setPickerOpen(true)}>
            <BrushIcon name="plus" size={10} inline /> {t('memoMaterial.menu.relation')}
          </button>
          {statusToggle}
        </div>
      )}
      {sourceHover.anchor && <CommentSourceHoverCard comment={todo} relations={relations} anchor={sourceHover.anchor} id={sourceHover.id} />}
    </div>
  );
}
