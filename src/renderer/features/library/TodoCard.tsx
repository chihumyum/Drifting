import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Comment } from '../../domain/comment';
import { extractTextFromCommentBody } from '../../domain/comment';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { useWorkspaceNavigator } from '../workspace/navigation/WorkspaceNavigationContext';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { EntityRelationPicker, type RelationTarget } from '../../components/rightBars/EntityRelationPicker';

export function TodoCard({
  todo,
  relations,
  showRelations = true,
  onResolve,
  onDelete,
  onAddRelation,
  onRemoveRelation,
}: {
  todo: Comment;
  relations: { id: string; toKind: EntityKind; toId: string }[];
  showRelations?: boolean;
  onResolve: () => void;
  onDelete: () => void;
  onAddRelation: (t: RelationTarget) => void;
  onRemoveRelation: (t: RelationTarget) => void;
}) {
  const { t } = useTranslation();
  const { open } = useWorkspaceNavigator();
  const text = extractTextFromCommentBody(todo.bodyJson);
  const [hover, setHover] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.toKind}:${r.toId}`)),
    [relations],
  );
  const showPicker = pickerOpen || (showRelations && selectedSet.size > 0);
  const isBlockAnchored = todo.targetKind === 'node' && !!todo.targetId && !!todo.targetBlockId;

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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
          onClick={onResolve}
          title={t('memoMaterial.todo.markDone')}
          aria-label={t('memoMaterial.todo.markDone')}
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '1.5px solid hsl(var(--story-2))',
            background: 'transparent',
            cursor: 'pointer',
            padding: 0,
            flexShrink: 0,
          }}
        />
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
          />
        </div>
      )}
      {!showPicker && (
        <button
          onClick={() => setPickerOpen(true)}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            border: '1px dashed hsl(var(--rule))',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          ＋ {t('memoMaterial.menu.relation')}
        </button>
      )}
    </div>
  );
}
