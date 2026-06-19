import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Link2Off, Plus } from 'lucide-react';
// Use the "legacy" build: pdf.js v5's modern bundle calls
// `Map.prototype.getOrInsertComputed`, a TC39 Stage 2.7 proposal not yet in
// Electron 40's V8. The legacy build ships the polyfill.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useAuthStore } from '../../store/auth';
import { useLibraryItem } from '../../usecase/useLibraryItem';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import { extractTextFromCommentBody } from '../../domain/comment';
import type { Comment } from '../../domain/comment';
import type { LibraryItem, LibraryItemKind } from '../../domain/library-item';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { isStructuralEntityKind } from '../../domain/entity-kinds';
import { scrollToBlockWhenReady } from '../../lib/scroll-to-block';
import { EntityRelationPicker, type RelationTarget } from './EntityRelationPicker';
import { CollapsibleFooter } from '../ui/CollapsibleFooter';
import '../../../styles/bottom-timeline.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

/** Strip the directory parts so cards can show "draft.pdf" instead of the
 *  full absolute path. Handles both posix and windows separators. */
function basename(path: string | null | undefined): string {
  if (!path) return '';
  const cleaned = path.replace(/^file:\/\//, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/** Best-effort display label for the secondary line under a material title.
 *  For local files we show the basename; for URLs we show the hostname. */
function libraryItemSubtitle(m: LibraryItem): string {
  if (m.kind === 'url') {
    try {
      return new URL(m.uri).hostname.replace(/^www\./, '');
    } catch {
      return m.uri;
    }
  }
  return basename(m.localPath ?? m.uri);
}

function localLibraryItemUrl(m: LibraryItem): string | null {
  if (m.localPath) return `file://${m.localPath}`;
  if (m.uri.startsWith('file://')) return m.uri;
  return null;
}

function libraryItemImageSrc(m: LibraryItem): string | null {
  if (m.kind !== 'image') return null;
  return localLibraryItemUrl(m);
}

function libraryItemPdfSrc(m: LibraryItem): string | null {
  if (m.kind !== 'pdf') return null;
  return localLibraryItemUrl(m);
}

function clampLibraryItemPreviewScale(scale: number): number {
  return Math.min(6, Math.max(1, scale));
}

/** Close a transient surface (dialog / dropdown / popover) on Escape, and
 *  blur whatever the user just clicked so the close button doesn't keep
 *  its focus ring after dismissal. */
function useEscapeToClose(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      // Drop focus so the trigger button doesn't stay in the hover/active
      // state after the surface closes.
      if (
        document.activeElement instanceof HTMLElement &&
        document.activeElement !== document.body
      ) {
        document.activeElement.blur();
      }
      onClose();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [active, onClose]);
}

export interface FocusedEntity {
  kind: EntityKind | null;
  id: string | null;
}

interface Props {
  /** The currently-focused entity (for the "仅当前条目相关" filter mode). */
  focused: FocusedEntity;
}

type ViewFilter = 'all' | 'related';

/**
 * Right-sidebar Library panel. Renders library_item rows (formerly material)
 * covering image / pdf / url / text references and free-form notes.
 *
 * Image / pdf hand off to the OS default app; url opens externally; text
 * opens an inline snippet popover that can escalate to fullscreen.
 *
 * The `related` filter narrows the list to items whose entity_relation row
 * points at `focused`. The relations toggle hides/shows relation chips
 * across all cards.
 *
 * TODOs live in the sibling TodoPanel, not here.
 */
export function LibraryPanel({ focused }: Props) {
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const libraryItems = useDataStore((s) => s.libraryItems);
  const entityRelations = useDataStore((s) => s.entityRelations);

  const libraryItemUsecases = useLibraryItem({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [filter, setFilter] = useState<ViewFilter>('all');
  const [showRelations, setShowRelations] = useState(true);
  const [composeOpen, setComposeOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewLibraryItemId, setPreviewLibraryItemId] = useState<string | null>(null);
  // Two-stage preview for text snippets: clicking the inline body opens this
  // popover first; the popover itself escalates to the fullscreen preview.
  // Mirrors StoryGraphView's NodeCardPopover default → upgrade flow.
  const [textPopoverId, setTextPopoverId] = useState<string | null>(null);

  // Index entityRelations by from-entity so cards can render their relation
  // chips and the filter can pick out items related to `focused`.
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
      if (!focused.kind || !focused.id) return true;
      const refs = refsByFrom.get(`${kind}:${id}`) ?? [];
      return refs.some((r) => r.toKind === focused.kind && r.toId === focused.id);
    },
    [refsByFrom, focused.kind, focused.id],
  );

  const filteredLibraryItems = useMemo(() => {
    return libraryItems.filter(
      (mat) => filter !== 'related' || isRelatedToFocus('library_item', mat.id),
    );
  }, [libraryItems, filter, isRelatedToFocus]);

  const previewLibraryItem = useMemo(
    () => libraryItems.find((mat) => mat.id === previewLibraryItemId) ?? null,
    [libraryItems, previewLibraryItemId],
  );

  const textPopoverLibraryItem = useMemo(
    () => libraryItems.find((mat) => mat.id === textPopoverId) ?? null,
    [libraryItems, textPopoverId],
  );

  const openLibraryItemInSystem = async (m: LibraryItem) => {
    // text snippets are edited inline on the card — no popover / OS hand-off.
    if (m.kind === 'text') return;
    if (m.kind === 'url') {
      await window.electronAPI.material.openExternal(m.uri);
      return;
    }
    // image / pdf — local file goes through the OS default app.
    const path = m.localPath ?? m.uri.replace(/^file:\/\//, '');
    if (!path) return;
    const res = await window.electronAPI.material.openLocal(path);
    if (!res.ok) {
      alert(`无法打开文件：${res.error}`);
    }
  };

  const openLibraryItemInApp = (m: LibraryItem) => {
    if (m.kind === 'url') {
      void openLibraryItemInSystem(m);
      return;
    }
    if (m.kind === 'text') {
      // First stage of the two-step preview — open the floating popover
      // instead of jumping straight to fullscreen. The popover renders a
      // 全屏 ↗ control that does the actual escalation.
      setTextPopoverId(m.id);
      return;
    }
    setPreviewLibraryItemId(m.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Toolbar
        filter={filter}
        onFilterChange={setFilter}
        focusedKind={focused.kind}
        onCompose={() => setComposeOpen(true)}
        libraryItemTotal={libraryItems.length}
        showRelations={showRelations}
        onToggleShowRelations={() => setShowRelations((v) => !v)}
      />

      <div
        className="scroll-no-bar"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '8px 12px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {filteredLibraryItems.length === 0 && (
          <EmptyState
            message={
              filter === 'related'
                ? '当前条目没有关联的素材。'
                : '还没有素材。点击右上 "+" 新建。'
            }
          />
        )}

        {filteredLibraryItems.map((mat) => (
          <LibraryItemCard
            key={mat.id}
            material={mat}
            relations={refsByFrom.get(`library_item:${mat.id}`) ?? []}
            editing={editingId === mat.id}
            showRelations={showRelations}
            onSetEditing={(on) => setEditingId(on ? mat.id : null)}
            onOpenInSystem={() => openLibraryItemInSystem(mat)}
            onOpenInApp={() => openLibraryItemInApp(mat)}
            onUpdate={(updates) => libraryItemUsecases.updateLibraryItem(mat.id, updates)}
            onDelete={() => libraryItemUsecases.removeLibraryItem(mat.id)}
            onAddRelation={(t) =>
              relationUsecases.addRelation('library_item', mat.id, t.kind, t.id)
            }
            onRemoveRelation={(t) => {
              const ref = entityRelations.find(
                (r) =>
                  r.fromKind === 'library_item' &&
                  r.fromId === mat.id &&
                  r.toKind === t.kind &&
                  r.toId === t.id,
              );
              if (ref) relationUsecases.removeRelation(ref.id);
            }}
          />
        ))}
      </div>

      {composeOpen && (
        <ComposeLibraryItemDialog
          focused={focused}
          onCancel={() => setComposeOpen(false)}
          onCreate={async (input, relations) => {
            const mat = await libraryItemUsecases.createLibraryItem(input);
            await Promise.all(
              relations.map((t) => relationUsecases.addRelation('library_item', mat.id, t.kind, t.id)),
            );
            setComposeOpen(false);
          }}
        />
      )}

      {previewLibraryItem && (
        <LibraryItemFullscreenPreview
          key={previewLibraryItem.id}
          material={previewLibraryItem}
          onClose={() => setPreviewLibraryItemId(null)}
          onUpdate={(updates) => libraryItemUsecases.updateLibraryItem(previewLibraryItem.id, updates)}
        />
      )}

      {textPopoverLibraryItem && (
        <TextSnippetPopover
          key={textPopoverLibraryItem.id}
          material={textPopoverLibraryItem}
          onClose={() => setTextPopoverId(null)}
          onExpand={() => {
            setTextPopoverId(null);
            setPreviewLibraryItemId(textPopoverLibraryItem.id);
          }}
          onUpdate={(updates) =>
            libraryItemUsecases.updateLibraryItem(textPopoverLibraryItem.id, updates)
          }
        />
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar (filter chips + "+" menu)

function Toolbar({
  filter,
  onFilterChange,
  focusedKind,
  onCompose,
  libraryItemTotal,
  showRelations,
  onToggleShowRelations,
}: {
  filter: ViewFilter;
  onFilterChange: (f: ViewFilter) => void;
  focusedKind: EntityKind | null;
  onCompose: () => void;
  libraryItemTotal: number;
  showRelations: boolean;
  onToggleShowRelations: () => void;
}) {
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  // Two-step compaction:
  //   showCount goes off first (~ 230px) — least informational signal.
  //   compact (short pill labels) flips a bit later (~ 200px).
  const [showCount, setShowCount] = useState(true);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const node = toolbarRef.current;
    if (!node) return;
    const update = () => {
      const w = node.clientWidth;
      setShowCount(w >= 230);
      setCompact(w < 200);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={toolbarRef}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px 6px 12px',
        borderBottom: '1px solid hsl(var(--rule))',
        gap: 6,
        flexShrink: 0,
        // Pin the toolbar to the top of the scroll container so the filter
        // chips + "+" button don't slide away when the cards list scrolls.
        position: 'sticky',
        top: 0,
        zIndex: 4,
        background: 'hsl(var(--paper))',
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        <FilterPill active={filter === 'all'} onClick={() => onFilterChange('all')}>
          {compact ? 'All' : '全部'}
        </FilterPill>
        <FilterPill
          active={filter === 'related'}
          disabled={!focusedKind}
          onClick={() => onFilterChange('related')}
        >
          {compact ? 'Cur' : '仅当前条目'}
        </FilterPill>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-4))',
          letterSpacing: '0.08em',
        }}
      >
        {showCount && <span>{libraryItemTotal} 素材</span>}
        <button
          onClick={onToggleShowRelations}
          title={showRelations ? '隐藏关联' : '显示关联'}
          aria-pressed={showRelations}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 3,
            border: 'none',
            background: 'transparent',
            color: showRelations ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-4))',
            cursor: 'pointer',
            padding: 0,
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'hsl(var(--paper-deep))';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {showRelations ? (
            <Link2 size={12} strokeWidth={1.6} />
          ) : (
            <Link2Off size={12} strokeWidth={1.6} />
          )}
        </button>
        <button
          onClick={onCompose}
          title="新建素材"
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
    </div>
  );
}

