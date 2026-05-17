import { useCallback, useEffect, useState } from 'react';
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

// Threshold (in container px) below which we consider the editor too narrow
// to comfortably host both a 720px manuscript and a 168px in-flow TOC.
// Below this: TOC auto-collapses, and if the user re-expands, the panel
// renders as an overlay (no layout impact) instead of inline.
const NARROW_THRESHOLD = 880;

// Sticky left-rail outline shared by all entity editors. Render inside an
// `.editor__spread`. Items can be h1/h2/h3; an h2 with a `num` shows the
// Chinese ordinal accent before the title (一/二/三).
//
// Three render modes, gated by (collapsed × container-width):
//   • collapsed                         → 32px slim rail in flow
//   • expanded + wide   (>= threshold)  → original 168px in-flow .editor__toc
//   • expanded + narrow (<  threshold)  → 32px rail in flow + overlay panel
//                                         (overlay floats above the page,
//                                          styled like the in-flow TOC plus
//                                          an opaque gradient background)
//
// On a shrink-transition across the threshold we force-collapse once so the
// page doesn't compress; widening never auto-expands.
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
  const setCollapsed = useUiStore((s) => s.setOutlineCollapsed);
  const toggleCollapsed = useUiStore((s) => s.toggleOutlineCollapsed);

  // Callback ref pattern: every render attaches to whichever root we mount
  // (rail or in-flow nav). We walk up to the `.editor-body` ancestor — that's
  // the flex row hosting the TOC alongside .editor-scroll — and observe its
  // width to drive auto-collapse.
  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null);
  const attachRoot = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const ancestor = el.closest('.editor-body') as HTMLElement | null;
    setContainerEl((prev) => (prev === ancestor ? prev : ancestor));
  }, []);

  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    if (!containerEl) return;
    let prevNarrow = containerEl.clientWidth < NARROW_THRESHOLD;
    setIsNarrow(prevNarrow);
    if (prevNarrow) setCollapsed(true);

    const ro = new ResizeObserver(() => {
      const nowNarrow = containerEl.clientWidth < NARROW_THRESHOLD;
      if (nowNarrow !== prevNarrow) {
        setIsNarrow(nowNarrow);
        if (nowNarrow) setCollapsed(true);
      }
      prevNarrow = nowNarrow;
    });
    ro.observe(containerEl);
    return () => ro.disconnect();
  }, [containerEl, setCollapsed]);

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

  // Shared body markup used by both the in-flow nav (wide) and overlay (narrow).
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

  // Wide + expanded: original in-flow TOC. CSS makes this sticky against
  // the .editor-scroll container so it pins as the user scrolls the page.
  if (!isNarrow) {
    return (
      <nav className="editor__toc" ref={attachRoot} aria-label="Outline">
        {body}
      </nav>
    );
  }

  // Narrow + expanded: rail holds the 32px slot in .editor-body's centered
  // group, AND nests the overlay as a positioned child. Because the rail is
  // a sibling of .editor-scroll (NOT inside it), the overlay sits next to
  // the manuscript and doesn't move with page scroll. Nesting (rather than
  // overlaying via .editor-body coords) keeps the overlay glued to the
  // rail's current position even as the centered group reflows.
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
      <div className="editor__toc-overlay" role="dialog" aria-label="Outline">
        {body}
      </div>
    </nav>
  );
}
