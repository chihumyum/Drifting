import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Comment } from '../../domain/comment';
import { extractTextFromCommentBody } from '../../domain/comment';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';
import { CommentBodyEditor } from '../comments/CommentBodyEditor';
import { TodoStatusToggle } from '../comments/TodoStatusToggle';
import { CommentSourceHoverCard } from '../comments/CommentSourceHoverCard';
import { useCommentSourceHover } from '../comments/use-comment-source-hover';

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
  const isBlockAnchored = todo.targetKind === 'node' && !!todo.targetId && !!todo.targetBlockId;
  const statusToggle = <TodoStatusToggle resolved={todo.status === 'resolved'} onToggle={onToggleResolved} />;

  // Block-anchored TODOs jump to their source block: open the chapter tab, then
  // scroll + flash the block once the editor has mounted it.
  const jumpToAnchor = useCallback(() => {
    if (!todo.targetId || !todo.targetBlockId) return;
    open({ entityType: 'node', id: todo.targetId });
    scrollToBlockWhenReady(todo.targetId, todo.targetBlockId);
  }, [open, todo.targetId, todo.targetBlockId]);

  return (
    <div
      className="workspace-list-row"
      aria-describedby={sourceHover.anchor ? sourceHover.id : undefined}
      onPointerDownCapture={sourceHover.onLeave}
      onKeyDownCapture={sourceHover.onLeave}
      onContextMenuCapture={sourceHover.onLeave}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (!event.currentTarget.contains(target)) return;
        if (editing || target.closest('button, a, input, textarea, [role="button"], [contenteditable="true"]')) return;
        sourceHover.onLeave();
        setEditing(true);
      }}
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
        {isBlockAnchored && (
          <button
            onClick={jumpToAnchor}
            title={t('memoMaterial.todo.jumpToBlock')}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              font: 'inherit',
              letterSpacing: 'inherit',
              textTransform: 'inherit',
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'hsl(var(--story-2))')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'hsl(var(--ink-4))')}
          >
            ⊕ block
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
          ×
        </button>
      </div>

      {editing ? (
        <CommentBodyEditor text={text} onSave={onSave} onClose={() => setEditing(false)} />
      ) : (
        <div
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
            ＋ {t('memoMaterial.menu.relation')}
          </button>
          {statusToggle}
        </div>
      )}
      {sourceHover.anchor && <CommentSourceHoverCard comment={todo} relations={relations} anchor={sourceHover.anchor} id={sourceHover.id} />}
    </div>
  );
}
