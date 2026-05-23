import { useEffect, useRef, useState } from 'react';
import type { EntityRelationLink } from '../../store/data-store';

// Dropdown menu invoked from the story graph view's top-right legend. Lists
// every kind that currently exists in the project (plus a locked
// "storyline transit" row), and exposes inline rename / recolor /
// delete for each user-defined kind. The "uncategorized" bucket
// (edges with kind=null) is recolored only — it can't be renamed or
// deleted as a unit because that would mean assigning a kind to every
// uncategorized edge.

const KIND_PALETTE = [
  'hsl(var(--story-1))',
  'hsl(var(--story-2))',
  'hsl(var(--story-3))',
  'hsl(var(--story-4))',
  'hsl(var(--story-5))',
  'hsl(var(--story-6))',
  'hsl(var(--ink-3))',
];

// Sentinel used by the consumer when keying the uncategorized bucket.
const UNCATEGORIZED_KIND = '__uncategorized__';

export interface EdgeKindManagerProps {
  open: boolean;
  onClose: () => void;
  // The button that opens the menu. Treated as "inside" by the
  // outside-click handler so clicking the button while open closes
  // (via the button's own onClick toggle) instead of: outside-click
  // closes → button click re-opens, which is what happened without
  // this ref.
  anchorRef?: React.RefObject<HTMLElement | null>;
  // Every kind the project currently has, including the uncategorized
  // sentinel when at least one null-kind edge exists.
  kinds: string[];
  // Resolved current color per kind (override → palette hash fallback);
  // identical to what the chips display.
  resolveKindColor: (kind: string | null) => string;
  // Color override controls — see useEdgeKindMeta.
  setKindColor: (kind: string | null, color: string) => void;
  clearKindColor: (kind: string | null) => void;
  reassignMeta: (oldKind: string | null, newKind: string | null) => void;
  removeMeta: (kind: string | null) => void;
  // Edge data + mutators for the bulk rename / delete operations. Edges live
  // in entity_relation now; the graph view restricts these to node↔node rows
  // so renaming/deleting here only touches what the user authored on the
  // canvas.
  nodeEdges: EntityRelationLink[];
  updateEdgeKind: (id: string, kind: string | null) => Promise<unknown>;
  deleteEdge: (id: string) => Promise<unknown>;
}

export function EdgeKindManager({
  open,
  onClose,
  anchorRef,
  kinds,
  resolveKindColor,
  setKindColor,
  clearKindColor,
  reassignMeta,
  removeMeta,
  nodeEdges,
  updateEdgeKind,
  deleteEdge,
}: EdgeKindManagerProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Which row is currently in rename mode (kind name) or showing the
  // color palette popover (kind name).
  const [editingName, setEditingName] = useState<string | null>(null);
  const [pickingColor, setPickingColor] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      // Treat the anchor button as "inside" so its own onClick toggle
      // can close the menu. Without this, the document-level capture
      // closes here and the button's onClick then re-opens it.
      if (anchorRef?.current?.contains(t)) return;
      onClose();
    };
    // ESC is handled by the parent's central router (so a stack of
    // overlays pops in LIFO order instead of each component fighting
    // for the keystroke).
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  const handleRename = async (oldKind: string, newKindRaw: string) => {
    const newKind = newKindRaw.trim();
    if (!newKind || newKind === oldKind) {
      setEditingName(null);
      return;
    }
    // For the "uncategorized" bucket the underlying edge field is null,
    // not the sentinel string — renaming it classifies every null-kind
    // edge under the new name. Otherwise filter by exact kind match.
    const oldKindForData = oldKind === UNCATEGORIZED_KIND ? null : oldKind;
    const affected = nodeEdges.filter((e) => (e.kind ?? null) === oldKindForData);
    for (const e of affected) {
      try {
        await updateEdgeKind(e.id, newKind);
      } catch {
        /* swallow per-edge errors — partial rename is still useful */
      }
    }
    reassignMeta(oldKindForData, newKind);
    setEditingName(null);
  };

  const handleDelete = async (kind: string) => {
    const label = kind === UNCATEGORIZED_KIND ? '未分类' : kind;
    if (!window.confirm(`删除所有「${label}」关联？此操作不可撤销。`)) return;
    const target = kind === UNCATEGORIZED_KIND ? null : kind;
    const affected = nodeEdges.filter((e) => (e.kind ?? null) === target);
    for (const e of affected) {
      try {
        await deleteEdge(e.id);
      } catch {
        /* keep going on individual failures */
      }
    }
    removeMeta(target);
  };

  return (
    <div ref={menuRef} className="edge-kind-mgr" role="menu">
      <div className="edge-kind-mgr__head">关联类型</div>

      {kinds.length === 0 && (
        <div className="edge-kind-mgr__empty">尚无自定义关联类型</div>
      )}

      {kinds.map((kind) => {
        const isUncategorized = kind === UNCATEGORIZED_KIND;
        const label = isUncategorized ? '未分类' : kind;
        const color = resolveKindColor(isUncategorized ? null : kind);
        const isEditingName = editingName === kind;
        const isPickingColor = pickingColor === kind;
        return (
          <div key={kind} className="edge-kind-mgr__row">
            <button
              type="button"
              className="edge-kind-mgr__swatch"
              style={{ background: color }}
              title="点击改色"
              onClick={() => setPickingColor(isPickingColor ? null : kind)}
              aria-label={`修改 ${label} 的颜色`}
            />
            {isPickingColor && (
              <div className="edge-kind-mgr__palette" role="listbox">
                {KIND_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="edge-kind-mgr__palette-dot"
                    style={{ background: c }}
                    onClick={() => {
                      setKindColor(isUncategorized ? null : kind, c);
                      setPickingColor(null);
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="edge-kind-mgr__palette-reset"
                  title="恢复默认色（按名称推导）"
                  onClick={() => {
                    clearKindColor(isUncategorized ? null : kind);
                    setPickingColor(null);
                  }}
                >
                  ↺
                </button>
              </div>
            )}

            {isEditingName ? (
              <input
                className="edge-kind-mgr__name-input"
                defaultValue={isUncategorized ? '' : kind}
                placeholder={isUncategorized ? '为未分类边命名…' : undefined}
                autoFocus
                onBlur={(e) => void handleRename(kind, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
                  if (e.key === 'Escape') {
                    setEditingName(null);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="edge-kind-mgr__name"
                onClick={() => setEditingName(kind)}
                title={
                  isUncategorized
                    ? '点击为「未分类」边命名（将分类所有未分类边）'
                    : '点击重命名'
                }
              >
                {label}
              </button>
            )}

            <button
              type="button"
              className="edge-kind-mgr__delete"
              title={`删除所有「${label}」关联`}
              onClick={() => void handleDelete(kind)}
              aria-label={`删除 ${label}`}
            >
              ×
            </button>
          </div>
        );
      })}

      {/* Locked storyline-transit row, pinned to the bottom of the
          menu. Always visible so the dashed cross-storyline trails
          have a discoverable explanation, but it can't be renamed /
          recolored / deleted — it's auto-generated, not user-defined. */}
      <div className="edge-kind-mgr__row is-locked">
        <span className="edge-kind-mgr__swatch is-dashed" aria-hidden />
        <span className="edge-kind-mgr__name is-static">故事线衔接</span>
        <span className="edge-kind-mgr__hint" title="多 storyline 节点之间的衔接轨迹，自动生成">
          自动 · 锁定
        </span>
      </div>
    </div>
  );
}
