import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/Button';
import { BrushIcon } from '../../../components/ui/BrushIcon';
import { stepGlassFlow } from '../../../lib/glass-flow';
import { STRUCTURAL_EASING, STRUCTURAL_MS } from '../../../lib/motion';
import { TabPromotionSuppressedContext } from '../../../store/tab-promotion-context';
import { EditorRailPresentationContext } from '../../../components/editor/editor-rail-presentation';
import { ISLAND_WIDTH_MAX, ISLAND_WIDTH_MIN, clampIslandWidth, storeIslandWidth } from './super-element-island-width';

/** Below this the sheet's header keeps only the name, 收成小卡 and close. */
const COMPACT_WIDTH = 360;

export interface SuperElementIslandProps {
  mode: 'peek' | 'sheet';
  /** The thing's sand mark and name, for the sheet's header. */
  title: ReactNode;
  kindLabel: string;
  /** The small card: a quick look and the way into the editor. */
  peek: ReactNode;
  /** The overview's own facts above the editor (appearance, companions); folds away. */
  strip: ReactNode | null;
  /** The workspace's own editor for the thing, unchanged. */
  editor: ReactNode;
  widthRatio: number;
  onWidthRatio: (ratio: number) => void;
  onCollapse: () => void;
  onClose: () => void;
  onOpenInTab: () => void;
}

/**
 * The element overview's floating island (2026-10-30, the prototype's B): a
 * lifted piece of desk inset from the canvas's edges with rounded corners
 * and no glass. It begins as a small card at the top right; 编辑 grows it
 * down the right side into a full-height sheet holding the workspace's own
 * element or category editor, on the structural motion. The sheet's left
 * edge is dragged to change its width between 15% and 75% of the canvas,
 * the edge bleeding glass as it moves, and the width is remembered.
 */
export function SuperElementIsland({
  mode, title, kindLabel, peek, strip, editor, widthRatio, onWidthRatio, onCollapse, onClose, onOpenInTab,
}: SuperElementIslandProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement | null>(null);
  const edgeRef = useRef<HTMLDivElement | null>(null);
  const [liveRatio, setLiveRatio] = useState<number | null>(null);
  const [stripOpen, setStripOpen] = useState(true);
  const [compact, setCompact] = useState(false);
  // The editor's outline rail would sit on the narrow paper's folio and
  // title, so the island opens with it folded; the paper toolbar's outline
  // button unfolds it here only, leaving the workspace's setting alone.
  const [outlineOpen, setOutlineOpen] = useState(false);
  const railPresentation = useMemo(
    () => ({ outlineVisible: outlineOpen, onOutlineToggle: () => setOutlineOpen((open) => !open) }),
    [outlineOpen],
  );
  const ratio = liveRatio ?? widthRatio;

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < COMPACT_WIDTH));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Grow from the card into the sheet (and back) instead of jumping: the
  // box moves from where it was drawn to where it now lays out.
  const drawn = useRef<{ mode: SuperElementIslandProps['mode']; left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const box = element.getBoundingClientRect();
    const origin = parent.getBoundingClientRect();
    const now = { mode, left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height };
    const before = drawn.current;
    drawn.current = now;
    if (!before || before.mode === mode) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const frame = (rect: typeof now) => ({
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, right: 'auto', bottom: 'auto',
    });
    element.animate([frame(before), frame(now)], { duration: STRUCTURAL_MS, easing: STRUCTURAL_EASING });
  });

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const element = ref.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    event.preventDefault();
    event.stopPropagation();
    const edge = event.currentTarget;
    try {
      edge.setPointerCapture(event.pointerId);
    } catch {
      /* a synthetic pointer: the edge still follows while it stays over it */
    }
    const area = parent.getBoundingClientRect();
    const inset = area.right - element.getBoundingClientRect().right;
    let lastX = event.clientX;
    let next = widthRatio;
    const move = (moveEvent: PointerEvent) => {
      next = clampIslandWidth((area.right - inset - moveEvent.clientX) / area.width);
      setLiveRatio(next);
      if (edgeRef.current) stepGlassFlow(edgeRef.current, Math.abs(moveEvent.clientX - lastX));
      lastX = moveEvent.clientX;
    };
    const stop = () => {
      edge.removeEventListener('pointermove', move);
      edge.removeEventListener('pointerup', stop);
      edge.removeEventListener('pointercancel', stop);
      setLiveRatio(null);
      storeIslandWidth(next);
      onWidthRatio(next);
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', stop);
    edge.addEventListener('pointercancel', stop);
  };

  return (
    <aside
      ref={ref}
      className={`se-island se-island--${mode}${compact ? ' is-compact' : ''}${liveRatio !== null ? ' is-resizing' : ''}`}
      style={mode === 'sheet' ? { width: `${(ratio * 100).toFixed(2)}%` } : undefined}
      data-super-modal
      // Presses here, and in the editor's menus portaled to body (React
      // bubbles them through here), never start the canvas's pan or drag.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {mode === 'peek' ? peek : (
        <>
          <div
            ref={edgeRef}
            className="se-island__edge"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('superElement.isles.island.resize')}
            aria-valuemin={Math.round(ISLAND_WIDTH_MIN * 100)}
            aria-valuemax={Math.round(ISLAND_WIDTH_MAX * 100)}
            aria-valuenow={Math.round(ratio * 100)}
            onPointerDown={startResize}
          >
            <span className="flow-line flow-line--v se-island__edge-flow" aria-hidden="true" />
          </div>
          <header className="se-island__head">
            {title}
            <span className="se-island__kind">{kindLabel}</span>
            <span className="se-island__spacer" />
            <Button variant="ghost" size="sm" className="se-island__open" data-se-open-tab="" onClick={onOpenInTab}>{t('superElement.isles.island.openInTab')}</Button>
            <Button variant="ghost" size="sm" onClick={onCollapse}>{t('superElement.isles.island.collapse')}</Button>
            <button
              type="button"
              className="se-island__close glass glass--rest glass--round"
              aria-label={t('superElement.isles.detail.close')}
              onClick={onClose}
            >
              <BrushIcon name="close" size={12} />
            </button>
          </header>
          {strip && (
            <div className={stripOpen ? 'se-island__strip' : 'se-island__strip is-folded'}>
              {stripOpen && strip}
              <button type="button" className="se-island__fold" onClick={() => setStripOpen((open) => !open)}>
                {stripOpen ? t('superElement.isles.island.fold') : t('superElement.isles.island.unfold')}
              </button>
            </div>
          )}
          <div className="se-island__body">
            <TabPromotionSuppressedContext.Provider value>
              <EditorRailPresentationContext.Provider value={railPresentation}>
                {editor}
              </EditorRailPresentationContext.Provider>
            </TabPromotionSuppressedContext.Provider>
          </div>
        </>
      )}
    </aside>
  );
}
