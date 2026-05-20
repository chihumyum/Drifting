import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataStore } from '../../store/data-store';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { useAuthStore } from '../../store/auth';
import { useBookMemo } from '../../usecase/useBookMemo';
import { useBookMaterial } from '../../usecase/useBookMaterial';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import type { Memo, MemoResolution } from '../../domain/memo';
import type { Material, MaterialKind } from '../../domain/material';
import type { EntityKind } from '../../lib/extensions/entity-link';
import { EntityRelationPicker, type RelationTarget } from './EntityRelationPicker';

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
function materialSubtitle(m: Material): string {
  if (m.kind === 'url') {
    try {
      return new URL(m.uri).hostname.replace(/^www\./, '');
    } catch {
      return m.uri;
    }
  }
  return basename(m.localPath ?? m.uri);
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
 * Global memo + material list — replaces the old per-entity mock fragments
 * view. Memos and materials are project-scoped; the `related` filter narrows
 * the list to items whose entity_reference rows point at `focused`.
 *
 * Memos use a three-state resolution machine:
 *   no_action  → no checkbox; pure note. Promote to 'unresolved' via
 *                the hover "标为待办" action.
 *   unresolved → checkbox affordance; click to mark resolved (→ archive)
 *                or use the small ↺ button to demote back to no_action.
 *   resolved   → hidden from main list, surfaced in the bottom "已解决"
 *                collapsed group, can be re-opened.
 */
export function MemoMaterialPanel({ focused }: Props) {
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const memos = useDataStore((s) => s.memos);
  const materials = useDataStore((s) => s.materials);
  const manualReferences = useDataStore((s) => s.manualReferences);

  const memoUsecases = useBookMemo({ projectId, userId });
  const materialUsecases = useBookMaterial({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [filter, setFilter] = useState<ViewFilter>('all');
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState<null | 'memo' | 'material'>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Index manualReferences by from-entity so cards can render their relation
  // chips and the filter can pick out items related to `focused`.
  const refsByFrom = useMemo(() => {
    const map = new Map<string, typeof manualReferences>();
    manualReferences.forEach((r) => {
      const key = `${r.fromKind}:${r.fromId}`;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    });
    return map;
  }, [manualReferences]);

  const isRelatedToFocus = useCallback(
    (kind: EntityKind, id: string) => {
      if (!focused.kind || !focused.id) return true;
      const refs = refsByFrom.get(`${kind}:${id}`) ?? [];
      return refs.some((r) => r.toKind === focused.kind && r.toId === focused.id);
    },
    [refsByFrom, focused.kind, focused.id],
  );

  const filteredMemos = useMemo(() => {
    return memos.filter((m) => {
      if (m.resolution === 'resolved') return false;
      if (filter === 'related' && !isRelatedToFocus('memo', m.id)) return false;
      return true;
    });
  }, [memos, filter, isRelatedToFocus]);

  const resolvedMemos = useMemo(() => {
    return memos
      .filter((m) => m.resolution === 'resolved')
      .filter((m) => filter !== 'related' || isRelatedToFocus('memo', m.id))
      .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));
  }, [memos, filter, isRelatedToFocus]);

  const filteredMaterials = useMemo(() => {
    return materials.filter(
      (mat) => filter !== 'related' || isRelatedToFocus('material', mat.id),
    );
  }, [materials, filter, isRelatedToFocus]);

  const openMaterial = async (m: Material) => {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Toolbar
        filter={filter}
        onFilterChange={setFilter}
        focusedKind={focused.kind}
        onCompose={setComposeOpen}
        memoTotal={memos.length}
        materialTotal={materials.length}
      />

      <div style={{ padding: '8px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {filteredMemos.length === 0 && filteredMaterials.length === 0 && (
          <EmptyState
            message={
              filter === 'related'
                ? '当前条目没有关联的备忘或参考。'
                : '还没有备忘或参考。点击右上 "+" 新建。'
            }
          />
        )}

        {filteredMemos.map((m) => (
          <MemoCard
            key={m.id}
            memo={m}
            relations={refsByFrom.get(`memo:${m.id}`) ?? []}
            editing={editingId === m.id}
            onSetEditing={(on) => setEditingId(on ? m.id : null)}
            onSetResolution={(r) => memoUsecases.setMemoResolution(m.id, r)}
            onUpdate={(updates) => memoUsecases.updateMemo(m.id, updates)}
            onDelete={() => memoUsecases.removeMemo(m.id)}
            onAddRelation={(t) => relationUsecases.addRelation('memo', m.id, t.kind, t.id)}
            onRemoveRelation={(t) => {
              const ref = manualReferences.find(
                (r) =>
                  r.fromKind === 'memo' &&
                  r.fromId === m.id &&
                  r.toKind === t.kind &&
                  r.toId === t.id &&
                  r.fromBlockId == null,
              );
              if (ref) relationUsecases.removeRelation(ref.id);
            }}
          />
        ))}

        {filteredMaterials.map((mat) => (
          <MaterialCard
            key={mat.id}
            material={mat}
            relations={refsByFrom.get(`material:${mat.id}`) ?? []}
            editing={editingId === mat.id}
            onSetEditing={(on) => setEditingId(on ? mat.id : null)}
            onOpen={() => openMaterial(mat)}
            onUpdate={(updates) => materialUsecases.updateMaterial(mat.id, updates)}
            onDelete={() => materialUsecases.removeMaterial(mat.id)}
            onAddRelation={(t) =>
              relationUsecases.addRelation('material', mat.id, t.kind, t.id)
            }
            onRemoveRelation={(t) => {
              const ref = manualReferences.find(
                (r) =>
                  r.fromKind === 'material' &&
                  r.fromId === mat.id &&
                  r.toKind === t.kind &&
                  r.toId === t.id &&
                  r.fromBlockId == null,
              );
              if (ref) relationUsecases.removeRelation(ref.id);
            }}
          />
        ))}

        {resolvedMemos.length > 0 && (
          <Archive open={archiveOpen} onToggle={() => setArchiveOpen((v) => !v)} count={resolvedMemos.length}>
            {resolvedMemos.map((m) => (
              <ResolvedMemoCard
                key={m.id}
                memo={m}
                onReopen={() => memoUsecases.setMemoResolution(m.id, 'unresolved')}
                onDelete={() => memoUsecases.removeMemo(m.id)}
              />
            ))}
          </Archive>
        )}
      </div>

      {composeOpen === 'memo' && (
        <ComposeMemoDialog
          focused={focused}
          onCancel={() => setComposeOpen(null)}
          onCreate={async (title, asTodo, relations) => {
            const memo = await memoUsecases.createMemo({
              title,
              resolution: asTodo ? 'unresolved' : 'no_action',
            });
            await Promise.all(
              relations.map((t) => relationUsecases.addRelation('memo', memo.id, t.kind, t.id)),
            );
            setComposeOpen(null);
          }}
        />
      )}

      {composeOpen === 'material' && (
        <ComposeMaterialDialog
          focused={focused}
          onCancel={() => setComposeOpen(null)}
          onCreate={async (input, relations) => {
            const mat = await materialUsecases.createMaterial(input);
            await Promise.all(
              relations.map((t) => relationUsecases.addRelation('material', mat.id, t.kind, t.id)),
            );
            setComposeOpen(null);
          }}
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
  memoTotal,
  materialTotal,
}: {
  filter: ViewFilter;
  onFilterChange: (f: ViewFilter) => void;
  focusedKind: EntityKind | null;
  onCompose: (k: 'memo' | 'material') => void;
  memoTotal: number;
  materialTotal: number;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    triggerRef.current?.blur();
  }, []);
  useEscapeToClose(menuOpen, closeMenu);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '1px solid hsl(var(--rule))',
        gap: 6,
        flexShrink: 0,
        // Pin the toolbar to the top of the scroll container so the filter
        // chips + "+" menu don't slide away when the cards list scrolls.
        position: 'sticky',
        top: 0,
        zIndex: 4,
        background: 'hsl(var(--paper))',
      }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        <FilterPill active={filter === 'all'} onClick={() => onFilterChange('all')}>
          全部
        </FilterPill>
        <FilterPill
          active={filter === 'related'}
          disabled={!focusedKind}
          onClick={() => onFilterChange('related')}
        >
          仅当前条目
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
        <span>{memoTotal} memo · {materialTotal} 参考</span>
        <div style={{ position: 'relative' }}>
          <button
            ref={triggerRef}
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              padding: '3px 8px',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 3,
              background: 'transparent',
              color: 'hsl(var(--ink-2))',
              cursor: 'pointer',
            }}
          >
            ＋
          </button>
          {menuOpen && (
            <>
              <div onClick={closeMenu} style={{ position: 'fixed', inset: 0, zIndex: 5 }} />
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  right: 0,
                  zIndex: 6,
                  background: 'hsl(var(--paper))',
                  border: '1px solid hsl(var(--rule))',
                  borderRadius: 4,
                  padding: 4,
                  minWidth: 140,
                  boxShadow: '0 8px 24px -8px hsl(var(--ink-1) / 0.20)',
                }}
              >
                <ComposeMenuItem
                  onClick={() => {
                    closeMenu();
                    onCompose('memo');
                  }}
                >
                  ✎ 新建备忘
                </ComposeMenuItem>
                <ComposeMenuItem
                  onClick={() => {
                    closeMenu();
                    onCompose('material');
                  }}
                >
                  ✦ 新建参考
                </ComposeMenuItem>
              </div>
            </>
          )}
        </div>
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
        padding: '3px 8px',
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

