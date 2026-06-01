import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui-store';

export interface OutlineEntry {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  num?: string;
  // Optional nested entries. When non-empty the row gets a chevron handle
  // that toggles visibility via `onToggleExpand` (item-level open state is
  // controlled — driven by `isExpanded`). Used by the all-chapters editor
  // to nest each chapter's heading TOC under its chapter row.
  children?: OutlineEntry[];
  isExpanded?: boolean;
}

interface Props {
  title: string;
  items: OutlineEntry[];
  activeId?: string | null;
  onItemClick?: (id: string) => void;
  // Fires when the user clicks the chevron on an entry with children. The
  // caller owns expansion state and updates `isExpanded` on the next pass.
  onToggleExpand?: (id: string) => void;
  emptyHint?: string;
  // Optional second outline group (typically body markdown headings rendered
  // below the static section framework). Separated by a thin horizontal rule
  // only — no label, no count — and starts a fresh h1/h2/h3 hierarchy.
  // When empty, nothing is rendered (no divider, no hint).
  secondaryItems?: OutlineEntry[];
}

// Width of the expanded TOC panel.
const OVERLAY_WIDTH = 200;

// Outline panel shared by all entity editors. Rendered as an
// absolutely-positioned child of `.editor-body`, pinned to its top-left
// (just under the breadcrumb bar) and flush against the body's left edge —
// never in flex flow.
//
// Visibility is driven by the global `outlineCollapsed` UI flag, toggled by
// the outline button in the editor top bar (mirror of the comment-rail
// toggle on the right). There is no in-panel toggle:
//   • collapsed → renders nothing.
//   • expanded  → 200px panel. If it would overlap the manuscript, its
//                 background switches to a slight gradient to signal the
//                 overlay; otherwise it stays solid and reads as in-flow.
export function EditorOutlinePanel({
  title,
  items,
  activeId,
  onItemClick,
  onToggleExpand,
  emptyHint = '— 暂无标题 —',
  secondaryItems,
}: Props) {
  const collapsed = useUiStore((s) => s.outlineCollapsed);

  // Track both the rail element (to measure its current x-position) and
  // the .editor-body ancestor (to observe width changes that move the
  // centered group around).
  const railRef = useRef<HTMLElement | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const attachRoot = useCallback((el: HTMLElement | null) => {
    railRef.current = el;
    const ancestor = (el?.closest('.editor-body') as HTMLElement | null) ?? null;
    setBodyEl((prev) => (prev === ancestor ? prev : ancestor));
  }, []);

  // Whether the panel would overlap the manuscript. We use this only to
  // pick the background: solid when the panel sits cleanly in the body's
  // left margin, gradient when it spills onto the manuscript. The panel's
  // position itself never changes — it's always flush at the body's left
  // edge.
  const [coversManuscript, setCoversManuscript] = useState(false);
  useEffect(() => {
    if (!bodyEl) return;
    const compute = () => {
      const rail = railRef.current;
      const manuscript = bodyEl.querySelector('.editor-scroll') as HTMLElement | null;
      if (!rail || !manuscript) return;
      const railRect = rail.getBoundingClientRect();
      const manuscriptRect = manuscript.getBoundingClientRect();
      // Expanded panel sits flush at the rail's left edge, so its right edge
      // is railRect.left + OVERLAY_WIDTH — that's what must clear the
      // manuscript to avoid the overlay gradient.
      setCoversManuscript(railRect.left + OVERLAY_WIDTH > manuscriptRect.left);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(bodyEl);
    return () => ro.disconnect();
  }, [bodyEl, collapsed]);

  const handleClick = useCallback(
    (id: string) => () => onItemClick?.(id),
    [onItemClick],
  );

  const renderItem = (item: OutlineEntry, depth = 0): React.ReactNode => {
    const hasChildren = !!item.children?.length;
    const cls = `toc-item toc-item--h${item.level}${activeId === item.id ? ' toc-item--active' : ''}`;
    // Nested entries get a fresh paddingLeft on top of the per-level CSS
    // base (h1/h2 = 10px, h3 = 22px). We need a meaningful jump so users
    // can read the hierarchy at a glance — 28px at depth 1, +16px per
    // level after that. Anything subtler than ~18px over the base reads
    // as a typo, not as nesting.
    const inlinePaddingLeft = depth > 0 ? 28 + (depth - 1) * 16 : undefined;
    return (
      <div key={item.id}>
        <a
          className={cls}
          onClick={handleClick(item.id)}
          style={inlinePaddingLeft !== undefined ? { paddingLeft: inlinePaddingLeft } : undefined}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleExpand?.(item.id);
              }}
              onMouseDown={(event) => event.stopPropagation()}
              aria-label={item.isExpanded ? 'Collapse' : 'Expand'}
              aria-expanded={!!item.isExpanded}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                width: 14,
                height: 14,
                marginRight: 2,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'hsl(var(--ink-4))',
                fontSize: 9,
                flexShrink: 0,
                transition: 'color 0.12s',
              }}
            >
              {item.isExpanded ? '▾' : '▸'}
            </button>
          ) : (
            // Reserve the chevron slot at depth 0 only — keeps top-level
            // entries (chapter rows) aligned regardless of whether they
            // expose children. Deeper rows don't need the spacer because
            // they're already indented further via paddingLeft.
            depth === 0 && (
              <span
                aria-hidden
                style={{ display: 'inline-block', width: 14, marginRight: 2, flexShrink: 0 }}
              />
            )
          )}
          {item.num && <span className="toc-item__num">{item.num}</span>}
          <span>{item.text}</span>
        </a>
        {item.isExpanded && hasChildren && item.children!.map((c) => renderItem(c, depth + 1))}
      </div>
    );
  };

  const hasSecondary = secondaryItems && secondaryItems.length > 0;

  const body = (
    <>
      <div className="toc-head">
        <span>{title}</span>
        {items.length > 0 && <span className="toc-head__count">{items.length} 节</span>}
      </div>

      {items.length === 0 ? (
        <div className="toc-empty">{emptyHint}</div>
      ) : (
        items.map((item) => renderItem(item))
      )}

      {hasSecondary && (
        <>
          <hr className="toc-divider" />
          {secondaryItems!.map((item) => renderItem(item))}
        </>
      )}
    </>
  );

  // Collapsed: nothing is rendered — the toggle lives in the editor top bar.
  if (collapsed) return null;

  // Expanded: the panel sits flush at the body's left edge.
  return (
    <nav className="editor__toc-rail" ref={attachRoot} aria-label="Outline">
      <div
        className={`editor__toc-overlay${coversManuscript ? ' editor__toc-overlay--over-manuscript' : ''}`}
        role="dialog"
        aria-label="Outline"
      >
        {body}
      </div>
    </nav>
  );
}
