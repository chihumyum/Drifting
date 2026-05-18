import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../store/ui-store';

export interface OutlineEntry {
  id: string;
  level: 1 | 2 | 3;
  text: string;
  num?: string;
}

interface Props {
  title: string;
  items: OutlineEntry[];
  activeId?: string | null;
  onItemClick?: (id: string) => void;
  footLeft?: string;
  footRight?: string;
  emptyHint?: string;
  // Optional second outline group (typically body markdown headings rendered
  // below the static section framework). Separated by a thin horizontal rule
  // only — no label, no count — and starts a fresh h1/h2/h3 hierarchy.
  // When empty, nothing is rendered (no divider, no hint).
  secondaryItems?: OutlineEntry[];
}

// Width of the expanded TOC panel.
const OVERLAY_WIDTH = 200;

// Outline rail shared by all entity editors. The rail is rendered as an
// absolutely-positioned child of `.editor-body` and pinned to its top-left
// (just under the breadcrumb bar) — never in flex flow. Only the toggle
// button at the top is visually styled (the rest of the rail box is
// transparent and just exists as the panel's positioning anchor), so the
// outline reads as a small "tab" peeking out of the left edge.
//
// Two render modes:
//   • collapsed → tab only.
//   • expanded  → tab + 200px panel anchored to the tab's right edge.
//                 If the panel would overlap the manuscript, its
//                 background switches to a slight gradient to signal the
//                 overlay; otherwise it stays solid and reads as in-flow.
//
// The rail itself never moves — the only animation is the panel sliding in.
export function EditorOutlinePanel({
  title,
  items,
  activeId,
  onItemClick,
  footLeft,
  footRight,
  emptyHint = '— 暂无标题 —',
  secondaryItems,
}: Props) {
  const collapsed = useUiStore((s) => s.outlineCollapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleOutlineCollapsed);

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

  // Whether the expanded panel would overlap the manuscript. We use this
  // only to pick the background: solid when the panel sits cleanly in the
  // body's left margin, gradient when it spills onto the manuscript. The
  // panel's position itself never changes — it's always anchored to the
  // tab's right edge.
  const [coversManuscript, setCoversManuscript] = useState(false);
  useEffect(() => {
    if (!bodyEl) return;
    const compute = () => {
      const rail = railRef.current;
      const manuscript = bodyEl.querySelector('.editor-scroll') as HTMLElement | null;
      if (!rail || !manuscript) return;
      const railRect = rail.getBoundingClientRect();
      const manuscriptRect = manuscript.getBoundingClientRect();
      setCoversManuscript(railRect.right + OVERLAY_WIDTH > manuscriptRect.left);
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

  const renderItem = (item: OutlineEntry) => {
    const cls = `toc-item toc-item--h${item.level}${activeId === item.id ? ' toc-item--active' : ''}`;
    return (
      <a key={item.id} className={cls} onClick={handleClick(item.id)}>
        {item.num && <span className="toc-item__num">{item.num}</span>}
        <span>{item.text}</span>
      </a>
    );
  };

  const hasSecondary = secondaryItems && secondaryItems.length > 0;

  const body = (
    <>
      <div className="toc-head">
        <span>{title}</span>
        <span className="toc-head__right">
          {items.length > 0 && <span className="toc-head__count">{items.length} 节</span>}
          <button
            type="button"
            className="toc-toggle"
            onClick={toggleCollapsed}
            title="收起大纲"
            aria-label="收起大纲"
          >
            ‹
          </button>
        </span>
      </div>

      {items.length === 0 ? (
        <div className="toc-empty">{emptyHint}</div>
      ) : (
        items.map(renderItem)
      )}

      {hasSecondary && (
        <>
          <hr className="toc-divider" />
          {secondaryItems!.map(renderItem)}
        </>
      )}

      {(footLeft || footRight) && (
        <div className="toc-foot">
          <span>{footLeft ?? ''}</span>
          <span>{footRight ?? ''}</span>
        </div>
      )}
    </>
  );

  // Collapsed: slim rail only.
  if (collapsed) {
    return (
      <nav className="editor__toc-rail" ref={attachRoot} aria-label="Outline rail">
        <button
          type="button"
          className="toc-toggle--rail"
          onClick={toggleCollapsed}
          title="展开大纲"
          aria-label="展开大纲"
          aria-expanded={false}
        >
          <span className="toc-toggle__chevron" aria-hidden="true">›</span>
          <span className="toc-toggle__label">OUTLINE</span>
        </button>
      </nav>
    );
  }

  // Expanded: tab stays put, panel slides out to its right.
  return (
    <nav className="editor__toc-rail" ref={attachRoot} aria-label="Outline rail">
      <button
        type="button"
        className="toc-toggle--rail"
        onClick={toggleCollapsed}
        title="收起大纲"
        aria-label="收起大纲"
        aria-expanded={true}
      >
        <span className="toc-toggle__chevron" aria-hidden="true">‹</span>
        <span className="toc-toggle__label">OUTLINE</span>
      </button>
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
