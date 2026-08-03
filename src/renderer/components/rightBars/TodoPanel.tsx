import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useAuthStore } from '../../store/auth';
import { useComment } from '../../usecase/useComment';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { createPlainCommentDoc } from '../../domain/comment';
import type { EntityKind } from '../../lib/extensions/entity-link';
import type { FocusedEntity } from './MemoMaterialPanel';
import type { RelationTarget } from './EntityRelationPicker';
import {
  ComposeTodoDialog,
  ResolvedTodoArchive,
  TodoCard,
} from './MemoMaterialPanel';
import { EmptyState } from '../ui/EmptyState';

interface Props {
  /** The currently-focused entity. Used to bias the sort (chapter-related
   *  TODOs surface above unrelated ones) and to pre-fill the compose dialog. */
  focused: FocusedEntity;
}

/**
 * Right-sidebar TODO panel. Companion to LibraryPanel under the same tab
 * tray. Strictly tied to the comment table — every TODO is `comment` row
 * with `kind='todo'`. Open TODOs sit in the main scroll area; resolved ones
 * drop into the bottom-pinned ResolvedTodoArchive drawer.
 *
 * Sort: TODOs whose entity_relation row points at the currently-focused
 * entity (chapter / element / storyline / etc.) surface first; everything
 * else follows in updatedAt-desc order. The author can stay scoped to the
 * current chapter without an explicit filter switch.
 *
 * The compose path is one click: tapping + opens ComposeTodoDialog with the
 * focused entity pre-filled (when it's a valid relation target); the
 * created comment lands as kind='todo', floating (no block anchor), with
 * any picked relations wired in.
 */
export function TodoPanel({ focused }: Props) {
  const { t } = useTranslation();
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const comments = useDataStore((s) => s.comments);
  const entityRelations = useDataStore((s) => s.entityRelations);

  const commentUsecases = useComment({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [composeOpen, setComposeOpen] = useState(false);

  const refsByFrom = useMemo(() => {
    const map = new Map<string, typeof entityRelations>();
    entityRelations.forEach((r) => {
      const key = `${r.fromKind}:${r.fromId}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    });
    return map;
  }, [entityRelations]);

  const isRelatedToFocus = useCallback(
    (kind: EntityKind, id: string) => {
      if (!focused.kind || !focused.id) return false;
      const refs = refsByFrom.get(`${kind}:${id}`) ?? [];
      return refs.some((r) => r.toKind === focused.kind && r.toId === focused.id);
    },
    [refsByFrom, focused.kind, focused.id],
  );

  const todos = useMemo(() => comments.filter((c) => c.kind === 'todo'), [comments]);

  // Open TODOs, sorted with focus-related entries first. Block-anchored
  // TODOs whose target matches focused show up at the very top because
  // they're literally about *this chapter*.
  const openTodos = useMemo(() => {
    return todos
      .filter((c) => c.status === 'open')
      .map((c) => {
        const anchored =
          focused.kind === c.targetKind &&
          focused.id !== null &&
          c.targetId === focused.id;
        const related = anchored || isRelatedToFocus('comment', c.id);
        return { c, related, anchored };
      })
      .sort((a, b) => {
        if (a.anchored !== b.anchored) return a.anchored ? -1 : 1;
        if (a.related !== b.related) return a.related ? -1 : 1;
        return b.c.updatedAt.localeCompare(a.c.updatedAt);
      })
      .map((x) => x.c);
  }, [todos, isRelatedToFocus, focused.kind, focused.id]);

  const resolvedTodos = useMemo(() => {
    return todos
      .filter((c) => c.status !== 'open')
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  }, [todos]);

  const handleCreate = useCallback(
    async (body: string, relations: RelationTarget[]) => {
      const trimmed = body.trim();
      if (!trimmed) return;
      const created = await commentUsecases.createComment({
        kind: 'todo',
        bodyJson: createPlainCommentDoc(trimmed),
      });
      for (const t of relations) {
        await relationUsecases.addRelation('comment', created.id, t.kind, t.id);
      }
      setComposeOpen(false);
    },
    [commentUsecases, relationUsecases],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Subheader count={todos.length} onCompose={() => setComposeOpen(true)} />

      <div
        className="scroll-no-bar workspace-list"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '0 12px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}
      >
        {openTodos.length === 0 && (
          <EmptyState message={t('todoPanel.empty')} />
        )}

        {openTodos.map((c) => (
          <TodoCard
            key={c.id}
            todo={c}
            relations={(refsByFrom.get(`comment:${c.id}`) ?? []).map((r) => ({
              id: r.id,
              toKind: r.toKind,
              toId: r.toId,
            }))}
            showRelations
            onResolve={() => commentUsecases.resolveComment(c.id)}
            onDelete={() => commentUsecases.deleteComment(c.id)}
            onAddRelation={(t) =>
              relationUsecases.addRelation('comment', c.id, t.kind, t.id)
            }
            onRemoveRelation={(t) => {
              const ref = entityRelations.find(
                (r) =>
                  r.fromKind === 'comment' &&
                  r.fromId === c.id &&
                  r.toKind === t.kind &&
                  r.toId === t.id,
              );
              if (ref) relationUsecases.removeRelation(ref.id);
            }}
          />
        ))}
      </div>

      <ResolvedTodoArchive
        todos={resolvedTodos}
        onReopen={(id) => commentUsecases.reopenComment(id)}
        onDelete={(id) => commentUsecases.deleteComment(id)}
      />

      {composeOpen && (
        <ComposeTodoDialog
          focused={focused}
          onCancel={() => setComposeOpen(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subheader — count + add button. No filter pills, no relations toggle.
// Count is dropped first when the toolbar narrows (panel width < 200px).

function Subheader({ count, onCompose }: { count: number; onCompose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement | null>(null);
  const [showCount, setShowCount] = useState(true);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setShowCount(node.clientWidth >= 200);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px 6px 12px',
        borderBottom: '1px solid hsl(var(--rule))',
        gap: 6,
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        zIndex: 4,
        background: 'hsl(var(--paper))',
      }}
    >
      {showCount ? (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            color: 'hsl(var(--ink-4))',
            letterSpacing: '0.08em',
          }}
        >
          {count} TODO
        </span>
      ) : (
        <span />
      )}
      <button
        onClick={onCompose}
        title={t('todoPanel.newTodo')}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 3,
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-4))',
          cursor: 'pointer',
          padding: 0,
          transition: 'background 0.12s, color 0.12s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'hsl(var(--paper-deep))';
          e.currentTarget.style.color = 'hsl(var(--ink-1))';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'hsl(var(--ink-4))';
        }}
      >
        <Plus size={12} strokeWidth={1.6} />
      </button>
    </div>
  );
}
