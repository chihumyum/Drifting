import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { ChevronUp } from 'lucide-react';
import { useDataStore } from '../../store/data-store';
import { isChapter } from '../../domain/book-node';
import { useUiStore } from '../../store/ui-store';
import { useAuthStore } from '../../store/auth';
import { useProjectNavigation } from '../../hooks/useProjectNavigation';
import { SuperViewHeader } from '../../components/SuperViewHeader';
import { useBookMemo } from '../../usecase/useBookMemo';
import { useBookMaterial } from '../../usecase/useBookMaterial';
import { useEntityRelations } from '../../usecase/useEntityRelations';
import {
  MemoCard,
  MaterialCard,
  ComposeMemoDialog,
  ComposeMaterialDialog,
  MaterialFullscreenPreview,
  TextSnippetPopover,
  MATERIAL_KIND_LABEL,
  type FocusedEntity,
} from '../../components/rightBars/MemoMaterialPanel';
import { EntityRelationPicker } from '../../components/rightBars/EntityRelationPicker';
import type { Material, MaterialKind } from '../../domain/material';
import type { Memo } from '../../domain/memo';
import type { EntityKind } from '../../lib/extensions/entity-link';

const KIND_ORDER: MaterialKind[] = ['image', 'pdf', 'url', 'text'];

const BSB_HEIGHT = 20;
const DRAWER_HEADER_HEIGHT = 28;
const DRAWER_MIN_HEIGHT = 120;
const DRAWER_DEFAULT_HEIGHT = 260;

const TODO_RAIL_WIDTH = 280;

// The KindChip / EntityFilterButton popovers used to live in the top
// toolbar (a drag region), so each interactive control was tagged no-drag
// to stay clickable on macOS. Now they live inside MaterialMain's section
// header — outside any drag region — but we keep the spreads in place
// because they're harmless and reduce churn against the existing markup.
const NO_DRAG_REGION: CSSProperties = {
  WebkitAppRegion: 'no-drag' as CSSProperties['WebkitAppRegion'],
};

/**
 * Global Memo & Material workbench — the project-wide counterpart to the
 * per-entity MemoMaterialPanel in the right sidebar.
 *
 * Layout (full-screen above BottomStatusBar, same shell as StoryGraphView /
 * SuperElementView — no header bar, close via the BSB toggle):
 *  ┌── toolbar (search · kind chips · entity filter · +) ─┐
 *  ├──────────┬────────────────────────────────────────────┤
 *  │ TODO 板  │  Material 网格 (按 kind 分组)              │
 *  │ + 笔记   │                                            │
 *  ├──────────┴────────────────────────────────────────────┤
 *  │  ▾ 待整理 (orphan) · 已解决 (archive)                  │
 *  └────────────────────────────────────────────────────────┘
 *
 * Bottom drawer is collapsible (drag the top edge to resize when open).
 * All cards reuse the right-sidebar primitives so actions stay in sync.
 */