function ComposeMenuItem({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        fontFamily: 'var(--font-serif)',
        fontSize: 13,
        background: 'transparent',
        border: 'none',
        color: 'hsl(var(--ink-1))',
        cursor: 'pointer',
        borderRadius: 3,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'hsl(var(--paper-deep))')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Memo card

function MemoCard({
  memo,
  relations,
  editing,
  onSetEditing,
  onSetResolution,
  onUpdate,
  onDelete,
  onAddRelation,
  onRemoveRelation,
}: {
  memo: Memo;
  relations: { id: string; toKind: EntityKind; toId: string }[];
  editing: boolean;
  onSetEditing: (on: boolean) => void;
  onSetResolution: (r: MemoResolution) => void;
  onUpdate: (updates: Partial<Memo>) => void;
  onDelete: () => void;
  onAddRelation: (t: RelationTarget) => void;
  onRemoveRelation: (t: RelationTarget) => void;
}) {
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(memo.title);
  const isTodo = memo.resolution === 'unresolved';
  const accent = isTodo ? 'hsl(var(--story-2))' : 'hsl(var(--story-5))';

  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.toKind}:${r.toId}`)),
    [relations],
  );

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '7px 10px',
        borderRadius: 4,
        border: '1px solid hsl(var(--rule))',
        borderLeft: `2px solid ${accent}`,
        background: 'hsl(var(--surface))',
        position: 'relative',
        maxHeight: 300,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 3,
          flexShrink: 0,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'hsl(var(--ink-4))',
          minHeight: 16,
        }}
      >
        {isTodo ? (
          <button
            onClick={() => onSetResolution('resolved')}
            title="标记为已解决"
            aria-label="标记为已解决"
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
        ) : (
          // Same-position toggle: empty circle promotes the memo to a TODO.
          // Visually distinct from the TODO checkbox above by being neutral
          // grey; click swaps the row into the isTodo branch with no width
          // change — the row already reserves `minHeight: 16` so promoting
          // doesn't shift surrounding content.
          <button
            onClick={() => onSetResolution('unresolved')}
            title="标为待办"
            aria-label="标为待办"
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              border: '1.5px solid hsl(var(--ink-4))',
              background: 'transparent',
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
              opacity: 0.55,
              transition: 'opacity 120ms ease, border-color 120ms ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '1';
              e.currentTarget.style.borderColor = 'hsl(var(--story-2))';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '0.55';
              e.currentTarget.style.borderColor = 'hsl(var(--ink-4))';
            }}
          />
        )}
        <span style={{ color: isTodo ? 'hsl(var(--story-2))' : undefined }}>
          {isTodo ? 'TODO' : '备忘'}
        </span>
        {/* Demote-to-no_action button: only meaningful when the memo is
            currently a TODO. Always rendered but hidden via opacity so the
            row's intrinsic width doesn't change on hover. */}
        {isTodo && (
          <button
            onClick={() => onSetResolution('no_action')}
            title="退回为纯笔记"
            aria-hidden={!hover}
            tabIndex={hover ? 0 : -1}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              padding: '0 4px',
              border: 'none',
              background: 'transparent',
              color: 'hsl(var(--ink-4))',
              cursor: 'pointer',
              opacity: hover ? 1 : 0,
              pointerEvents: hover ? 'auto' : 'none',
              transition: 'opacity 120ms ease',
            }}
          >
            ↺
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={onDelete}
          title="删除"
          aria-hidden={!hover}
          tabIndex={hover ? 0 : -1}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            padding: '0 4px',
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
            opacity: hover ? 1 : 0,
            pointerEvents: hover ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
          ×
        </button>
      </div>

      {editing ? (
        <AutoGrowTextarea
          value={draft}
          autoFocus
          onChange={setDraft}
          onCommit={() => {
            if (draft !== memo.title) onUpdate({ title: draft });
            onSetEditing(false);
          }}
          onCancel={() => {
            setDraft(memo.title);
            onSetEditing(false);
          }}
        />
      ) : (
        <div
          onClick={() => {
            setDraft(memo.title);
            onSetEditing(true);
          }}
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 13,
            color: 'hsl(var(--ink-1))',
            lineHeight: 1.35,
            cursor: 'text',
            minHeight: 16,
            maxHeight: 160,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {memo.title || <span style={{ color: 'hsl(var(--ink-4))', fontStyle: 'italic' }}>无标题</span>}
        </div>
      )}

      <div style={{ marginTop: 4, flexShrink: 0 }}>
        <EntityRelationPicker
          selected={selectedSet}
          onAdd={onAddRelation}
          onRemove={onRemoveRelation}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Material card

function MaterialCard({
  material,
  relations,
  editing,
  onSetEditing,
  onOpen,
  onUpdate,
  onDelete,
  onAddRelation,
  onRemoveRelation,
}: {
  material: Material;
  relations: { id: string; toKind: EntityKind; toId: string }[];
  editing: boolean;
  onSetEditing: (on: boolean) => void;
  onOpen: () => void;
  onUpdate: (updates: Partial<Material>) => void;
  onDelete: () => void;
  onAddRelation: (t: RelationTarget) => void;
  onRemoveRelation: (t: RelationTarget) => void;
}) {
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(material.title);
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.toKind}:${r.toId}`)),
    [relations],
  );
  const accent = 'hsl(var(--story-4))';
  const kindLabel = MATERIAL_KIND_LABEL[material.kind] ?? material.kind;
  const subtitle = materialSubtitle(material);
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

  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(material.bodyJson ?? '');
  const isTextSnippet = material.kind === 'text';

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '8px 10px',
        borderRadius: 4,
        border: '1px solid hsl(var(--rule))',
        borderLeft: `2px solid ${accent}`,
        background: 'hsl(var(--surface))',
        maxHeight: 320,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
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
        {!isTextSnippet && (
          <button
            onClick={onOpen}
            title="打开"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              padding: '1px 6px',
              borderRadius: 2,
              border: '1px solid hsl(var(--rule))',
              background: 'hsl(var(--paper))',
              color: 'hsl(var(--ink-2))',
              cursor: 'pointer',
            }}
          >
            {material.kind === 'url' ? '在浏览器中打开' : '打开'}
          </button>
        )}
        <button
          onClick={onDelete}
          title="删除"
          aria-hidden={!hover}
          tabIndex={hover ? 0 : -1}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            padding: '0 4px',
            border: 'none',
            background: 'transparent',
            color: 'hsl(var(--ink-4))',
            cursor: 'pointer',
            // Toggle via opacity so the row width doesn't change on hover.
            opacity: hover ? 1 : 0,
            pointerEvents: hover ? 'auto' : 'none',
            transition: 'opacity 120ms ease',
          }}
        >
          ×
        </button>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minHeight: 0 }}>
        <MaterialThumbnail material={material} onClick={onOpen} />
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

      {isTextSnippet && (
        editingBody ? (
          <div style={{ marginTop: 6, flexShrink: 0 }}>
            <AutoGrowTextarea
              value={bodyDraft}
              autoFocus
              placeholder="片段正文…"
              onChange={setBodyDraft}
              onCommit={() => {
                if (bodyDraft !== (material.bodyJson ?? '')) {
                  onUpdate({ bodyJson: bodyDraft });
                }
                setEditingBody(false);
              }}
              onCancel={() => {
                setBodyDraft(material.bodyJson ?? '');
                setEditingBody(false);
              }}
            />
          </div>
        ) : (
          <div
            onClick={() => {
              setBodyDraft(material.bodyJson ?? '');
              setEditingBody(true);
            }}
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
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              // Soft fade at the bottom hints there might be more body when
              // the snippet overflows the max-height clip.
              maskImage:
                material.bodyJson && (material.bodyJson?.length ?? 0) > 240
                  ? 'linear-gradient(to bottom, black 80%, transparent 100%)'
                  : undefined,
              WebkitMaskImage:
                material.bodyJson && (material.bodyJson?.length ?? 0) > 240
                  ? 'linear-gradient(to bottom, black 80%, transparent 100%)'
                  : undefined,
            }}
          >
            {material.bodyJson || '添加片段正文…'}
          </div>
        )
      )}

      <div style={{ marginTop: 6, flexShrink: 0 }}>
        <EntityRelationPicker
          selected={selectedSet}
          onAdd={onAddRelation}
          onRemove={onRemoveRelation}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thumbnail — inline preview tile for image / pdf / url materials.

