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
import { getPlatformRuntime } from '../../platform/runtime';

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
  const [hover, setHover] = useState(false);
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
    // The desktop draws the anchor again in sand rather than flashing its block.
    const sand = !getPlatformRuntime().isMobileShell;
    if (sand) selectCommentHighlight(todo.id);
    if (todo.targetBlockId) scrollToBlockWhenReady(todo.targetId, todo.targetBlockId, { flash: !sand });
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

  // Desktop: a card with no fill and the resting line of glass that flows
  // under the pointer. The paused mobile shell keeps the older card below.
  if (!getPlatformRuntime().isMobileShell) {
    const resolved = todo.status === 'resolved';
    return (
      <div
        className={`todo-card todo-card--glass glass glass--rest glass--surface${resolved ? ' todo-card--resolved' : ''}`}
        aria-describedby={sourceHover.anchor ? sourceHover.id : undefined}
        onPointerDownCapture={sourceHover.dismiss}
        onKeyDownCapture={sourceHover.dismiss}
        onContextMenuCapture={sourceHover.dismiss}
        onMouseEnter={(event) => { setHover(true); sourceHover.onEnter(event.currentTarget); }}
        onMouseLeave={() => { setHover(false); sourceHover.onLeave(); }}
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
            <button type="button" className="todo-card__relate" onClick={() => setPickerOpen(true)}>
              <BrushIcon name="plus" size={10} inline /> {t('memoMaterial.menu.relation')}
            </button>
            {statusToggle}
          </div>
        )}
        {sourceHover.anchor && <CommentSourceHoverCard comment={todo} relations={relations} anchor={sourceHover.anchor} id={sourceHover.id} />}
      </div>
    );
  }

  return (
    <div
      className="workspace-list-row"
      aria-describedby={sourceHover.anchor ? sourceHover.id : undefined}
      onPointerDownCapture={sourceHover.dismiss}
      onKeyDownCapture={sourceHover.dismiss}
      onContextMenuCapture={sourceHover.dismiss}
      onMouseEnter={(event) => { setHover(true); sourceHover.onEnter(event.currentTarget); }}
      onMouseLeave={() => { setHover(false); sourceHover.onLeave(); }}
      style={{
        padding: '7px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        flexShrink: 0,
      }}
    >
      <div
        className="todo-card__header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'hsl(var(--ink-4))',
        }}
      >
        <span style={{ color: 'hsl(var(--story-2))' }}>TODO</span>
        {canJump && (
          <button
            type="button"
            className="review-card__text-link-button"
            onClick={jumpToAnchor}
            title={t('reviewPanel.jumpToText')}
            aria-label={t('reviewPanel.jumpToText')}
          >
            <BrushIcon name="arrow-back" size={10} />
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={onDelete}
          title={t('common.delete')}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
            opacity: hover ? 1 : 0,
            transition: 'opacity 120ms ease',
            padding: '0 2px',
          }}
        >
          <BrushIcon name="close" size={10} inline />
        </button>
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
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 13,
            color: 'hsl(var(--ink-1))',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.4,
          }}
        >
          {text || <em style={{ color: 'hsl(var(--ink-4))' }}>{t('memoMaterial.todo.empty')}</em>}
        </div>
      )}

      {showPicker && (
        <div style={{ marginTop: 2 }}>
          <EntityRelationPicker
            selected={selectedSet}
            onAdd={(t) => {
              onAddRelation(t);
              setPickerOpen(false);
            }}
            onRemove={(t) => onRemoveRelation(t)}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            trailingAction={statusToggle}
          />
        </div>
      )}
      {!showPicker && (
        <div className="todo-card__footer">
          <button
            className="todo-card__relation-button"
            onClick={() => setPickerOpen(true)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 3,
              border: '1px dashed hsl(var(--rule-strong))',
              background: 'transparent',
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
            }}
          >
            <BrushIcon name="plus" size={10} inline /> {t('memoMaterial.menu.relation')}
          </button>
          {statusToggle}
        </div>
      )}
      {sourceHover.anchor && <CommentSourceHoverCard comment={todo} relations={relations} anchor={sourceHover.anchor} id={sourceHover.id} />}
    </div>
  );
}