export function SuperMemoMaterialView() {
  const { projectId } = useProjectNavigation();
  const userId = useAuthStore((s) => s.user?.id) ?? '';
  const setActiveSuperView = useUiStore((s) => s.setActiveSuperView);
  const closeView = useCallback(() => setActiveSuperView('none'), [setActiveSuperView]);

  const memos = useDataStore((s) => s.memos);
  const materials = useDataStore((s) => s.materials);
  const entityRelations = useDataStore((s) => s.entityRelations);

  const memoUsecases = useBookMemo({ projectId, userId });
  const materialUsecases = useBookMaterial({ projectId, userId });
  const relationUsecases = useEntityRelations({ projectId, userId });

  const [query, setQuery] = useState('');
  const [hiddenKinds, setHiddenKinds] = useState<Set<MaterialKind>>(() => new Set());
  const [entityFilter, setEntityFilter] = useState<FocusedEntity>({ kind: null, id: null });
  const [composeOpen, setComposeOpen] = useState<null | 'memo' | 'material'>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [previewMaterialId, setPreviewMaterialId] = useState<string | null>(null);
  const [textPopoverId, setTextPopoverId] = useState<string | null>(null);

  // ESC is intentionally NOT wired to close the super view — matches
  // StoryGraphView / SuperElementView ("ESC no longer exits the super view
  // itself; users return via the BottomStatusBar toggle"). Compose dialogs
  // and material preview popovers handle their own ESC dismissal internally.

  // Group entityRelations by from-entity so each card can render its
  // relation chips and the filters can narrow to a specific target.
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

  const isRelatedToEntity = useCallback(
    (fromKind: EntityKind, fromId: string) => {
      if (!entityFilter.kind || !entityFilter.id) return true;
      const refs = refsByFrom.get(`${fromKind}:${fromId}`) ?? [];
      return refs.some((r) => r.toKind === entityFilter.kind && r.toId === entityFilter.id);
    },
    [refsByFrom, entityFilter.kind, entityFilter.id],
  );

  const matchesQuery = useCallback(
    (title: string | null | undefined, body: string | null | undefined) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return (
        (title ?? '').toLowerCase().includes(q) || (body ?? '').toLowerCase().includes(q)
      );
    },
    [query],
  );

  const todoMemos = useMemo(
    () =>
      memos.filter(
        (m) =>
          m.resolution === 'unresolved' &&
          isRelatedToEntity('memo', m.id) &&
          matchesQuery(m.title, m.bodyJson),
      ),
    [memos, isRelatedToEntity, matchesQuery],
  );

  const noteMemos = useMemo(
    () =>
      memos.filter(
        (m) =>
          m.resolution === 'no_action' &&
          isRelatedToEntity('memo', m.id) &&
          matchesQuery(m.title, m.bodyJson),
      ),
    [memos, isRelatedToEntity, matchesQuery],
  );

  const resolvedMemos = useMemo(
    () =>
      memos
        .filter(
          (m) =>
            m.resolution === 'resolved' &&
            isRelatedToEntity('memo', m.id) &&
            matchesQuery(m.title, m.bodyJson),
        )
        .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? '')),
    [memos, isRelatedToEntity, matchesQuery],
  );

  const visibleMaterials = useMemo(
    () =>
      materials.filter(
        (mat) => isRelatedToEntity('material', mat.id) && matchesQuery(mat.title, mat.bodyJson),
      ),
    [materials, isRelatedToEntity, matchesQuery],
  );

  const materialsByKind = useMemo(() => {
    const map = new Map<MaterialKind, Material[]>();
    KIND_ORDER.forEach((k) => map.set(k, []));
    visibleMaterials.forEach((m) => {
      if (hiddenKinds.has(m.kind)) return;
      map.get(m.kind)?.push(m);
    });
    return map;
  }, [visibleMaterials, hiddenKinds]);

  const orphanMaterials = useMemo(
    () =>
      visibleMaterials.filter((m) => {
        const refs = refsByFrom.get(`material:${m.id}`) ?? [];
        return refs.length === 0;
      }),
    [visibleMaterials, refsByFrom],
  );

  const previewMaterial = useMemo(
    () => materials.find((m) => m.id === previewMaterialId) ?? null,
    [materials, previewMaterialId],
  );
  const textPopoverMaterial = useMemo(
    () => materials.find((m) => m.id === textPopoverId) ?? null,
    [materials, textPopoverId],
  );

  const openMaterialInSystem = useCallback(async (m: Material) => {
    if (m.kind === 'text') return;
    if (m.kind === 'url') {
      await window.electronAPI.material.openExternal(m.uri);
      return;
    }
    const path = m.localPath ?? m.uri.replace(/^file:\/\//, '');
    if (!path) return;
    const res = await window.electronAPI.material.openLocal(path);
    if (!res.ok) alert(`无法打开文件：${res.error}`);
  }, []);

  const openMaterialInApp = useCallback((m: Material) => {
    if (m.kind === 'url') {
      void openMaterialInSystem(m);
      return;
    }
    if (m.kind === 'text') {
      setTextPopoverId(m.id);
      return;
    }
    setPreviewMaterialId(m.id);
  }, [openMaterialInSystem]);

  const toggleKindHidden = useCallback((kind: MaterialKind) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const removeRelation = useCallback(
    (fromKind: EntityKind, fromId: string, toKind: EntityKind, toId: string) => {
      const ref = entityRelations.find(
        (r) =>
          r.fromKind === fromKind &&
          r.fromId === fromId &&
          r.toKind === toKind &&
          r.toId === toId,
      );
      if (ref) relationUsecases.removeRelation(ref.id);
    },
    [entityRelations, relationUsecases],
  );

  const focusedEntity: FocusedEntity = entityFilter;

  return (
    <div style={overlayStyle}>
      <style>{`
        .smm-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .smm-scroll::-webkit-scrollbar-thumb { background: hsl(var(--rule)); border-radius: 4px; }
        .smm-scroll::-webkit-scrollbar-track { background: transparent; }
      `}</style>

      {/* Top header — back + title + global search. Material-specific
          filters (KIND chips, entity-target filter) live inside the
          MaterialMain section header so the global header stays focused
          on cross-cutting controls. */}
      <SuperViewHeader
        title="备忘 & 材料"
        meta={`${memos.length} 备忘 · ${materials.length} 材料`}
        onBack={closeView}
        rightSlot={
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题或正文…"
            style={{
              width: 220,
              fontFamily: 'var(--font-serif)',
              fontSize: 12.5,
              padding: '5px 9px',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 3,
              background: 'hsl(var(--paper))',
              color: 'hsl(var(--ink-1))',
              outline: 'none',
            }}
          />
        }
      />

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <TodoRail
          todoMemos={todoMemos}
          noteMemos={noteMemos}
          refsByFrom={refsByFrom}
          editingId={editingId}
          setEditingId={setEditingId}
          memoUsecases={memoUsecases}
          relationUsecases={relationUsecases}
          entityRelations={entityRelations}
          onCompose={() => setComposeOpen('memo')}
        />

        <MaterialMain
          materialsByKind={materialsByKind}
          totalVisible={visibleMaterials.length}
          totalMaterials={materials.length}
          hiddenKinds={hiddenKinds}
          onToggleKind={toggleKindHidden}
          kindCounts={Object.fromEntries(
            KIND_ORDER.map((k) => [k, materials.filter((m) => m.kind === k).length]),
          ) as Record<MaterialKind, number>}
          entityFilter={entityFilter}
          onEntityFilterChange={setEntityFilter}
          refsByFrom={refsByFrom}
          editingId={editingId}
          setEditingId={setEditingId}
          materialUsecases={materialUsecases}
          relationUsecases={relationUsecases}
          removeRelation={removeRelation}
          openMaterialInApp={openMaterialInApp}
          openMaterialInSystem={openMaterialInSystem}
          onCompose={() => setComposeOpen('material')}
        />
      </div>

      <BottomDrawer
        orphans={orphanMaterials}
        resolvedMemos={resolvedMemos}
        editingId={editingId}
        setEditingId={setEditingId}
        memoUsecases={memoUsecases}
        materialUsecases={materialUsecases}
        relationUsecases={relationUsecases}
        removeRelation={removeRelation}
        openMaterialInApp={openMaterialInApp}
        openMaterialInSystem={openMaterialInSystem}
      />

      {composeOpen === 'memo' && (
        <ComposeMemoDialog
          focused={focusedEntity}
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
          focused={focusedEntity}
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

      {previewMaterial && (
        <MaterialFullscreenPreview
          key={previewMaterial.id}
          material={previewMaterial}
          onClose={() => setPreviewMaterialId(null)}
          onUpdate={(updates) => materialUsecases.updateMaterial(previewMaterial.id, updates)}
        />
      )}

      {textPopoverMaterial && (
        <TextSnippetPopover
          key={textPopoverMaterial.id}
          material={textPopoverMaterial}
          onClose={() => setTextPopoverId(null)}
          onExpand={() => {
            setTextPopoverId(null);
            setPreviewMaterialId(textPopoverMaterial.id);
          }}
          onUpdate={(updates) =>
            materialUsecases.updateMaterial(textPopoverMaterial.id, updates)
          }
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Material filter primitives — KindChip + EntityFilterButton, both used in
// the MaterialMain section header (previously lived in a top toolbar). The
// thin vertical divider used between filter groups is shared too.

function ToolbarDivider() {
  return (
    <div
      style={{
        width: 1,
        height: 20,
        background: 'hsl(var(--rule))',
        flexShrink: 0,
      }}
    />
  );
}

const kickerStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9.5,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: 'hsl(var(--ink-4))',
};

function KindChip({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={active ? '点击隐藏此 kind' : '点击显示'}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        padding: '3px 8px',
        borderRadius: 11,
        border: `1px solid ${active ? 'hsl(var(--ink-1))' : 'hsl(var(--rule))'}`,
        background: active ? 'hsl(var(--ink-1) / 0.06)' : 'transparent',
        color: active ? 'hsl(var(--ink-1))' : 'hsl(var(--ink-4))',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        opacity: count === 0 ? 0.45 : 1,
        ...NO_DRAG_REGION,
      }}
    >
      <span>{children}</span>
      <span style={{ fontSize: 9, color: 'hsl(var(--ink-4))' }}>{count}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity-target filter — popover with EntityRelationPicker constrained to a
// single-select.

function EntityFilterButton({
  entityFilter,
  onChange,
}: {
  entityFilter: FocusedEntity;
  onChange: (next: FocusedEntity) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const { bookNodes, bookElements, storylines, bookElementCategories } = useDataStore();

  const label = useMemo(() => {
    if (!entityFilter.kind || !entityFilter.id) return '全部';
    const { kind, id } = entityFilter;
    if (kind === 'node') {
      const n = bookNodes.find((x) => x.id === id);
      return n?.title || (n && isChapter(n) ? 'Untitled Chapter' : 'Untitled Drift');
    }
    if (kind === 'element')
      return bookElements.find((x) => x.id === id)?.name || 'Untitled Element';
    if (kind === 'storyline')
      return storylines.find((x) => x.id === id)?.name || 'Untitled Storyline';
    if (kind === 'category')
      return bookElementCategories.find((x) => x.id === id)?.name || id;
    return id;
  }, [entityFilter, bookNodes, bookElements, storylines, bookElementCategories]);

  const selected = useMemo(
    () =>
      new Set(
        entityFilter.kind && entityFilter.id ? [`${entityFilter.kind}:${entityFilter.id}`] : [],
      ),
    [entityFilter],
  );

  return (
    <>
      <span style={kickerStyle}>关联</span>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 12,
          padding: '3px 8px',
          borderRadius: 11,
          border: `1px solid ${entityFilter.kind ? 'hsl(var(--ink-1))' : 'hsl(var(--rule))'}`,
          background: entityFilter.kind ? 'hsl(var(--ink-1) / 0.06)' : 'transparent',
          color: 'hsl(var(--ink-1))',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...NO_DRAG_REGION,
        }}
        title={entityFilter.kind ? `仅显示与 "${label}" 关联的条目` : '限定到某个实体'}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 180,
          }}
        >
          {label}
        </span>
        {entityFilter.kind ? (
          <span
            role="button"
            aria-label="清除关联过滤"
            onClick={(e) => {
              e.stopPropagation();
              onChange({ kind: null, id: null });
            }}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'hsl(var(--ink-4))',
            }}
          >
            ×
          </span>
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'hsl(var(--ink-4))',
            }}
          >
            ▾
          </span>
        )}
      </button>
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 60, ...NO_DRAG_REGION }}
          />
          <div
            style={{
              position: 'absolute',
              top: 44,
              left: 14,
              zIndex: 61,
              width: 360,
              maxHeight: 440,
              overflowY: 'auto',
              background: 'hsl(var(--paper))',
              border: '1px solid hsl(var(--rule))',
              borderRadius: 4,
              padding: 10,
              boxShadow: '0 10px 26px -8px hsl(var(--ink-1) / 0.22)',
              ...NO_DRAG_REGION,
            }}
          >
            <div
              style={{
                ...kickerStyle,
                marginBottom: 6,
              }}
            >
              选择实体后只显示关联的备忘 / 材料
            </div>
            <EntityRelationPicker
              selected={selected}
              selectedChipMode="toggle"
              onAdd={(t) => {
                onChange({ kind: t.kind, id: t.id });
                setOpen(false);
              }}
              onRemove={() => onChange({ kind: null, id: null })}
            />
          </div>
        </>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TodoRail — left column. TODOs on top (action surface), pure notes below.

