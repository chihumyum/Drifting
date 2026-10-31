import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  computeEntityHoverCardPosition,
  type EntityHoverCardPlacement,
  type EntityHoverCardPosition,
} from './entity-hover-card-position';
import { BrushIcon, type BrushIconName } from './BrushIcon';
import { KindMark } from './KindMark';
import type { KindMarkKind } from './kind-mark';
import { hoverCardSections, sectionTitle } from './hover-card-sections';

/** A row's mark: a sand brush icon for what it does, a kind mark for a kind of thing. */
export type HoverActionIcon =
  | { brush: BrushIconName }
  | { kind: KindMarkKind; color?: string; seed?: string; loose?: boolean };

/**
 * One thing that can be done to whatever a hover card describes. Drifting
 * has no right-click menus: what a menu used to offer lives in the rows
 * along the bottom of the card that shows when the pointer rests on the thing.
 */
export interface HoverAction {
  key: string;
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A choice already in effect (the current writing status, the current group). */
  active?: boolean;
  /** Leads the row and steps its words in. Left out on a row that opens more. */
  icon?: HoverActionIcon;
  /**
   * Several choices behind one cell (a group to move into…): a section of its
   * own under its own header, folded until the header is pressed.
   */
  choices?: HoverAction[];
  /** The choices may hold at once (a chapter's storylines): each is ticked instead of ringed. */
  multiple?: boolean;
  /** One of several that hold at once. */
  checked?: boolean;
  /** Keep the card open after choosing (toggles that are tried in place). */
  keepOpen?: boolean;
}

export interface HoverActionGroup {
  key: string;
  /** A fixed choice of one (writing status): its header, its choices always open. */
  label?: string;
  actions: HoverAction[];
}

export interface HoverCardPointerProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/** What the card's head says it is about: the thing's kind mark. */
export interface HoverCardMark {
  kind: KindMarkKind;
  color?: string;
  seed?: string;
  loose?: boolean;
}

/**
 * A floating card beside the thing under the pointer. The pointer may cross
 * into the card (the owner's hover state gives it a moment) so the rows
 * along its bottom can be used; choosing one closes the card.
 */
