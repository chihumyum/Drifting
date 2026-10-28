import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { BrushIcon, type BrushIconName } from '../ui/BrushIcon';
import '../../../styles/chapter-end-menu.css';

/**
 * The ⁂ that closes a page, drawn as a dry garden's three stones. Drift pages
 * and the touch shell keep only this.
 */
export function ChapterEndOrnament() {
  return (
    <div className="page__ornament" aria-hidden="true">
      <BrushIcon name="stones-triad" size={20} />
    </div>
  );
}

export type ChapterEndReviewState = 'idle' | 'starting' | 'running';

export interface ChapterEndMenuProps {
  finished: boolean;
  onInsert: () => void;
  onToggleFinished: () => void;
  reviewState: ChapterEndReviewState;
  onReview: () => void;
}

// Opening waits for the pointer to actually move on ⁂ this long, so a page
// scrolling beneath a still pointer, or a sweep across the page, never opens it.
const HOVER_OPEN_MS = 70;
// The list is the area the pointer may roam: leaving it by more than this
// (above, below or past either side) restores ⁂ at once.
const BAND_SLOP_X = 6;
const BAND_SLOP_Y = 2;
// The primary action opens beneath a pointer resting on ⁂; a click this soon
// after a hover opened the row was meant for ⁂, not for that action.
const CLICK_GUARD_MS = 250;
const PRIMARY_INDEX = 1;

