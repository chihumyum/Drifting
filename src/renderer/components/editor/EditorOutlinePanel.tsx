import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../../store/ui-store';

export interface OutlineEntry {
  id: string;
  level: 1 | 2 | 3;
  // Structural role, drives which of the five visual tiers the row renders as:
  //   act      → L1, a centred chapter-break divider (not a list row)
  //   chapter  → L2, the primary navigation unit
  //   section  → L2, a static framework anchor (entity editors) — same tier
  //   heading  → L3/L4/L5 by `level` (1→scene, 2→beat, 3→note)
  // Defaults to heading when omitted. The mapping is fixed regardless of view,
  // so a given heading reads identically whether it sits under an act+chapter
  // (whole-book TOC) or at the root (single-chapter / entity TOC).
  kind?: 'act' | 'chapter' | 'section' | 'heading';
  text: string;
  // Optional ordinal prefix (e.g. 一/二/三 for entity-editor framework
  // sections). NOT used to inject act/chapter numbering — those are name-only.
  num?: string;
  // Nested entries. When present the row gets a caret that toggles the
  // subtree; expansion state is owned internally by this component.
  children?: OutlineEntry[];
}

interface Props {
  title: string;
  items: OutlineEntry[];
  activeId?: string | null;
  onItemClick?: (id: string) => void;
  emptyHint?: string;
  // Optional second outline group (typically body markdown headings rendered
  // below the static section framework). Separated by a thin horizontal rule
  // only — no label, no count. When empty, nothing is rendered.
  secondaryItems?: OutlineEntry[];
  // When true, L2 rows (chapters) start COLLAPSED and expansion is left
  // entirely to the user's carets — it is NOT coupled to the scroll position.
  // The whole-book TOC uses this so a fast scroll only slides the active-row
  // highlight; it never mounts/unmounts subtrees underneath it. Other views
  // leave it off and everything starts expanded.
  collapseChaptersByDefault?: boolean;
}

// Width of the expanded TOC panel.
const OVERLAY_WIDTH = 200;

/**
 * Fold a flat heading list (h1/h2/h3) into a nested OutlineEntry tree, so the
 * panel can draw guide rails and per-tier indents. A heading nests under the
 * most recent shallower heading; an h2/h3 with no shallower ancestor becomes a
 * root. Levels are preserved (1→scene, 2→beat, 3→note styling downstream).
 */
