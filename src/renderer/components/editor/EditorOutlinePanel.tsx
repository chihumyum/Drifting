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

// Width of the expanded TOC panel. The panel is always rendered as an
// absolutely-positioned child of the rail; this constant also drives the
// left/right side choice (we need at least this much clear space to the
// left of the rail before placing the panel on the left).
const OVERLAY_WIDTH = 200;

// Sticky left-rail outline shared by all entity editors. Render inside an
// `.editor__spread`. Items can be h1/h2/h3; an h2 with a `num` shows the
// Chinese ordinal accent before the title (一/二/三).
//
// Two render modes:
//   • collapsed → 32px rail in flow only.
//   • expanded  → 32px rail in flow + 200px overlay panel anchored to the
//                 rail. The overlay defaults to the LEFT side (extending
//                 into the body's empty left margin) so the manuscript
//                 never shifts horizontally when the outline is toggled.
//                 When the body's left margin can't fit the panel, the
//                 overlay flips to the RIGHT side and floats above the
//                 manuscript instead.
//
// Because the rail is always 32px in flow, expanding/collapsing never
// reflows the manuscript.
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

  // Which side of the rail to host the expanded overlay. 'left' is the
  // preferred placement (into empty body margin); 'right' is the fallback
  // when there's no room on the left.
  const [overlaySide, setOverlaySide] = useState<'left' | 'right'>('left');
  useEffect(() => {
    if (!bodyEl) return;
    const compute = () => {
      const rail = railRef.current;
      if (!rail) return;
      const bodyRect = bodyEl.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      const leftRoom = railRect.left - bodyRect.left;
      setOverlaySide(leftRoom >= OVERLAY_WIDTH ? 'left' : 'right');
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

  // Expanded: rail in flow + overlay panel anchored to the rail. Side is
  // chosen based on whether there's room to the left of the rail; default
  // is LEFT so the manuscript never shifts horizontally.
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
        className={`editor__toc-overlay editor__toc-overlay--${overlaySide}`}
        role="dialog"
        aria-label="Outline"
      >
        {body}
      </div>
    </nav>
  );
}