function TodoRail({
  todoMemos,
  noteMemos,
  refsByFrom,
  editingId,
  setEditingId,
  memoUsecases,
  relationUsecases,
  entityRelations,
  onCompose,
}: {
  todoMemos: Memo[];
  noteMemos: Memo[];
  refsByFrom: Map<string, Array<{ id: string; toKind: EntityKind; toId: string }>>;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  memoUsecases: ReturnType<typeof useBookMemo>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  entityRelations: Array<{
    id: string;
    fromKind: EntityKind;
    fromId: string;
    toKind: EntityKind;
    toId: string;
  }>;
  onCompose: () => void;
}) {
  const renderMemo = (memo: Memo) => (
    <MemoCard
      key={memo.id}
      memo={memo}
      relations={refsByFrom.get(`memo:${memo.id}`) ?? []}
      editing={editingId === memo.id}
      onSetEditing={(on) => setEditingId(on ? memo.id : null)}
      onSetResolution={(r) => memoUsecases.setMemoResolution(memo.id, r)}
      onUpdate={(updates) => memoUsecases.updateMemo(memo.id, updates)}
      onDelete={() => memoUsecases.removeMemo(memo.id)}
      onAddRelation={(t) => relationUsecases.addRelation('memo', memo.id, t.kind, t.id)}
      onRemoveRelation={(t) => {
        const ref = entityRelations.find(
          (r) =>
            r.fromKind === 'memo' &&
            r.fromId === memo.id &&
            r.toKind === t.kind &&
            r.toId === t.id,
        );
        if (ref) relationUsecases.removeRelation(ref.id);
      }}
    />
  );

  return (
    <div
      style={{
        width: TODO_RAIL_WIDTH,
        flexShrink: 0,
        borderRight: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep) / 0.35)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <SectionHeader
        kicker="TODO"
        count={todoMemos.length}
        accent={todoMemos.length > 0 ? 'hsl(var(--story-2))' : undefined}
        action={
          <button onClick={onCompose} style={ghostBtnStyle} title="新建备忘">
            ＋
          </button>
        }
      />
      <div
        className="smm-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '6px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {todoMemos.length === 0 && (
          <RailEmpty hint="点击 ＋ 新建待办，或在任意备忘卡上按 ○ 升格" />
        )}
        {todoMemos.map(renderMemo)}

        {noteMemos.length > 0 && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 10,
              borderTop: '1px dashed hsl(var(--rule))',
            }}
          >
            <div
              style={{
                ...kickerStyle,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
              }}
            >
              <span>纯笔记</span>
              <span style={{ color: 'hsl(var(--ink-4))' }}>{noteMemos.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {noteMemos.map(renderMemo)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  kicker,
  count,
  accent,
  action,
}: {
  kicker: string;
  count: number;
  accent?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: 30,
        flexShrink: 0,
        padding: '0 10px 0 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderBottom: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper))',
      }}
    >
      <span
        style={{
          ...kickerStyle,
          color: accent ?? 'hsl(var(--ink-3))',
        }}
      >
        {kicker}
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'hsl(var(--ink-4))',
        }}
      >
        {count}
      </span>
      <div style={{ flex: 1 }} />
      {action}
    </div>
  );
}

const ghostBtnStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '2px 7px',
  borderRadius: 3,
  border: '1px solid hsl(var(--rule))',
  background: 'transparent',
  color: 'hsl(var(--ink-2))',
  cursor: 'pointer',
};

function RailEmpty({ hint }: { hint: string }) {
  return (
    <div
      style={{
        padding: '20px 12px',
        textAlign: 'center',
        fontFamily: 'var(--font-serif)',
        fontStyle: 'italic',
        fontSize: 12,
        color: 'hsl(var(--ink-4))',
        lineHeight: 1.55,
      }}
    >
      {hint}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MaterialMain — center column, grid grouped by kind.

function MaterialMain({
  materialsByKind,
  totalVisible,
  totalMaterials,
  hiddenKinds,
  onToggleKind,
  kindCounts,
  entityFilter,
  onEntityFilterChange,
  refsByFrom,
  editingId,
  setEditingId,
  materialUsecases,
  relationUsecases,
  removeRelation,
  openMaterialInApp,
  openMaterialInSystem,
  onCompose,
}: {
  materialsByKind: Map<MaterialKind, Material[]>;
  totalVisible: number;
  totalMaterials: number;
  hiddenKinds: Set<MaterialKind>;
  /** Toggle one kind on/off in the visibility filter. */
  onToggleKind: (k: MaterialKind) => void;
  /** Total materials per kind across the project (ignores the kind toggle
   *  itself, so the count next to each chip stays stable as you toggle). */
  kindCounts: Record<MaterialKind, number>;
  /** Entity-target filter — narrows BOTH memos and materials to those
   *  related to the picked entity. Lives in this header for visual
   *  proximity to the KIND chips, even though the rail also reacts. */
  entityFilter: FocusedEntity;
  onEntityFilterChange: (next: FocusedEntity) => void;
  refsByFrom: Map<string, Array<{ id: string; toKind: EntityKind; toId: string }>>;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  materialUsecases: ReturnType<typeof useBookMaterial>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  removeRelation: (
    fromKind: EntityKind,
    fromId: string,
    toKind: EntityKind,
    toId: string,
  ) => void;
  openMaterialInApp: (m: Material) => void;
  openMaterialInSystem: (m: Material) => Promise<void>;
  onCompose: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {/* Material section header: kicker + count on the left, then KIND
          chips and entity filter (moved down from the global header), then
          the new-material action on the right. Taller than the default
          SectionHeader because it needs to host the filter group inline. */}
      <div
        style={{
          minHeight: 38,
          flexShrink: 0,
          padding: '0 14px 0 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid hsl(var(--rule))',
          background: 'hsl(var(--paper))',
        }}
      >
        <span style={kickerStyle}>MATERIAL</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'hsl(var(--ink-4))',
          }}
        >
          {totalVisible}
        </span>

        <ToolbarDivider />

        <span style={kickerStyle}>KIND</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {KIND_ORDER.map((k) => (
            <KindChip
              key={k}
              active={!hiddenKinds.has(k)}
              count={kindCounts[k] ?? 0}
              onClick={() => onToggleKind(k)}
            >
              {MATERIAL_KIND_LABEL[k]}
            </KindChip>
          ))}
        </div>

        <ToolbarDivider />

        <EntityFilterButton
          entityFilter={entityFilter}
          onChange={onEntityFilterChange}
        />

        <div style={{ flex: 1 }} />

        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9.5,
            color: 'hsl(var(--ink-4))',
            letterSpacing: '0.06em',
          }}
        >
          {totalVisible} / {totalMaterials}
        </span>
        <button
          onClick={onCompose}
          title="新建材料"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            padding: '3px 10px',
            border: '1px solid hsl(var(--ink-1))',
            borderRadius: 3,
            background: 'hsl(var(--ink-1))',
            color: 'hsl(var(--paper))',
            cursor: 'pointer',
            letterSpacing: '0.08em',
          }}
        >
          ＋ 新建材料
        </button>
      </div>

      <div
        className="smm-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '10px 16px 18px',
        }}
      >
        {totalVisible === 0 && (
          <div
            style={{
              padding: '60px 20px',
              textAlign: 'center',
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: 13,
              color: 'hsl(var(--ink-3))',
            }}
          >
            {totalMaterials === 0 ? (
              <>
                <div>项目里还没有材料。</div>
                <button
                  onClick={onCompose}
                  style={{
                    marginTop: 12,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    padding: '5px 14px',
                    border: '1px solid hsl(var(--ink-1))',
                    borderRadius: 3,
                    background: 'hsl(var(--ink-1))',
                    color: 'hsl(var(--paper))',
                    cursor: 'pointer',
                    letterSpacing: '0.08em',
                  }}
                >
                  ＋ 新建材料
                </button>
              </>
            ) : (
              '当前过滤条件下没有匹配的材料。'
            )}
          </div>
        )}

        {KIND_ORDER.map((kind) => {
          const items = materialsByKind.get(kind) ?? [];
          if (hiddenKinds.has(kind)) return null;
          if (items.length === 0) return null;
          return (
            <KindGroup
              key={kind}
              kind={kind}
              items={items}
              refsByFrom={refsByFrom}
              editingId={editingId}
              setEditingId={setEditingId}
              materialUsecases={materialUsecases}
              relationUsecases={relationUsecases}
              removeRelation={removeRelation}
              openMaterialInApp={openMaterialInApp}
              openMaterialInSystem={openMaterialInSystem}
            />
          );
        })}
      </div>
    </div>
  );
}