export function HoverCardShell({
  anchor,
  placement = 'right-start',
  width = 248,
  maxHeight = 720,
  label,
  pointer,
  actions,
  onDismiss,
  id,
  autoFocus = false,
  className = '',
  children,
}: {
  anchor: HTMLElement;
  placement?: EntityHoverCardPlacement;
  width?: number;
  maxHeight?: number;
  /** Accessible name of the card (usually the title of what it describes). */
  label?: string;
  /** From the owner's hover state; without it the card is a passive preview. */
  pointer?: HoverCardPointerProps;
  actions?: HoverActionGroup[];
  onDismiss?: () => void;
  /** Lets the anchor point at the card (`aria-describedby`). */
  id?: string;
  /** Opened from a ⋯ button: focus the first row, and hand focus back on close. */
  autoFocus?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<EntityHoverCardPosition | null>(null);
  const groups = (actions ?? []).filter((group) => group.actions.length > 0);
  const interactive = Boolean(pointer);

  const updatePosition = useCallback(() => {
    const card = cardRef.current;
    if (!card || !anchor.isConnected) {
      setPosition(null);
      return;
    }
    const next = computeEntityHoverCardPosition({
      anchor: anchor.getBoundingClientRect(),
      card: { width: card.offsetWidth, height: card.scrollHeight },
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      placement,
      maxHeight,
    });
    setPosition((current) =>
      current && current.top === next.top && current.left === next.left && current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [anchor, placement, maxHeight]);

  useLayoutEffect(() => {
    updatePosition();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updatePosition);
    if (cardRef.current) observer.observe(cardRef.current);
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [anchor, updatePosition]);

  // Scrolling the list the anchor sits in slides the anchor away from the
  // pointer: the card goes rather than riding along. Other scrolls (the
  // card's own body, another panel) only re-place it.
  const [scrolledAwayFrom, setScrolledAwayFrom] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const update = () => updatePosition();
    const onScroll = (event: Event) => {
      const scroller = event.target instanceof Node ? event.target : null;
      if (scroller && scroller !== cardRef.current && !cardRef.current?.contains(scroller) && scroller.contains(anchor)) {
        if (onDismiss) onDismiss();
        else setScrolledAwayFrom(anchor);
        return;
      }
      update();
    };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onDismiss, updatePosition]);

  // Wheeling over the anchor scrolls a long card instead of the list under it.
  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      const body = bodyRef.current;
      const targetNode = event.target instanceof Node ? event.target : null;
      if (!body || !targetNode || !anchor.contains(targetNode)) return;
      if (body.scrollHeight <= body.clientHeight) return;
      const canScroll = event.deltaY < 0
        ? body.scrollTop > 0
        : body.scrollTop + body.clientHeight < body.scrollHeight;
      if (!canScroll) return;
      event.preventDefault();
      event.stopPropagation();
      body.scrollTop += event.deltaY;
    };
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener('wheel', handleWheel, { capture: true });
  }, [anchor]);

  // Escape, or pressing anywhere but the card and its anchor, closes it.
  useEffect(() => {
    if (!interactive || !onDismiss) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // Claimed, so a layer behind the card (a super view's escape stack)
      // stays open.
      event.preventDefault();
      onDismiss();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (cardRef.current?.contains(target) || anchor.contains(target))) return;
      onDismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor, interactive, onDismiss]);

  // The card is portaled to the end of the page, out of the tab order: asked
  // for from the keyboard, it takes focus once it is placed (a hidden button
  // cannot be focused) and gives it back when it closes.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const card = cardRef.current;
    if (!autoFocus || !position || !card || returnFocusRef.current) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    card.querySelector<HTMLElement>('.hover-card__row:not(:disabled)')?.focus({ preventScroll: true });
  }, [autoFocus, position]);
  useLayoutEffect(() => {
    const card = cardRef.current;
    return () => {
      const previous = returnFocusRef.current;
      if (previous?.isConnected && card?.contains(document.activeElement)) previous.focus({ preventScroll: true });
    };
  }, []);

  // The card is portaled, but React still bubbles its events through the
  // owner's tree; a press on an action must not also click the row under it.
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  if (scrolledAwayFrom === anchor) return null;
  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role={interactive ? 'group' : 'tooltip'}
      aria-label={label}
      className={`hover-card hover-card-surface${interactive ? ' hover-card--interactive' : ''} ${className}`.trim()}
      onMouseEnter={pointer?.onMouseEnter}
      onMouseLeave={pointer?.onMouseLeave}
      onClick={stop}
      onDoubleClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        width,
        maxHeight: position?.maxHeight ?? maxHeight,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children != null && (
        <div ref={bodyRef} className="hover-card__body hover-preview-content">
          {children}
        </div>
      )}
      {groups.length > 0 && <HoverCardActions groups={groups} onDone={onDismiss} />}
    </div>,
    document.body,
  );
}

/**
 * The head of a hover card: the thing's kind mark and title on the left, a
 * count (words, chapters, items) on the right, and an optional line of what
 * it belongs to under them.
 */
export function HoverCardHeading({ title, mark, index, detail }: {
  title: ReactNode;
  mark?: HoverCardMark;
  index?: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <>
      <div className="hover-card__head">
        <span className="hover-card__title">
          {mark && <KindMark kind={mark.kind} color={mark.color} seed={mark.seed} loose={mark.loose} />}
          {title}
        </span>
        {index != null && index !== '' && <span className="hover-card__index">{index}</span>}
      </div>
      {detail != null && detail !== '' && <div className="hover-card__meta">{detail}</div>}
    </>
  );
}