function FilterPill({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        padding: '1px 8px',
        borderRadius: 12,
        border: `1px solid ${active ? 'hsl(var(--ink-1))' : 'hsl(var(--rule))'}`,
        background: active ? 'hsl(var(--ink-1) / 0.06)' : 'transparent',
        color: disabled
          ? 'hsl(var(--ink-5))'
          : active
            ? 'hsl(var(--ink-1))'
            : 'hsl(var(--ink-3))',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LibraryItem context menu

type LibraryItemContextMenuAction = 'addRelation' | 'openInSystem' | 'delete';

function LibraryItemContextMenuItem({
  glyph,
  label,
  action,
  onAction,
  variant = 'default',
}: {
  glyph: string;
  label: string;
  action: LibraryItemContextMenuAction;
  onAction: (action: LibraryItemContextMenuAction) => void;
  variant?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`btl-cmenu__item${variant === 'danger' ? ' is-danger' : ''}`}
      onClick={() => onAction(action)}
    >
      <span className="btl-cmenu__glyph" aria-hidden>
        {glyph}
      </span>
      <span className="btl-cmenu__label">{label}</span>
    </button>
  );
}

function LibraryItemContextMenu({
  material,
  relationCount,
  x,
  y,
  onOpenInSystem,
  onAddRelation,
  onDelete,
  onClose,
}: {
  material: LibraryItem;
  relationCount: number;
  x: number;
  y: number;
  onOpenInSystem: () => void;
  onAddRelation: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const isTextSnippet = material.kind === 'text';
  const kindLabel = LIBRARY_ITEM_KIND_LABEL[material.kind] ?? material.kind;
  const subtitle = libraryItemSubtitle(material);

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const padding = 8;
    let left = x;
    let top = y;
    if (left + rect.width + padding > window.innerWidth) {
      left = Math.max(padding, window.innerWidth - rect.width - padding);
    }
    if (top + rect.height + padding > window.innerHeight) {
      top = Math.max(padding, window.innerHeight - rect.height - padding);
    }
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDocPointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onScrollOrResize = () => onClose();
    document.addEventListener('mousedown', onDocPointer, true);
    document.addEventListener('contextmenu', onDocPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('contextmenu', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [onClose]);

  const handleAction = (action: LibraryItemContextMenuAction) => {
    if (action === 'addRelation') onAddRelation();
    if (action === 'openInSystem') onOpenInSystem();
    if (action === 'delete') onDelete();
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="btl-cmenu"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: pos.left, top: pos.top, zIndex: 10000 }}
    >
      <div className="btl-cmenu__head">
        <div className="btl-cmenu__title">{material.title || subtitle || '无标题'}</div>
        <div className="btl-cmenu__summary">类型：{kindLabel}</div>
        <div className="btl-cmenu__summary">
          {relationCount > 0 ? `已关联 ${relationCount} 项` : '未关联'}
        </div>
      </div>

      <div className="btl-cmenu__group">
        <LibraryItemContextMenuItem
          glyph="＋"
          label="关联…"
          action="addRelation"
          onAction={handleAction}
        />
      </div>

      {!isTextSnippet && (
        <div className="btl-cmenu__group">
          <LibraryItemContextMenuItem
            glyph="↗"
            label="在系统app中打开"
            action="openInSystem"
            onAction={handleAction}
          />
        </div>
      )}

      <div className="btl-cmenu__group">
        <LibraryItemContextMenuItem
          glyph="×"
          label="删除材料"
          action="delete"
          onAction={handleAction}
          variant="danger"
        />
      </div>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO card — Comment with kind='todo' rendered as a checklist row.

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
  const { navigateToNode } = useProjectNavigation();
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
    navigateToNode(todo.targetId);
    scrollToBlockWhenReady(todo.targetId, todo.targetBlockId);
  }, [navigateToNode, todo.targetId, todo.targetBlockId]);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '7px 10px',
        borderRadius: 4,
        border: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--surface))',
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
            title="跳转到关联 block"
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
          title="标记为已完成"
          aria-label="标记为已完成"
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
          title="删除"
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
          fontFamily: 'var(--font-serif)',
          fontSize: 13,
          color: 'hsl(var(--ink-1))',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.4,
        }}
      >
        {text || <em style={{ color: 'hsl(var(--ink-4))' }}>(空 TODO)</em>}
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
          ＋ 关联
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LibraryItem card