function KindGroup({
  kind,
  items,
  refsByFrom,
  editingId,
  setEditingId,
  materialUsecases,
  relationUsecases,
  removeRelation,
  openMaterialInApp,
  openMaterialInSystem,
}: {
  kind: MaterialKind;
  items: Material[];
  refsByFrom: Map<string, Array<{ id: string; toKind: EntityKind; toId: string }>>;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  materialUsecases: ReturnType<typeof useBookMaterial>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  removeRelation: (
    fromKind: EntityKind,
    fromId: string,
    toKind: EntityKind,
    toId: string,
  ) => void;
  openMaterialInApp: (m: Material) => void;
  openMaterialInSystem: (m: Material) => Promise<void>;
}) {
  return (
    <section style={{ marginBottom: 18 }}>
      <div
        style={{
          ...kickerStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 8,
          paddingBottom: 4,
          borderBottom: '1px dashed hsl(var(--rule))',
        }}
      >
        <span>{MATERIAL_KIND_LABEL[kind]}</span>
        <span style={{ color: 'hsl(var(--ink-4))' }}>{items.length}</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 10,
          alignItems: 'start',
        }}
      >
        {items.map((mat) => (
          <MaterialCard
            key={mat.id}
            material={mat}
            relations={refsByFrom.get(`material:${mat.id}`) ?? []}
            editing={editingId === mat.id}
            onSetEditing={(on) => setEditingId(on ? mat.id : null)}
            onOpenInSystem={() => openMaterialInSystem(mat)}
            onOpenInApp={() => openMaterialInApp(mat)}
            onUpdate={(updates) => materialUsecases.updateMaterial(mat.id, updates)}
            onDelete={() => materialUsecases.removeMaterial(mat.id)}
            onAddRelation={(t) =>
              relationUsecases.addRelation('material', mat.id, t.kind, t.id)
            }
            onRemoveRelation={(t) => removeRelation('material', mat.id, t.kind, t.id)}
            defaultExpanded
          />
        ))}
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BottomDrawer — collapsed header strip + draggable resize when expanded.
// Body is a 2-column split: orphan materials | resolved memos.