function MaterialThumbnail({ material, onClick }: { material: Material; onClick: () => void }) {
  const size = 64;
  const [errored, setErrored] = useState(false);
  let src: string | null = null;
  if (!errored) {
    if (material.kind === 'image' && material.localPath) {
      // webSecurity is disabled in dev, so file:// loads inline. In production
      // the same window config currently applies; if we ever re-enable
      // webSecurity we'll need to register a custom protocol.
      src = `file://${material.localPath}`;
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
        {material.kind === 'pdf' ? '…' : MATERIAL_KIND_LABEL[material.kind]}
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
// Auto-growing textarea — used by memo + material titles. Lets the field
// shrink to one line and grow to fit content, capped via maxHeight so a long
// note doesn't push everything else off-screen.

function AutoGrowTextarea({
  value,
  onChange,
  onCommit,
  onCancel,
  autoFocus,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Resize on every keystroke; capping max-height is handled by CSS so the
  // textarea simply gets a scrollbar once it hits the limit.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      autoFocus={autoFocus}
      value={value}
      placeholder={placeholder}
      rows={1}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          (e.currentTarget as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          (e.currentTarget as HTMLTextAreaElement).blur();
          onCancel();
        }
      }}
      style={{
        width: '100%',
        fontFamily: 'var(--font-serif)',
        fontSize: 13.5,
        color: 'hsl(var(--ink-1))',
        lineHeight: 1.4,
        padding: '4px 6px',
        border: '1px solid hsl(var(--rule))',
        borderRadius: 3,
        background: 'hsl(var(--paper))',
        outline: 'none',
        resize: 'none',
        maxHeight: 200,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    />
  );
}

const MATERIAL_KIND_LABEL: Record<MaterialKind, string> = {
  image: '图片',
  pdf: 'PDF',
  url: 'URL',
  text: '片段',
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolved archive

function Archive({
  open,
  onToggle,
  count,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 8px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'hsl(var(--ink-4))',
          background: 'transparent',
          border: 'none',
          borderTop: '1px dotted hsl(var(--rule))',
          cursor: 'pointer',
        }}
      >
        <span>已解决 ({count})</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>}
    </div>
  );
}

function ResolvedMemoCard({
  memo,
  onReopen,
  onDelete,
}: {
  memo: Memo;
  onReopen: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        padding: '6px 10px',
        borderRadius: 3,
        background: 'hsl(var(--ink-1) / 0.03)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        opacity: 0.7,
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: 'hsl(var(--story-3))',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          flex: 1,
          fontFamily: 'var(--font-serif)',
          fontSize: 12.5,
          color: 'hsl(var(--ink-2))',
          textDecoration: 'line-through',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {memo.title || '无标题'}
      </div>
      <button
        onClick={onReopen}
        title="重新打开"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          padding: '1px 5px',
          border: '1px solid hsl(var(--rule))',
          borderRadius: 2,
          background: 'transparent',
          color: 'hsl(var(--ink-3))',
          cursor: 'pointer',
        }}
      >
        重开
      </button>
      <button
        onClick={onDelete}
        title="删除"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          padding: '0 4px',
          border: 'none',
          background: 'transparent',
          color: 'hsl(var(--ink-4))',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Compose dialogs

function ComposeMemoDialog({
  focused,
  onCancel,
  onCreate,
}: {
  focused: FocusedEntity;
  onCancel: () => void;
  onCreate: (title: string, asTodo: boolean, relations: RelationTarget[]) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [asTodo, setAsTodo] = useState(false);
  const [relations, setRelations] = useState<RelationTarget[]>(() =>
    focused.kind && focused.id ? [{ kind: focused.kind, id: focused.id, label: '(当前条目)' }] : [],
  );
  const selectedSet = useMemo(
    () => new Set(relations.map((r) => `${r.kind}:${r.id}`)),
    [relations],
  );

  return (
    <DialogShell title="新建备忘" onCancel={onCancel}>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="备忘内容…"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void onCreate(title, asTodo, relations);
          }
        }}
        style={dialogInputStyle}
      />
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-serif)',
          fontSize: 12.5,
          color: 'hsl(var(--ink-2))',
          marginTop: 8,
          cursor: 'pointer',
        }}
      >
        <input type="checkbox" checked={asTodo} onChange={(e) => setAsTodo(e.target.checked)} />
        创建为待办（未解决）
      </label>
      <div style={{ marginTop: 10 }}>
        <EntityRelationPicker
          selected={selectedSet}
          onAdd={(t) => setRelations((prev) => [...prev, t])}
          onRemove={(t) =>
            setRelations((prev) => prev.filter((r) => !(r.kind === t.kind && r.id === t.id)))
          }
        />
      </div>
      <DialogActions
        onCancel={onCancel}
        onConfirm={() => onCreate(title, asTodo, relations)}
        confirmDisabled={!title.trim()}
      />
    </DialogShell>
  );
}

function ComposeMaterialDialog({
  focused,
  onCancel,
  onCreate,
}: {
  focused: FocusedEntity;
  onCancel: () => void;
  onCreate: (
    input: {
      title: string;
      kind: MaterialKind;
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
  const [kind, setKind] = useState<MaterialKind>('url');
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
    focused.kind && focused.id ? [{ kind: focused.kind, id: focused.id, label: '(当前条目)' }] : [],
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
    <DialogShell title="新建参考" onCancel={onCancel}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
        {(['url', 'image', 'pdf', 'text'] as MaterialKind[]).map((k) => (
          <FilterPill key={k} active={kind === k} onClick={() => setKind(k)}>
            {MATERIAL_KIND_LABEL[k]}
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