export function LibraryItemCard({
  material,
  relations,
  editing,
  showRelations = true,
  onSetEditing,
  onOpenInSystem,
  onOpenInApp,
  onUpdate,
  onDelete,
  onAddRelation,
  onRemoveRelation,
  defaultExpanded = false,
}: {
  material: LibraryItem;
  relations: { id: string; toKind: EntityKind; toId: string }[];
  editing: boolean;
  /** When false, hide the relation chips/picker entirely even if relations
   *  exist. Controlled from the panel toolbar's link toggle. */
  showRelations?: boolean;
  onSetEditing: (on: boolean) => void;
  onOpenInSystem: () => void;
  onOpenInApp: () => void;
  onUpdate: (updates: Partial<LibraryItem>) => void;
  onDelete: () => void;
  onAddRelation: (t: RelationTarget) => void;
  onRemoveRelation: (t: RelationTarget) => void;
  /** Pre-expand image / text bodies on mount. Used by the global super view
   *  where there's enough vertical room to show full bodies up front. */
  defaultExpanded?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(material.title);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(defaultExpanded);
  const [textExpanded, setTextExpanded] = useState(defaultExpanded);
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.toKind}:${r.toId}`)),
    [relations],
  );
  // Picker is mounted when: user explicitly opened it from the context menu,
  // OR relations exist AND the panel-wide toggle is on. Collapsing the toggle
  // hides existing relations on every card; opening via context menu still
  // works even when collapsed (lasts until the user closes the picker).
  const showPicker = pickerOpen || (showRelations && selectedSet.size > 0);
  const accent = 'hsl(var(--story-4))';
  const kindLabel = LIBRARY_ITEM_KIND_LABEL[material.kind] ?? material.kind;
  const subtitle = libraryItemSubtitle(material);
  const isTextSnippet = material.kind === 'text';
  const imageSrc = libraryItemImageSrc(material);
  const isImageExpanded = material.kind === 'image' && imageExpanded && !!imageSrc;
  const isTextExpanded = isTextSnippet && textExpanded;
  // Auto-generate PDF thumbnails the first time a card renders. macOS Quick
  // Look (via nativeImage.createThumbnailFromPath) renders the first page;
  // cache the resulting data URL on the material so we don't redo it.
  useEffect(() => {
    if (material.kind !== 'pdf') return;
    if (material.thumbnailUri) return;
    if (!material.localPath) return;
    let cancelled = false;
    void window.electronAPI.material.thumbnail(material.localPath, 192).then((res) => {
      if (cancelled || !res.ok) return;
      onUpdate({ thumbnailUri: res.dataUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [material.id, material.kind, material.localPath, material.thumbnailUri, onUpdate]);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const openContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onContextMenu={openContextMenu}
        style={{
          padding: '8px 10px',
          borderRadius: 4,
          border: '1px solid hsl(var(--rule))',
          background: 'hsl(var(--surface))',
          maxHeight: isTextExpanded ? 'none' : 320,
          overflow: isTextExpanded ? 'visible' : 'hidden',
          display: 'flex',
          flexDirection: 'column',
          // Prevents the flex-column scroll parent from shrinking each card
          // and clipping the relation picker.
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 3,
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: 'hsl(var(--ink-4))',
            flexShrink: 0,
            minHeight: 18,
          }}
        >
          <span style={{ color: accent }}>{kindLabel}</span>
          <span style={{ flex: 1 }} />
          {material.kind === 'image' && imageSrc && (
            <button
              onClick={() => setImageExpanded((v) => !v)}
              title={imageExpanded ? '收起图片' : '展开图片'}
              aria-hidden={!hover}
              tabIndex={hover ? 0 : -1}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 2,
                border: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-2))',
                cursor: 'pointer',
                opacity: hover ? 1 : 0,
                pointerEvents: hover ? 'auto' : 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              {imageExpanded ? '收起' : '展开'}
            </button>
          )}
          {isTextSnippet && (
            <button
              onClick={() => setTextExpanded((v) => !v)}
              title={textExpanded ? '收起片段' : '展开片段'}
              aria-hidden={!hover}
              tabIndex={hover ? 0 : -1}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 2,
                border: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-2))',
                cursor: 'pointer',
                opacity: hover ? 1 : 0,
                pointerEvents: hover ? 'auto' : 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              {textExpanded ? '收起' : '展开'}
            </button>
          )}
          {!isTextSnippet && (
            <button
              onClick={onOpenInSystem}
              title="在系统 app 中打开"
              aria-hidden={!hover}
              tabIndex={hover ? 0 : -1}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5,
                padding: '1px 6px',
                borderRadius: 2,
                border: '1px solid hsl(var(--rule))',
                background: 'hsl(var(--paper))',
                color: 'hsl(var(--ink-2))',
                cursor: 'pointer',
                opacity: hover ? 1 : 0,
                pointerEvents: hover ? 'auto' : 'none',
                transition: 'opacity 120ms ease',
              }}
            >
              在系统app中打开
            </button>
          )}
        </div>

        {!isImageExpanded && !isTextExpanded && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minHeight: 0 }}>
            <LibraryItemThumbnail material={material} onClick={onOpenInApp} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {editing ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => {
                    if (draft !== material.title) onUpdate({ title: draft });
                    onSetEditing(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                    if (e.key === 'Escape') {
                      setDraft(material.title);
                      onSetEditing(false);
                      (e.currentTarget as HTMLInputElement).blur();
                    }
                  }}
                  style={{
                    width: '100%',
                    fontFamily: 'var(--font-serif)',
                    fontSize: 13.5,
                    color: 'hsl(var(--ink-1))',
                    lineHeight: 1.35,
                    padding: '2px 4px',
                    border: '1px solid hsl(var(--rule))',
                    borderRadius: 3,
                    background: 'hsl(var(--paper))',
                    outline: 'none',
                  }}
                />
              ) : (
                <div
                  onClick={() => {
                    setDraft(material.title);
                    onSetEditing(true);
                  }}
                  title={material.title || subtitle}
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: 13.5,
                    fontWeight: 500,
                    color: 'hsl(var(--ink-1))',
                    lineHeight: 1.35,
                    cursor: 'text',
                    minHeight: 18,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {material.title || (
                    <span style={{ color: 'hsl(var(--ink-4))', fontStyle: 'italic' }}>
                      {subtitle || '无标题'}
                    </span>
                  )}
                </div>
              )}
              {subtitle && !isTextSnippet && (
                <div
                  title={material.uri}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'hsl(var(--ink-4))',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {subtitle}
                </div>
              )}
            </div>
          </div>
        )}

        {isTextExpanded && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (draft !== material.title) onUpdate({ title: draft });
                  onSetEditing(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === 'Escape') {
                    setDraft(material.title);
                    onSetEditing(false);
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-serif)',
                  fontSize: 13.5,
                  color: 'hsl(var(--ink-1))',
                  lineHeight: 1.35,
                  padding: '2px 4px',
                  border: '1px solid hsl(var(--rule))',
                  borderRadius: 3,
                  background: 'hsl(var(--paper))',
                  outline: 'none',
                }}
              />
            ) : (
              <div
                onClick={() => {
                  setDraft(material.title);
                  onSetEditing(true);
                }}
                title={material.title || subtitle}
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: 'hsl(var(--ink-1))',
                  lineHeight: 1.35,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  cursor: 'text',
                  minHeight: 18,
                }}
              >
                {material.title || (
                  <span style={{ color: 'hsl(var(--ink-4))', fontStyle: 'italic' }}>
                    {subtitle || '无标题'}
                  </span>
                )}
              </div>
            )}
            <div
              onClick={onOpenInApp}
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 12.5,
                color: material.bodyJson ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
                fontStyle: material.bodyJson ? 'normal' : 'italic',
                lineHeight: 1.5,
                cursor: 'text',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {material.bodyJson || '添加片段正文…'}
            </div>
          </div>
        )}

        {isImageExpanded && (
          <button
            type="button"
            onClick={onOpenInApp}
            title="全屏查看图片"
            style={{
              marginTop: 8,
              padding: 0,
              border: '1px solid hsl(var(--rule))',
              borderRadius: 4,
              background: 'hsl(var(--paper-deep) / 0.35)',
              cursor: 'zoom-in',
              overflow: 'hidden',
              width: '100%',
              maxHeight: 220,
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <img
              src={imageSrc}
              alt=""
              style={{
                display: 'block',
                width: '100%',
                height: 'auto',
                maxHeight: 220,
                objectFit: 'contain',
              }}
            />
          </button>
        )}

        {isTextSnippet && !isTextExpanded && (
          <div
            onClick={onOpenInApp}
            style={{
              marginTop: 6,
              fontFamily: 'var(--font-serif)',
              fontSize: 12.5,
              color: material.bodyJson ? 'hsl(var(--ink-2))' : 'hsl(var(--ink-4))',
              fontStyle: material.bodyJson ? 'normal' : 'italic',
              lineHeight: 1.5,
              cursor: 'text',
              maxHeight: 140,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 7,
              WebkitBoxOrient: 'vertical',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {material.bodyJson || '添加片段正文…'}
          </div>
        )}

        {showPicker && (
          <div style={{ marginTop: 6, flexShrink: 0 }}>
            <EntityRelationPicker
              selected={selectedSet}
              onAdd={onAddRelation}
              onRemove={onRemoveRelation}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
            />
          </div>
        )}
      </div>
      {contextMenu && (
        <LibraryItemContextMenu
          material={material}
          relationCount={relations.length}
          x={contextMenu.x}
          y={contextMenu.y}
          onOpenInSystem={onOpenInSystem}
          onAddRelation={() => setPickerOpen(true)}
          onDelete={onDelete}
          onClose={closeContextMenu}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thumbnail — inline preview tile for image / pdf / url libraryItems.

function LibraryItemThumbnail({ material, onClick }: { material: LibraryItem; onClick: () => void }) {
  const size = 64;
  const [errored, setErrored] = useState(false);
  let src: string | null = null;
  if (!errored) {
    if (material.kind === 'image') {
      // webSecurity is disabled in dev, so file:// loads inline. In production
      // the same window config currently applies; if we ever re-enable
      // webSecurity we'll need to register a custom protocol.
      src = libraryItemImageSrc(material);
    } else if (material.kind === 'pdf' && material.thumbnailUri) {
      src = material.thumbnailUri;
    } else if (material.kind === 'url' && material.thumbnailUri) {
      src = material.thumbnailUri;
    }
  }
  if (!src) {
    if (material.kind === 'text' || (material.kind === 'pdf' && !material.localPath)) {
      return null;
    }
    return (
      <div
        onClick={onClick}
        style={{
          width: size,
          height: size,
          flexShrink: 0,
          borderRadius: 3,
          background: 'hsl(var(--paper-deep) / 0.4)',
          border: '1px dashed hsl(var(--rule))',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-4))',
          cursor: 'pointer',
        }}
        title={material.kind === 'pdf' ? '生成预览中…' : '打开'}
      >
        {material.kind === 'pdf' ? '…' : LIBRARY_ITEM_KIND_LABEL[material.kind]}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      onError={() => setErrored(true)}
      onClick={onClick}
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        objectFit: 'cover',
        borderRadius: 3,
        border: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep))',
        cursor: 'pointer',
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Two-stage text snippet popover — first click on a text snippet body opens
// this compact floating editor; an explicit 全屏 ↗ control escalates to the
// fullscreen preview. Mirrors the StoryGraphView NodeCardPopover default/upgrade
// staging so quick reads don't force a fullscreen jump.

export function TextSnippetPopover({
  material,
  onClose,
  onExpand,
  onUpdate,
}: {
  material: LibraryItem;
  onClose: () => void;
  onExpand: () => void;
  onUpdate: (updates: Partial<LibraryItem>) => void;
}) {
  const [draft, setDraft] = useState(material.bodyJson ?? '');
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const persistIfChanged = useCallback(() => {
    const next = draftRef.current;
    if (next !== (material.bodyJson ?? '')) {
      onUpdate({ bodyJson: next });
    }
  }, [material.bodyJson, onUpdate]);

  const close = useCallback(() => {
    persistIfChanged();
    onClose();
  }, [persistIfChanged, onClose]);

  const expand = useCallback(() => {
    persistIfChanged();
    onExpand();
  }, [persistIfChanged, onExpand]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  return createPortal(
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'hsl(var(--ink-1) / 0.22)',
        zIndex: 950,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'hsl(var(--paper))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 6,
          width: 'min(440px, 92vw)',
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 16px 36px -12px hsl(var(--ink-1) / 0.30)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderBottom: '1px solid hsl(var(--rule))',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              color: 'hsl(var(--story-4))',
            }}
          >
            片段
          </span>
          <span
            title={material.title}
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 13.5,
              color: 'hsl(var(--ink-1))',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {material.title || 'Untitled'}
          </span>
          <button
            onClick={expand}
            title="展开全屏 (Stage 2)"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              padding: '3px 8px',
              borderRadius: 3,
              border: '1px solid hsl(var(--rule))',
              background: 'transparent',
              color: 'hsl(var(--ink-2))',
              cursor: 'pointer',
            }}
          >
            全屏 ↗
          </button>
          <button
            onClick={close}
            title="关闭 (Esc)"
            aria-label="关闭"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              padding: '0 6px',
              borderRadius: 3,
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: 12, overflow: 'hidden' }}>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="片段正文…"
            style={{
              width: '100%',
              height: '100%',
              minHeight: 180,
              resize: 'none',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 4,
              padding: '8px 10px',
              background: 'hsl(var(--paper))',
              color: 'hsl(var(--ink-1))',
              fontFamily: 'var(--font-serif)',
              fontSize: 13.5,
              lineHeight: 1.55,
              outline: 'none',
              whiteSpace: 'pre-wrap',
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-screen material preview

type LibraryItemPreviewViewport = {
  scale: number;
  panX: number;
  panY: number;
};

function zoomLibraryItemPreviewAt(
  prev: LibraryItemPreviewViewport,
  scale: number,
  anchorFromCenterX: number,
  anchorFromCenterY: number,
): LibraryItemPreviewViewport {
  if (scale === prev.scale) return prev;
  if (scale <= 1) return { scale: 1, panX: 0, panY: 0 };

  const ratio = scale / prev.scale;
  return {
    scale,
    panX: ratio * prev.panX + (1 - ratio) * anchorFromCenterX,
    panY: ratio * prev.panY + (1 - ratio) * anchorFromCenterY,
  };
}

function isPdfRenderCancel(error: unknown): boolean {
  return error instanceof Error && error.name === 'RenderingCancelledException';
}

export function LibraryItemFullscreenPreview({
  material,
  onClose,
  onUpdate,
}: {
  material: LibraryItem;
  onClose: () => void;
  onUpdate: (updates: Partial<LibraryItem>) => void;
}) {
  const [textDraft, setTextDraft] = useState(() => material.bodyJson ?? '');
  const [viewport, setViewport] = useState({ scale: 1, panX: 0, panY: 0 });
  const previewSurfaceRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef(viewport);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressSurfaceClickRef = useRef(false);
  const imageSrc = libraryItemImageSrc(material);
  const pdfSrc = libraryItemPdfSrc(material);
  const isImagePreview = material.kind === 'image';
  const isPdfPreview = material.kind === 'pdf';
  const isZoomablePreview = isImagePreview || isPdfPreview;

  const close = useCallback(() => {
    if (material.kind === 'text' && textDraft !== (material.bodyJson ?? '')) {
      onUpdate({ bodyJson: textDraft });
    }
    onClose();
  }, [material.kind, material.bodyJson, onClose, onUpdate, textDraft]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const node = previewSurfaceRef.current;
    if (!node || !isZoomablePreview) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const zoomFactor = Math.exp(-event.deltaY * 0.002);
        const rect = node.getBoundingClientRect();
        const anchorFromCenterX = event.clientX - rect.left - rect.width / 2;
        const anchorFromCenterY = event.clientY - rect.top - rect.height / 2;
        setViewport((prev) => {
          const scale = clampLibraryItemPreviewScale(prev.scale * zoomFactor);
          return zoomLibraryItemPreviewAt(prev, scale, anchorFromCenterX, anchorFromCenterY);
        });
        return;
      }

      if (viewportRef.current.scale <= 1) return;
      event.preventDefault();
      event.stopPropagation();
      setViewport((prev) => ({
        ...prev,
        panX: prev.panX - event.deltaX,
        panY: prev.panY - event.deltaY,
      }));
    };

    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
  }, [isZoomablePreview]);

  if (material.kind === 'url') return null;

  const handlePreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isZoomablePreview) return;
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    suppressSurfaceClickRef.current = false;
    if (viewport.scale <= 1) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: viewport.panX,
      panY: viewport.panY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) {
      suppressSurfaceClickRef.current = true;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setViewport((prev) => ({
      ...prev,
      panX: drag.panX + event.clientX - drag.startX,
      panY: drag.panY + event.clientY - drag.startY,
    }));
  };

  const handlePreviewPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pointerStartRef.current = null;
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleSurfaceClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (!isZoomablePreview) return;
    if (suppressSurfaceClickRef.current) {
      suppressSurfaceClickRef.current = false;
      return;
    }
    close();
  };

  const content = (() => {
    if (material.kind === 'image') {
      if (!imageSrc) return <FullscreenEmpty message="无法预览图片" />;
      return (
        <img
          src={imageSrc}
          alt=""
          draggable={false}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            display: 'block',
            transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
            transformOrigin: 'center center',
            transition: 'transform 80ms ease-out',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        />
      );
    }

    if (material.kind === 'pdf') {
      const pdfPath = material.localPath ?? (pdfSrc ? pdfSrc.replace(/^file:\/\//, '') : null);
      if (!pdfPath) return <FullscreenEmpty message="无法预览 PDF" />;
      return <PdfCanvasPreview filePath={pdfPath} viewport={viewport} />;
    }

    return (
      <textarea
        autoFocus
        value={textDraft}
        onChange={(event) => setTextDraft(event.target.value)}
        placeholder="片段正文…"
        style={{
          width: '100%',
          height: '100%',
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'hsl(var(--paper))',
          color: 'hsl(var(--ink-1))',
          fontFamily: 'var(--font-serif)',
          fontSize: 17,
          lineHeight: 1.65,
          padding: 24,
          whiteSpace: 'pre-wrap',
        }}
      />
    );
  })();

  return createPortal(
    <div
      onClick={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        padding: isZoomablePreview ? 0 : '28px 32px',
        background: 'hsl(var(--ink-1) / 0.58)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
      }}
    >
      <div
        ref={previewSurfaceRef}
        onClick={handleSurfaceClick}
        onPointerDown={handlePreviewPointerDown}
        onPointerMove={handlePreviewPointerMove}
        onPointerUp={handlePreviewPointerEnd}
        onPointerCancel={handlePreviewPointerEnd}
        style={{
          width: isZoomablePreview ? '100%' : 'min(1180px, 100%)',
          height: '100%',
          borderRadius: isImagePreview || isPdfPreview ? 0 : 8,
          overflow: 'hidden',
          background: isZoomablePreview ? 'transparent' : 'hsl(var(--paper))',
          border: isImagePreview || isPdfPreview ? 'none' : '1px solid hsl(var(--rule-strong))',
          boxShadow:
            isImagePreview || isPdfPreview
              ? 'none'
              : '0 24px 54px hsl(var(--ink-1) / 0.34)',
          display: 'grid',
          placeItems: 'center',
          cursor: isZoomablePreview && viewport.scale > 1 ? 'grab' : undefined,
          touchAction: isZoomablePreview ? 'none' : 'auto',
          overscrollBehavior: isZoomablePreview ? 'none' : undefined,
        }}
      >
        {content}
      </div>
    </div>,
    document.body,
  );
}

function PdfCanvasPreview({
  filePath,
  viewport,
}: {
  filePath: string;
  viewport: LibraryItemPreviewViewport;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [surfaceSize, setSurfaceSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => {
      setSurfaceSize({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Load via IPC rather than handing pdf.js a `file://` URL — Chromium blocks
  // `fetch('file://…')` from non-file origins (the Vite dev server) regardless
  // of `webSecurity`, so pdf.js's internal fetch silently fails.
  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    void window.electronAPI.material
      .readBytes(filePath)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          console.error('[pdf preview] readBytes failed:', res.error);
          setError('无法打开 PDF');
          return;
        }
        // pdf.js takes ownership of the buffer, so hand it a fresh view.
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(res.bytes) });
        return loadingTask.promise.then((nextDocument) => {
          if (cancelled) {
            void nextDocument.destroy();
            return;
          }
          loadedDocument = nextDocument;
          setPdfDocument(nextDocument);
          setPageCount(nextDocument.numPages);
          setPageNumber(1);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[pdf preview] getDocument failed:', err);
        setError('无法打开 PDF');
      });

    return () => {
      cancelled = true;
      if (loadedDocument) {
        void loadedDocument.destroy();
      } else if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [filePath]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    const canvas = canvasRef.current;

    pdfDocument
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return undefined;

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, surfaceSize.width - 48);
        const availableHeight = Math.max(240, surfaceSize.height - (pageCount > 1 ? 96 : 48));
        const cssScale = Math.max(
          0.18,
          Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height, 1.8),
        );
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const cssViewport = page.getViewport({ scale: cssScale });
        const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });

        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        canvas.style.width = `${Math.floor(cssViewport.width)}px`;
        canvas.style.height = `${Math.floor(cssViewport.height)}px`;

        renderTask = page.render({
          canvas,
          viewport: renderViewport,
        });
        return renderTask.promise;
      })
      .catch((nextError: unknown) => {
        if (cancelled || isPdfRenderCancel(nextError)) return;
        console.error('[pdf preview] render failed:', nextError);
        setError('无法渲染 PDF');
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDocument, pageNumber, pageCount, surfaceSize.height, surfaceSize.width]);

  const goToPreviousPage = useCallback(() => {
    setPageNumber((page) => Math.max(1, page - 1));
  }, []);
  const goToNextPage = useCallback(() => {
    setPageNumber((page) => Math.min(pageCount, page + 1));
  }, [pageCount]);

  // ←/→ flip pages while the preview is mounted. Skip when the user is
  // typing somewhere (defensive — no inputs live inside this overlay today,
  // but the listener is window-level so any future textarea wins).
  useEffect(() => {
    if (!pdfDocument || pageCount <= 1) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'ArrowLeft') goToPreviousPage();
      else goToNextPage();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pdfDocument, pageCount, goToPreviousPage, goToNextPage]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        overflow: 'hidden',
      }}
    >
      {error ? (
        <FullscreenEmpty message={error} />
      ) : !pdfDocument ? (
        <FullscreenEmpty message="加载 PDF…" />
      ) : (
        <canvas
          ref={canvasRef}
          onClick={(event) => event.stopPropagation()}
          style={{
            display: 'block',
            background: 'hsl(var(--paper))',
            transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale})`,
            transformOrigin: 'center center',
            transition: 'transform 80ms ease-out',
            userSelect: 'none',
            WebkitUserSelect: 'none',
          }}
        />
      )}

      {pageCount > 1 && (
        <div
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 18,
            transform: 'translateX(-50%)',
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 8px',
            borderRadius: 999,
            border: '1px solid hsl(var(--rule))',
            background: 'hsl(var(--paper) / 0.88)',
            boxShadow: '0 8px 20px hsl(var(--ink-1) / 0.16)',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'hsl(var(--ink-2))',
          }}
        >
          <PdfPageButton onClick={goToPreviousPage} disabled={pageNumber <= 1}>
            上一页
          </PdfPageButton>
          <span>
            {pageNumber} / {pageCount}
          </span>
          <PdfPageButton onClick={goToNextPage} disabled={pageNumber >= pageCount}>
            下一页
          </PdfPageButton>
        </div>
      )}
    </div>
  );
}

function PdfPageButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: 'none',
        borderRadius: 999,
        background: disabled ? 'transparent' : 'hsl(var(--paper-deep))',
        color: disabled ? 'hsl(var(--ink-5))' : 'hsl(var(--ink-1))',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        padding: '3px 7px',
      }}
    >
      {children}
    </button>
  );
}

function FullscreenEmpty({ message }: { message: string }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-serif)',
        fontSize: 15,
        color: 'hsl(var(--ink-3))',
      }}
    >
      {message}
    </div>
  );
}

export const LIBRARY_ITEM_KIND_LABEL: Record<LibraryItemKind, string> = {
  image: '图片',
  pdf: 'PDF',
  url: 'URL',
  text: '片段',
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolved TODO archive — slim bottom-pinned drawer for resolved/converted
// TODOs, mirroring the old ResolvedArchive layout but with the simpler
// open/resolved bucket the comment model gives us (no three-state machine).

export function ResolvedTodoArchive({
  todos,
  onReopen,
  onDelete,
}: {
  todos: Comment[];
  onReopen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <CollapsibleFooter
      label="已完成"
      count={todos.length}
      expandTitle="展开已完成"
      collapseTitle="收起已完成"
      bodyStyle={{ padding: '4px 10px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      {todos.length === 0 && (
        <div
          style={{
            fontSize: 11,
            color: 'hsl(var(--ink-4))',
            fontStyle: 'italic',
            padding: '8px 4px',
          }}
        >
          无已完成 TODO
        </div>
      )}
      {todos.map((todo) => (
        <div
          key={todo.id}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '4px 6px',
            borderRadius: 3,
            fontSize: 12,
            color: 'hsl(var(--ink-3))',
            opacity: 0.7,
          }}
        >
          <div
            style={{
              flex: 1,
              fontFamily: 'var(--font-serif)',
              textDecoration: 'line-through',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {extractTextFromCommentBody(todo.bodyJson) || '(空 TODO)'}
          </div>
          <button
            onClick={() => onReopen(todo.id)}
            title="重新打开"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'hsl(var(--ink-4))',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '0 4px',
            }}
          >
            ↺
          </button>
          <button
            onClick={() => onDelete(todo.id)}
            title="删除"
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'hsl(var(--ink-4))',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '0 4px',
            }}
          >
            ×
          </button>
        </div>
      ))}
    </CollapsibleFooter>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose dialogs

export function ComposeTodoDialog({
  focused,
  onCancel,
  onCreate,
}: {
  focused: FocusedEntity;
  onCancel: () => void;
  onCreate: (body: string, relations: RelationTarget[]) => Promise<void>;
}) {
  useEscapeToClose(true, onCancel);
  const [body, setBody] = useState('');
  const [relations, setRelations] = useState<RelationTarget[]>(() =>
    focused.kind && focused.id && isStructuralEntityKind(focused.kind)
      ? [{ kind: focused.kind, id: focused.id, label: '(当前条目)' }]
      : [],
  );
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.kind}:${r.id}`)),
    [relations],
  );

  return (
    <DialogShell title="新建 TODO" onCancel={onCancel}>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="待办内容…"
        rows={3}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void onCreate(body, relations);
          }
        }}
        style={dialogTextareaStyle}
      />
      <div style={{ marginTop: 10 }}>
        <EntityRelationPicker
          selected={selectedSet}
          selectedChipMode="toggle"
          onAdd={(t) => setRelations((prev) => [...prev, t])}
          onRemove={(t) =>
            setRelations((prev) => prev.filter((r) => !(r.kind === t.kind && r.id === t.id)))
          }
        />
      </div>
      <DialogActions
        onCancel={onCancel}
        onConfirm={() => onCreate(body, relations)}
        confirmDisabled={!body.trim()}
      />
    </DialogShell>
  );
}

const dialogTextareaStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-serif)',
  fontSize: 13,
  padding: '6px 8px',
  borderRadius: 3,
  border: '1px solid hsl(var(--rule))',
  background: 'hsl(var(--paper))',
  color: 'hsl(var(--ink-1))',
  outline: 'none',
  resize: 'vertical',
  boxSizing: 'border-box',
};

export function ComposeLibraryItemDialog({
  focused,
  onCancel,
  onCreate,
}: {
  focused: FocusedEntity;
  onCancel: () => void;
  onCreate: (
    input: {
      title: string;
      kind: LibraryItemKind;
      source: 'local' | 'url';
      uri: string;
      localPath?: string | null;
      sizeBytes?: number | null;
      thumbnailUri?: string | null;
      bodyJson?: string | null;
    },
    relations: RelationTarget[],
  ) => Promise<void>;
}) {
  const [kind, setKind] = useState<LibraryItemKind>('url');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const [urlMeta, setUrlMeta] = useState<{
    title: string | null;
    ogImage: string | null;
    favicon: string | null;
  } | null>(null);
  const [resolving, setResolving] = useState(false);
  const titleAutoFilled = useRef(false);
  const [relations, setRelations] = useState<RelationTarget[]>(() =>
    // Pre-fill the new comment / library item with the currently-focused entity, but
    // only when it's a valid relation target (structural). If the user is
    // looking at a comment / library item themselves, skip the pre-fill — those
    // kinds aren't legal toKinds.
    focused.kind && focused.id && isStructuralEntityKind(focused.kind)
      ? [{ kind: focused.kind, id: focused.id, label: '(当前条目)' }]
      : [],
  );
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.kind}:${r.id}`)),
    [relations],
  );

  // Debounce-resolve the URL meta as the user pastes / types. Pre-fills the
  // title if the user hasn't typed one (or only kept the value we auto-filled),
  // and stashes og:image for the thumbnail slot on submit.
  useEffect(() => {
    if (kind !== 'url') return;
    const trimmed = url.trim();
    let cancelled = false;
    if (!/^https?:\/\//i.test(trimmed)) {
      // Bail early; clear stale meta on the next microtask so we don't
      // synchronously call setState inside the effect body.
      void Promise.resolve().then(() => {
        if (cancelled) return;
        setUrlMeta(null);
        setResolving(false);
      });
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(async () => {
      setResolving(true);
      const res = await window.electronAPI.material.resolveUrlMeta(trimmed);
      if (cancelled) return;
      setResolving(false);
      if (!res.ok) {
        setUrlMeta(null);
        return;
      }
      setUrlMeta({ title: res.title, ogImage: res.ogImage, favicon: res.favicon });
      if (res.title && (!title || titleAutoFilled.current)) {
        titleAutoFilled.current = true;
        setTitle(res.title);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Intentional: don't restart fetch when `title` flips from auto-fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, kind]);

  const pickFile = async (pickerKind: 'image' | 'pdf' | 'any') => {
    const res = await window.electronAPI.material.pickFile(pickerKind);
    if (!res.ok) return;
    setLocalPath(res.filePath);
    setSizeBytes(res.sizeBytes);
    if (!title) {
      const name = res.filePath.split(/[\\/]/).pop() ?? '';
      setTitle(name);
    }
  };

  const canSubmit = (() => {
    if (!title.trim() && kind !== 'text') return false;
    if (kind === 'url') return /^https?:\/\//i.test(url.trim());
    if (kind === 'image' || kind === 'pdf') return !!localPath;
    if (kind === 'text') return true;
    return false;
  })();

  const submit = async () => {
    if (kind === 'url') {
      const trimmedUrl = url.trim();
      // If the debounce hasn't fired yet, resolve once more synchronously so
      // the title / thumbnail are present at create time.
      let meta = urlMeta;
      if (!meta && /^https?:\/\//i.test(trimmedUrl)) {
        const res = await window.electronAPI.material.resolveUrlMeta(trimmedUrl);
        if (res.ok) meta = { title: res.title, ogImage: res.ogImage, favicon: res.favicon };
      }
      void onCreate(
        {
          title: title.trim() || meta?.title || trimmedUrl,
          kind: 'url',
          source: 'url',
          uri: trimmedUrl,
          thumbnailUri: meta?.ogImage ?? meta?.favicon ?? null,
        },
        relations,
      );
      return;
    }
    if (kind === 'image' || kind === 'pdf') {
      if (!localPath) return;
      void onCreate(
        {
          title: title.trim() || localPath.split(/[\\/]/).pop() || 'Untitled',
          kind,
          source: 'local',
          uri: `file://${localPath}`,
          localPath,
          sizeBytes,
        },
        relations,
      );
      return;
    }
    // text snippet — title + plain-text body. Body is editable inline on the
    // card after create; this is just the initial seed.
    void onCreate(
      {
        title: title.trim() || 'Untitled',
        kind: 'text',
        source: 'local',
        uri: '',
        bodyJson: body.trim() ? body : null,
      },
      relations,
    );
  };

  return (
    <DialogShell title="新建材料" onCancel={onCancel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['url', 'image', 'pdf', 'text'] as LibraryItemKind[]).map((k) => (
          <FilterPill key={k} active={kind === k} onClick={() => setKind(k)}>
            {LIBRARY_ITEM_KIND_LABEL[k]}
          </FilterPill>
        ))}
      </div>

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="标题"
        style={dialogInputStyle}
      />

      {kind === 'url' && (
        <>
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            style={{ ...dialogInputStyle, marginTop: 8 }}
          />
          {(resolving || urlMeta) && (
            <div
              style={{
                marginTop: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '6px 8px',
                border: '1px solid hsl(var(--rule))',
                borderRadius: 3,
                background: 'hsl(var(--paper-deep) / 0.3)',
                minHeight: 56,
              }}
            >
              {urlMeta?.ogImage && (
                <img
                  src={urlMeta.ogImage}
                  alt=""
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 3,
                    background: 'hsl(var(--paper))',
                  }}
                />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    color: 'hsl(var(--ink-4))',
                    marginBottom: 2,
                  }}
                >
                  {resolving ? '解析网页…' : '网页信息'}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: 12.5,
                    color: 'hsl(var(--ink-1))',
                    lineHeight: 1.3,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {urlMeta?.title ?? (resolving ? '…' : '未取到标题')}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {(kind === 'image' || kind === 'pdf') && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => pickFile(kind === 'image' ? 'image' : 'pdf')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '4px 10px',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 3,
              background: 'hsl(var(--paper))',
              color: 'hsl(var(--ink-2))',
              cursor: 'pointer',
            }}
          >
            选择文件…
          </button>
          {localPath && (
            <span
              title={localPath}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'hsl(var(--ink-4))',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
              }}
            >
              {localPath}
            </span>
          )}
        </div>
      )}

      {kind === 'text' && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="片段正文…"
          rows={5}
          style={{
            ...dialogInputStyle,
            marginTop: 8,
            resize: 'vertical',
            minHeight: 100,
            maxHeight: 240,
            fontFamily: 'var(--font-serif)',
          }}
        />
      )}

      <div style={{ marginTop: 10 }}>
        <EntityRelationPicker
          selected={selectedSet}
          selectedChipMode="toggle"
          onAdd={(t) => setRelations((prev) => [...prev, t])}
          onRemove={(t) =>
            setRelations((prev) => prev.filter((r) => !(r.kind === t.kind && r.id === t.id)))
          }
        />
      </div>

      <DialogActions onCancel={onCancel} onConfirm={submit} confirmDisabled={!canSubmit} />
    </DialogShell>
  );
}