/** The rows along the bottom of a hover card: what used to be its right-click menu. */
export function HoverCardActions({ groups, onDone }: { groups: HoverActionGroup[]; onDone?: () => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const choose = (action: HoverAction) => {
    if (action.disabled) return;
    action.onSelect?.();
    if (!action.keepOpen) onDone?.();
  };
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  return (
    <div className="hover-card__actions">
      {hoverCardSections(groups).map((section) => (
        <div key={section.key} className={`hover-card__section${section.type === 'folded' && open.has(section.key) ? ' is-open' : ''}`}>
          {section.type === 'plain' && section.actions.map((action) => (
            <HoverActionRow key={action.key} action={action} onChoose={() => choose(action)} />
          ))}
          {section.type === 'fixed' && (
            <Fragment>
              <div className="hover-card__section-label">{section.label}</div>
              {section.actions.map((action) => (
                <HoverActionRow key={action.key} action={action} choice onChoose={() => choose(action)} />
              ))}
            </Fragment>
          )}
          {section.type === 'folded' && (
            <Fragment>
              <button
                type="button"
                className="hover-card__section-head"
                aria-expanded={open.has(section.key)}
                disabled={section.action.disabled}
                onClick={() => toggle(section.key)}
              >
                {sectionTitle(section.action.label)}
                <BrushIcon name="chevron-down" size={12} className="hover-card__chevron" />
              </button>
              <div className="hover-card__fold">
                <div className="hover-card__fold-inner">
                  {(section.action.choices ?? []).map((choice) => (
                    <HoverActionRow
                      key={choice.key}
                      action={section.action.multiple ? { ...choice, keepOpen: choice.keepOpen ?? true } : choice}
                      choice
                      multiple={section.action.multiple}
                      tabbable={open.has(section.key)}
                      onChoose={() => choose(section.action.multiple ? { ...choice, keepOpen: choice.keepOpen ?? true } : choice)}
                    />
                  ))}
                </div>
              </div>
            </Fragment>
          )}
        </div>
      ))}
    </div>
  );
}

function HoverActionMark({ icon }: { icon: HoverActionIcon }) {
  if ('brush' in icon) return <BrushIcon name={icon.brush} className="hover-card__mark" />;
  return (
    <span className="hover-card__mark hover-card__mark--kind">
      <KindMark kind={icon.kind} color={icon.color} seed={icon.seed} loose={icon.loose} />
    </span>
  );
}

function HoverActionRow({ action, choice = false, multiple = false, tabbable = true, onChoose }: {
  action: HoverAction;
  /** One of a section's choices: the one in effect keeps its ring. */
  choice?: boolean;
  multiple?: boolean;
  tabbable?: boolean;
  onChoose: () => void;
}) {
  return (
    <HoverCardRow
      icon={action.icon}
      label={action.label}
      danger={action.danger}
      active={choice && !multiple ? Boolean(action.active) : undefined}
      checked={multiple ? Boolean(action.checked) : undefined}
      disabled={action.disabled}
      tabbable={tabbable}
      onClick={onChoose}
    />
  );
}

/**
 * One row of a card: its mark on the left edge, its words, and what stands at
 * its far end (a count, a tick). The rows of a card a press opens (a
 * relation, a companion, an island's own actions) are these rows too.
 */
export function HoverCardRow({ icon, label, aside, danger, active, checked, disabled, tabbable = true, onClick, children, ...rest }: {
  icon?: HoverActionIcon;
  label?: ReactNode;
  /** At the row's far end, in the quiet ink. */
  aside?: ReactNode;
  danger?: boolean;
  /** The choice in effect: its ring stands still. */
  active?: boolean;
  /** One of several that hold at once: ticked at the far end. */
  checked?: boolean;
  disabled?: boolean;
  tabbable?: boolean;
  onClick?: () => void;
  /** Laid out between the mark and the far end instead of a plain label. */
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'type' | 'className'>) {
  return (
    <button
      {...rest}
      type="button"
      className={[
        'hover-card__row',
        danger ? 'hover-card__row--danger' : '',
        active ? 'is-active' : '',
        checked ? 'is-checked' : '',
      ].filter(Boolean).join(' ')}
      disabled={disabled}
      tabIndex={tabbable ? undefined : -1}
      aria-pressed={active !== undefined ? Boolean(active) : checked !== undefined ? checked : undefined}
      onClick={onClick}
    >
      {icon && <HoverActionMark icon={icon} />}
      {children ?? <span className="hover-card__row-label">{label}</span>}
      {aside != null && aside !== '' && <span className="hover-card__row-aside">{aside}</span>}
      {checked !== undefined && <BrushIcon name="check" size={14} className="hover-card__tick" />}
    </button>
  );
}