export function nestHeadings(
  headings: { id: string; level: 1 | 2 | 3; text: string }[],
): OutlineEntry[] {
  const roots: OutlineEntry[] = [];
  const stack: OutlineEntry[] = [];
  for (const h of headings) {
    const entry: OutlineEntry = { id: h.id, level: h.level, kind: 'heading', text: h.text };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    if (stack.length === 0) {
      roots.push(entry);
    } else {
      const parent = stack[stack.length - 1];
      (parent.children ??= []).push(entry);
    }
    stack.push(entry);
  }
  return roots;
}

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
//
// Five visual tiers, each quieter than the last (越深越安静): centred act
// dividers, then chapter / scene / beat / note carried by indent + size + ink
// + font-family + guide rails. See the .toc-* rules in styles/index.css.
export function EditorOutlinePanel({
  title,
  items,
  activeId,
  onItemClick,
  emptyHint,
  secondaryItems,
  collapseChaptersByDefault = false,
}: Props) {
  const { t } = useTranslation();
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
  const handleActivateKey = useCallback(
    (id: string) => (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onItemClick?.(id);
    },
    [onItemClick],
  );

  // Expansion is owned here: a sparse override map (id → forced open/closed)
  // layered over per-kind defaults. The defaults are STATIC — they do not react
  // to `activeId`/scroll. (They used to: the active chapter auto-expanded and
  // the previous one auto-collapsed. But driving expansion from the scroll
  // position made fast scrolls churn whole subtrees in and out — flicker, plus
  // the layout change fed back into the scroller. Now scroll only moves the
  // highlight; the carets are the only thing that opens/closes a subtree.)
  const [openOverride, setOpenOverride] = useState<Map<string, boolean>>(new Map());
  const toggleOpen = useCallback((id: string, next: boolean) => {
    setOpenOverride((prev) => {
      const m = new Map(prev);
      m.set(id, next);
      return m;
    });
  }, []);
  const defaultOpen = (item: OutlineEntry): boolean => {
    // Chapters in the whole-book TOC start collapsed and only the user's carets
    // open them; the active chapter is highlighted (see `active` below) but
    // never force-expanded. Everything else defaults open.
    if (collapseChaptersByDefault && item.kind === 'chapter') return false;
    return true;
  };
  const isOpen = (item: OutlineEntry): boolean =>
    openOverride.has(item.id) ? openOverride.get(item.id)! : defaultOpen(item);

  // The "you are here" trail: the active row PLUS every ancestor up to its root.
  // The scroll-spy reports a single deepest id (e.g. a heading buried in a
  // chapter); lighting only that row would make the highlight stop at whatever
  // level the id sits on. By marking the whole chain we let it read as one
  // continuous path — chapter (L2 wash) → … → inner heading (accent) — instead
  // of snapping to a lone row. Empty when nothing is active.
  const activePathIds = useMemo(() => {
    const path = new Set<string>();
    if (activeId == null) return path;
    const walk = (entry: OutlineEntry, ancestors: string[]): boolean => {
      if (entry.id === activeId) {
        for (const a of ancestors) path.add(a);
        path.add(entry.id);
        return true;
      }
      if (entry.children) {
        const next = [...ancestors, entry.id];
        for (const child of entry.children) if (walk(child, next)) return true;
      }
      return false;
    };
    for (const root of [...items, ...(secondaryItems ?? [])]) {
      if (walk(root, [])) break;
    }
    return path;
  }, [items, secondaryItems, activeId]);

  const renderEntry = (item: OutlineEntry): React.ReactNode => {
    // L1 · act — a centred divider flanked by hairlines, never a list row.
    if (item.kind === 'act') {
      return (
        <div
          key={item.id}
          className="toc-act"
          onClick={handleClick(item.id)}
          onKeyDown={handleActivateKey(item.id)}
          role="button"
          tabIndex={0}
          aria-current={item.id === activeId ? 'location' : undefined}
        >
          <span className="toc-act__label">{item.text}</span>
        </div>
      );
    }

    const tier =
      item.kind === 'chapter' || item.kind === 'section'
        ? 'l2'
        : item.level === 1
          ? 'l3'
          : item.level === 2
            ? 'l4'
            : 'l5';
    const hasChildren = !!item.children?.length;
    const open = hasChildren && isOpen(item);
    // Any row on the active path lights up (not just the deepest active id), so
    // the highlight extends from the chapter down to the inner heading. Two-stage
    // "you are here": L2 (chapter/section) gets the wash; deeper rows get accent
    // text only — no spine, no wash (house style).
    const onActivePath = activePathIds.has(item.id);
    const activeClass = onActivePath ? (tier === 'l2' ? ' is-active' : ' is-current') : '';

    return (
      <div key={item.id} className={`toc-block toc-block--${tier}`}>
        <div
          className={`toc-row${activeClass}${open ? ' is-open' : ''}`}
          onClick={handleClick(item.id)}
          onKeyDown={(event) => {
            if (hasChildren && event.key === 'ArrowRight' && !open) {
              event.preventDefault();
              toggleOpen(item.id, true);
              return;
            }
            if (hasChildren && event.key === 'ArrowLeft' && open) {
              event.preventDefault();
              toggleOpen(item.id, false);
              return;
            }
            handleActivateKey(item.id)(event);
          }}
          role="button"
          tabIndex={0}
          aria-expanded={hasChildren ? open : undefined}
          aria-current={item.id === activeId ? 'location' : undefined}
        >
          <span
            className={`toc-row__caret${hasChildren ? '' : ' is-leaf'}`}
            onClick={
              hasChildren
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleOpen(item.id, !open);
                  }
                : undefined
            }
            onMouseDown={hasChildren ? (event) => event.stopPropagation() : undefined}
            aria-hidden={!hasChildren}
          >
            {hasChildren && (
              <svg viewBox="0 0 8 8" width="7" height="7" fill="currentColor" aria-hidden>
                <path d="M2 0l4 4-4 4z" />
              </svg>
            )}
          </span>
          {item.num && <span className="toc-row__ord">{item.num}</span>}
          <span className="toc-row__text">{item.text}</span>
        </div>
        {open && <div className="toc-kids">{item.children!.map(renderEntry)}</div>}
      </div>
    );
  };

  // Count navigable rows for the head badge — acts are dividers, not entries.
  const navCount = items.filter((i) => i.kind !== 'act').length;
  const hasSecondary = secondaryItems && secondaryItems.length > 0;
  const resolvedEmptyHint = emptyHint ?? t('editorOutline.emptyHint');

  const body = (
    <>
      <div className="toc-head">
        <span>{title}</span>
        {navCount > 0 && (
          <span className="toc-head__count">
            {t('editorOutline.sectionCount', { count: navCount })}
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="toc-empty">{resolvedEmptyHint}</div>
      ) : (
        items.map((item) => renderEntry(item))
      )}

      {hasSecondary && (
        <>
          <hr className="toc-divider" />
          {secondaryItems!.map((item) => renderEntry(item))}
        </>
      )}
    </>
  );

  // Collapsed: nothing is rendered — the toggle lives in the editor top bar.
  if (collapsed) return null;

  // Expanded: the panel sits flush at the body's left edge.
  return (
    <nav className="editor__toc-rail" ref={attachRoot} aria-label={t('editorOutline.aria')}>
      <div
        className={`editor__toc-overlay${coversManuscript ? ' editor__toc-overlay--over-manuscript' : ''}`}
      >
        {body}
      </div>
    </nav>
  );
}