function DialogShell({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  useEscapeToClose(true, onCancel);
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'hsl(var(--ink-1) / 0.30)',
        zIndex: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'hsl(var(--paper))',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 6,
          width: 'min(440px, 92vw)',
          padding: 16,
          boxShadow: '0 16px 32px -12px hsl(var(--ink-1) / 0.30)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 14,
            fontWeight: 500,
            color: 'hsl(var(--ink-1))',
            marginBottom: 10,
          }}
        >
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function DialogActions({
  onCancel,
  onConfirm,
  confirmDisabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 6,
        marginTop: 12,
      }}
    >
      <button
        onClick={onCancel}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          padding: '5px 12px',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 3,
          background: 'transparent',
          color: 'hsl(var(--ink-2))',
          cursor: 'pointer',
        }}
      >
        取消
      </button>
      <button
        onClick={onConfirm}
        disabled={confirmDisabled}
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          padding: '5px 12px',
          border: '1px solid hsl(var(--ink-1))',
          borderRadius: 3,
          background: confirmDisabled ? 'hsl(var(--ink-4))' : 'hsl(var(--ink-1))',
          color: 'hsl(var(--paper))',
          cursor: confirmDisabled ? 'not-allowed' : 'pointer',
          opacity: confirmDisabled ? 0.5 : 1,
        }}
      >
        创建
      </button>
    </div>
  );
}

const dialogInputStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-serif)',
  fontSize: 13.5,
  padding: '6px 8px',
  border: '1px solid hsl(var(--rule))',
  borderRadius: 3,
  background: 'hsl(var(--paper))',
  color: 'hsl(var(--ink-1))',
  outline: 'none',
};

function EmptyState({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '32px 20px',
        textAlign: 'center',
        fontFamily: 'var(--font-serif)',
        fontStyle: 'italic',
        fontSize: 12.5,
        color: 'hsl(var(--ink-3))',
      }}
    >
      {message}
    </div>
  );
}
