import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  computeEntityHoverCardPosition,
  type EntityHoverCardPlacement,
  type EntityHoverCardPosition,
} from './entity-hover-card-position';
import { BrushIcon } from './BrushIcon';

/**
 * One thing that can be done to whatever a hover card describes. Drifting
 * has no right-click menus: what a menu used to offer lives in the bottom
 * row of the card that shows when the pointer rests on the thing.
 */
export interface HoverAction {
  key: string;
  label: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** A choice already in effect (the current writing status, the checked option). */
  active?: boolean;
  /** Picking among these unfolds them as a row of their own (a group to move into…). */
  choices?: HoverAction[];
  /** Keep the card open after choosing (toggles that are tried in place). */
  keepOpen?: boolean;
}

export interface HoverActionGroup {
  key: string;
  /** A small caption before the group's buttons, for choice groups. */
  label?: string;
  actions: HoverAction[];
}

export interface HoverCardPointerProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * A floating card beside the thing under the pointer. The pointer may cross
 * into the card (the owner's hover state gives it a moment) so the actions
 * along its bottom can be used; choosing one closes the card.
 */
export function HoverCardShell({
  anchor,
  placement = 'right-start',
  width = 300,
  label,
  pointer,
  actions,
  onDismiss,
  className = '',
  children,
}: {
  anchor: HTMLElement;
  placement?: EntityHoverCardPlacement;
  width?: number;
  /** Accessible name of the card (usually the title of what it describes). */
  label?: string;
  /** From the owner's hover state; without it the card is a passive preview. */
  pointer?: HoverCardPointerProps;
  actions?: HoverActionGroup[];
  onDismiss?: () => void;
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
    });
    setPosition((current) =>
      current && current.top === next.top && current.left === next.left && current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [anchor, placement]);

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

  // The card is portaled, but React still bubbles its events through the
  // owner's tree; a press on an action must not also click the row under it.
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  if (scrolledAwayFrom === anchor) return null;
  return createPortal(
    <div
      ref={cardRef}
      role={interactive ? 'group' : 'tooltip'}
      aria-label={label}
      className={`hover-card${interactive ? ' hover-card--interactive' : ''} ${className}`.trim()}
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
        maxHeight: position?.maxHeight ?? 720,
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

/** Title and optional detail line at the top of a hover card's body. */
export function HoverCardHeading({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  return (
    <>
      <div className="hover-card__title">{title}</div>
      {detail != null && detail !== '' && <div className="hover-card__detail">{detail}</div>}
    </>
  );
}

/** The bottom row of a hover card: what used to be its right-click menu. */
export function HoverCardActions({ groups, onDone }: { groups: HoverActionGroup[]; onDone?: () => void }) {
  const [unfolded, setUnfolded] = useState<string | null>(null);
  const choose = (action: HoverAction) => {
    if (action.disabled) return;
    if (action.choices) {
      setUnfolded((current) => (current === action.key ? null : action.key));
      return;
    }
    action.onSelect?.();
    if (!action.keepOpen) onDone?.();
  };
  const open = groups.flatMap((group) => group.actions).find((action) => action.key === unfolded);
  return (
    <div className="hover-card__actions" role="toolbar" aria-orientation="horizontal">
      <div className="hover-card__action-row">
        {groups.map((group, index) => (
          <Fragment key={group.key}>
            {/* A captioned choice group (writing status…) keeps a line of its own. */}
            {index > 0 && (groups[index - 1].label || group.label
              ? <span className="hover-card__action-break" aria-hidden="true" />
              : <span className="hover-card__action-gap" aria-hidden="true" />)}
            {group.label && <span className="hover-card__action-label">{group.label}</span>}
            {group.actions.map((action) => (
              <HoverActionButton key={action.key} action={action}
                expanded={action.choices ? unfolded === action.key : undefined}
                onChoose={() => choose(action)} />
            ))}
          </Fragment>
        ))}
      </div>
      {open?.choices && (
        <div className="hover-card__action-row hover-card__action-row--choices">
          {open.choices.map((choice) => (
            <HoverActionButton key={choice.key} action={choice} onChoose={() => choose(choice)} />
          ))}
        </div>
      )}
    </div>
  );
}

function HoverActionButton({ action, expanded, onChoose }: {
  action: HoverAction;
  expanded?: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        'hover-card__action glass glass--surface',
        action.danger ? 'hover-card__action--danger' : '',
        action.active ? 'is-active' : '',
      ].filter(Boolean).join(' ')}
      disabled={action.disabled}
      aria-pressed={action.active === undefined ? undefined : action.active}
      aria-expanded={expanded}
      onClick={onChoose}
    >
      {action.label}
      {action.choices && <span className="hover-card__action-chevron" aria-hidden="true"><BrushIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={9} /></span>}
    </button>
  );
}