function BottomDrawer({
  orphans,
  resolvedMemos,
  editingId,
  setEditingId,
  memoUsecases,
  materialUsecases,
  relationUsecases,
  removeRelation,
  openMaterialInApp,
  openMaterialInSystem,
}: {
  orphans: Material[];
  resolvedMemos: Memo[];
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  memoUsecases: ReturnType<typeof useBookMemo>;
  materialUsecases: ReturnType<typeof useBookMaterial>;
  relationUsecases: ReturnType<typeof useEntityRelations>;
  removeRelation: (
    fromKind: EntityKind,
    fromId: string,
    toKind: EntityKind,
    toId: string,
  ) => void;
  openMaterialInApp: (m: Material) => void;
  openMaterialInSystem: (m: Material) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState(DRAWER_DEFAULT_HEIGHT);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleDragMove = useCallback((e: PointerEvent) => {
    const state = dragRef.current;
    if (!state) return;
    const delta = state.startY - e.clientY;
    setHeight(Math.max(DRAWER_MIN_HEIGHT, state.startHeight + delta));
  }, []);

  const handleDragEnd = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', handleDragMove);
    window.removeEventListener('pointerup', handleDragEnd);
    window.removeEventListener('pointercancel', handleDragEnd);
  }, [handleDragMove]);

  const handleDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!expanded) return;
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startHeight: height };
      window.addEventListener('pointermove', handleDragMove);
      window.addEventListener('pointerup', handleDragEnd);
      window.addEventListener('pointercancel', handleDragEnd);
    },
    [expanded, handleDragMove, handleDragEnd, height],
  );

  useEffect(
    () => () => {
      if (dragRef.current) {
        window.removeEventListener('pointermove', handleDragMove);
        window.removeEventListener('pointerup', handleDragEnd);
        window.removeEventListener('pointercancel', handleDragEnd);
      }
    },
    [handleDragMove, handleDragEnd],
  );

  const drawerHeight = expanded ? height : DRAWER_HEADER_HEIGHT;

  return (
    <div
      style={{
        height: drawerHeight,
        flexShrink: 0,
        borderTop: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep) / 0.5)',
        display: 'flex',
        flexDirection: 'column',
        transition: dragRef.current ? 'none' : 'height 0.18s ease',
      }}
    >
      <div
        onPointerDown={handleDragStart}
        style={{
          height: 4,
          marginTop: -2,
          cursor: expanded ? 'ns-resize' : 'default',
          userSelect: 'none',
        }}
        aria-hidden
      />
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          height: DRAWER_HEADER_HEIGHT - 4,
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'hsl(var(--ink-3))',
          flexShrink: 0,
        }}
        aria-expanded={expanded}
        title={expanded ? '收起抽屉' : '展开抽屉'}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span>
            待整理{' '}
            <span style={{ color: 'hsl(var(--ink-4))' }}>{orphans.length}</span>
          </span>
          <span style={{ color: 'hsl(var(--ink-5))' }}>·</span>
          <span>
            已解决{' '}
            <span style={{ color: 'hsl(var(--ink-4))' }}>{resolvedMemos.length}</span>
          </span>
        </span>
        <ChevronUp
          size={12}
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.18s ease',
          }}
        />
      </button>

      {expanded && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 1,
            background: 'hsl(var(--rule))',
          }}
        >
          {/* Orphan materials */}
          <div
            style={{
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'hsl(var(--paper))',
            }}
          >
            <SubHeader kicker="待整理 · 无关联材料" count={orphans.length} />
            <div
              className="smm-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: '8px 12px 12px',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 8,
                alignContent: 'start',
              }}
            >
              {orphans.length === 0 && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    padding: '20px 8px',
                    fontFamily: 'var(--font-serif)',
                    fontStyle: 'italic',
                    fontSize: 12,
                    color: 'hsl(var(--ink-4))',
                    textAlign: 'center',
                  }}
                >
                  所有材料都已关联到至少一个实体。
                </div>
              )}
              {orphans.map((mat) => (
                <MaterialCard
                  key={mat.id}
                  material={mat}
                  relations={[]}
                  editing={editingId === mat.id}
                  onSetEditing={(on) => setEditingId(on ? mat.id : null)}
                  onOpenInSystem={() => openMaterialInSystem(mat)}
                  onOpenInApp={() => openMaterialInApp(mat)}
                  onUpdate={(updates) => materialUsecases.updateMaterial(mat.id, updates)}
                  onDelete={() => materialUsecases.removeMaterial(mat.id)}
                  onAddRelation={(t) =>
                    relationUsecases.addRelation('material', mat.id, t.kind, t.id)
                  }
                  onRemoveRelation={(t) => removeRelation('material', mat.id, t.kind, t.id)}
                  defaultExpanded
                />
              ))}
            </div>
          </div>

          {/* Resolved memos */}
          <div
            style={{
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              background: 'hsl(var(--paper))',
            }}
          >
            <SubHeader kicker="已解决 · 备忘归档" count={resolvedMemos.length} />
            <div
              className="smm-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                padding: '6px 12px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              {resolvedMemos.length === 0 && (
                <div
                  style={{
                    padding: '20px 8px',
                    fontFamily: 'var(--font-serif)',
                    fontStyle: 'italic',
                    fontSize: 12,
                    color: 'hsl(var(--ink-4))',
                    textAlign: 'center',
                  }}
                >
                  暂无已解决的备忘。
                </div>
              )}
              {resolvedMemos.map((m) => (
                <ResolvedMemoRow
                  key={m.id}
                  memo={m}
                  onReopen={() => memoUsecases.setMemoResolution(m.id, 'unresolved')}
                  onDelete={() => memoUsecases.removeMemo(m.id)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SubHeader({ kicker, count }: { kicker: string; count: number }) {
  return (
    <div
      style={{
        height: 26,
        flexShrink: 0,
        padding: '0 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        borderBottom: '1px solid hsl(var(--rule))',
        background: 'hsl(var(--paper-deep) / 0.4)',
      }}
    >
      <span style={kickerStyle}>{kicker}</span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          color: 'hsl(var(--ink-4))',
        }}
      >
        {count}
      </span>
    </div>
  );
}

function ResolvedMemoRow({
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
        opacity: 0.78,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'hsl(var(--story-3))',
          flexShrink: 0,
        }}
      />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: 'var(--font-serif)',
          fontSize: 12.5,
          color: 'hsl(var(--ink-2))',
          textDecoration: 'line-through',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={memo.title}
      >
        {memo.title || '无标题'}
      </div>
      <button
        onClick={onReopen}
        title="重新打开"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5,
          padding: '1px 6px',
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
// Outer overlay shell — full-screen above the BottomStatusBar, same chrome
// as StoryGraphView / SuperElementView (z 250, leaves BSB exposed).

const overlayStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: BSB_HEIGHT,
  zIndex: 250,
  background: 'hsl(var(--paper))',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
};