interface MenuItem {
  key: string;
  icon: BrushIconName;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

type Opener = 'hover' | 'click' | 'keyboard';

// A chapter page's ⁂ doubles as its end-of-chapter menu. Moving onto it (after
// a brief intent delay), a click or keyboard focus cross-fades the mark into
// three monospace actions, each led by its brush icon, in one column centred
// on ⁂ with the primary one on ⁂'s line. Leaving the list in any direction
// fades ⁂ straight back. A finished chapter's ⁂ takes the accent colour.
// Each action is a sand cell: under the pointer or keyboard focus its outline
// becomes the same faint ring of flowing glass as a sidebar cell's.
export function ChapterEndMenu({
  finished,
  onInsert,
  onToggleFinished,
  reviewState,
  onReview,
}: ChapterEndMenuProps) {
  const { t } = useTranslation();
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const openerRef = useRef<Opener>('hover');
  const openedAtRef = useRef(0);
  const focusIndexRef = useRef<number | null>(null);
  const armedRef = useRef(false);
  const [open, setOpen] = useState(false);

  const clearTimer = useCallback(() => window.clearTimeout(timerRef.current), []);
  const show = useCallback((opener: Opener, focusIndex: number | null = null) => {
    window.clearTimeout(timerRef.current);
    openerRef.current = opener;
    openedAtRef.current = performance.now();
    focusIndexRef.current = focusIndex;
    setOpen(true);
    if (focusIndex != null) itemRefs.current[focusIndex]?.focus({ preventScroll: true });
  }, []);
  const hide = useCallback((restoreFocus = false) => {
    window.clearTimeout(timerRef.current);
    armedRef.current = false;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  useEffect(() => {
    if (!open) return;
    // The row turns visible in this commit; keyboard focus can land now.
    const index = focusIndexRef.current;
    if (index != null) itemRefs.current[index]?.focus({ preventScroll: true });

    const outsideBand = (x: number, y: number) => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return true;
      return (
        x < rect.left - BAND_SLOP_X || x > rect.right + BAND_SLOP_X ||
        y < rect.top - BAND_SLOP_Y || y > rect.bottom + BAND_SLOP_Y
      );
    };
    const onPointerMove = (event: PointerEvent) => {
      if (openerRef.current !== 'keyboard' && outsideBand(event.clientX, event.clientY)) hide();
    };
    const onPointerLeaveWindow = () => {
      if (openerRef.current !== 'keyboard') hide();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      hide(Boolean(rowRef.current?.contains(document.activeElement)));
    };
    // The page moving under a still pointer is leaving the line too.
    const scroller: Element | Window = triggerRef.current?.closest('.editor-scroll') ?? window;
    const onScroll = () => hide();
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onPointerLeaveWindow);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener('mouseleave', onPointerLeaveWindow);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, hide]);

  const isHoverPointer = (event: ReactPointerEvent) => event.pointerType === 'mouse' || event.pointerType === 'pen';
  // Real pointer movement on ⁂ arms the opening; content scrolling under a
  // still pointer only fires boundary events, never a move.
  const handleTriggerMove = (event: ReactPointerEvent) => {
    if (!isHoverPointer(event) || open || armedRef.current) return;
    armedRef.current = true;
    timerRef.current = window.setTimeout(() => show('hover'), HOVER_OPEN_MS);
  };
  const handleTriggerLeave = (event: ReactPointerEvent) => {
    if (!isHoverPointer(event)) return;
    armedRef.current = false;
    if (!open) clearTimer();
  };
  const handleTriggerClick = (event: React.MouseEvent) => {
    // detail 0 = Enter/Space on the focused trigger.
    if (event.detail === 0) show('keyboard', PRIMARY_INDEX);
    else if (!open) show('click');
  };
  const handleTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      show('keyboard', PRIMARY_INDEX);
    }
  };

  const items: MenuItem[] = [
    {
      key: 'finish',
      // 搁笔 lays the brush down; 提笔 picks it up again.
      icon: finished ? 'brush-lifted' : 'brush-laid',
      label: finished ? t('chapterEnd.markDraft') : t('chapterEnd.markFinished'),
      onSelect: onToggleFinished,
    },
    { key: 'insert', icon: 'sprout', label: t('chapterEnd.insertAfter'), onSelect: onInsert },
    {
      key: 'review',
      icon: 'shikigami',
      label: t(`chapterEnd.review.${reviewState}`),
      onSelect: onReview,
      disabled: reviewState === 'starting',
    },
  ];

  // clickedAt is the click event's timeStamp, on performance.now()'s clock.
  const select = (item: MenuItem, clickedAt: number) => {
    const opener = openerRef.current;
    if (opener !== 'keyboard' && clickedAt - openedAtRef.current < CLICK_GUARD_MS) return;
    // Keyboard users return to ⁂, except after an insert: the new chapter's
    // title takes focus.
    hide(opener === 'keyboard' && item.key !== 'insert');
    item.onSelect();
  };
  const handleMenuKeyDown = (event: ReactKeyboardEvent) => {
    const current = itemRefs.current.findIndex((element) => element === document.activeElement);
    const move = (index: number) => {
      event.preventDefault();
      itemRefs.current[(index + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') move(current + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') move(current - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Tab') {
      event.preventDefault();
      hide(true);
    }
  };

  return (
    <div className="page__ornament page__ornament--menu" data-open={open}>
      <button
        ref={triggerRef}
        type="button"
        className="page__ornament-trigger"
        aria-label={finished ? t('chapterEnd.triggerFinished') : t('chapterEnd.trigger')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-finished={finished}
        onPointerMove={handleTriggerMove}
        onPointerLeave={handleTriggerLeave}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="page__ornament-glyph" aria-hidden="true">
          <BrushIcon name="stones-triad" size={20} />
        </span>
      </button>
      <div
        ref={rowRef}
        id={menuId}
        role="menu"
        aria-label={t('chapterEnd.trigger')}
        className="chapter-end-menu"
        onKeyDown={handleMenuKeyDown}
      >
        {items.map((item, index) => (
          <button
            key={item.key}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            className="chapter-end-menu__item sand-cell"
            data-action={item.key}
            data-primary={index === PRIMARY_INDEX}
            disabled={item.disabled}
            tabIndex={-1}
            onClick={(event) => select(item, event.timeStamp)}
          >
            <BrushIcon name={item.icon} size={14} />
            {item.label}
            <i className="cell-ring" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
