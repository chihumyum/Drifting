import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Button';
import { formatAccelerator } from '../../lib/shortcuts';
import { useShortcutsStore } from '../../store/shortcuts-store';
import { resolveGuideTarget, type GuideTarget } from './guide-targets';
import { guideRingRect, placeGuideCard, type GuideRect } from './tour-geometry';
import type { GuideStep } from './workspace-tour';

/** While a step is up, how often it looks again for its control (a sidebar opened, a page changed). */
const GUIDE_FOLLOW_MS = 400;

const sameRect = (a: GuideRect, b: GuideRect) =>
  Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5
  && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/**
 * A guided tour: a ring of waiting glass around the control a step is about
 * and a card beside it, in the hover card's shell, with Back, Next and Skip.
 * A step whose control is put away points at what brings it out (a closed
 * sidebar's toggle) and moves onto the control once it shows; a step with
 * neither is passed over. Nothing else on the page is covered or dimmed, so
 * the author can use what the ring points at. Esc skips. `onDone` runs once,
 * whether the tour was finished or skipped.
 */
export function CoachTour({ steps, onDone }: { steps: readonly GuideStep[]; onDone: () => void }) {
  const { t } = useTranslation();
  const bindings = useShortcutsStore((state) => state.bindings);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [target, setTarget] = useState<GuideTarget | null>(null);
  const [cardSize, setCardSize] = useState<{ width: number; height: number } | null>(null);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const cardRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  }, [onDone]);

  const step = steps[index];

  // Find this step's control in the next frame, once layout has settled; one
  // that is not on screen hands over to the next step in the same direction.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!step) {
        finish();
        return;
      }
      const found = resolveGuideTarget(step);
      if (found) {
        setTarget(found);
        return;
      }
      const next = index + direction;
      if (next < 0) setDirection(1);
      else if (next >= steps.length) finish();
      else setIndex(next);
    });
    return () => cancelAnimationFrame(frame);
  }, [direction, finish, index, step, steps.length]);

  // Controls move with the window and come out when a sidebar opens: follow them.
  useEffect(() => {
    if (!step) return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setViewport((previous) =>
          previous.width === window.innerWidth && previous.height === window.innerHeight
            ? previous : { width: window.innerWidth, height: window.innerHeight });
        const found = resolveGuideTarget(step);
        if (!found) return;
        setTarget((previous) =>
          previous && previous.bodyKey === found.bodyKey && sameRect(previous.rect, found.rect) ? previous : found);
      });
    };
    window.addEventListener('resize', measure);
    const follow = window.setInterval(measure, GUIDE_FOLLOW_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.clearInterval(follow);
    };
  }, [step]);

  // The card's own size decides where it fits; it changes with each step's text.
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const setCardRef = useCallback((element: HTMLDivElement | null) => {
    cardRef.current = element;
    setCard(element);
  }, []);
  useEffect(() => {
    if (!card) return undefined;
    const measure = () => {
      const { width, height } = card.getBoundingClientRect();
      setCardSize((previous) =>
        previous && previous.width === width && previous.height === height ? previous : { width, height });
    };
    if (typeof ResizeObserver === 'undefined') {
      const frame = requestAnimationFrame(measure);
      return () => cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    return () => observer.disconnect();
  }, [card]);

  const ring = target ? guideRingRect(target.rect, viewport) : null;
  const place = ring && cardSize ? placeGuideCard(ring, cardSize, viewport) : null;
  const placed = place !== null;

  // Next takes the keyboard once the card is in place (a hidden card cannot
  // hold focus), so Return walks the tour.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!placed || !step || focused.current === step.id) return;
    focused.current = step.id;
    cardRef.current?.querySelector<HTMLButtonElement>('.ui-button--primary')?.focus({ preventScroll: true });
  }, [placed, step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish]);

  if (!step || !ring) return null;

  // Until this step's control is found the ring still holds the last one: say this step's words.
  const bodyKey = target && target.bodyKey === step.fallback?.bodyKey ? target.bodyKey : step.bodyKey;

  const shortcuts = (step.shortcuts ?? []).map((shortcut) =>
    formatAccelerator(typeof shortcut === 'string' ? bindings[shortcut] : shortcut.accelerator));
  const last = index === steps.length - 1;
  const go = (delta: 1 | -1) => {
    const next = index + delta;
    if (next >= steps.length) {
      finish();
      return;
    }
    setDirection(delta);
    setIndex(Math.max(0, next));
  };

  return createPortal(
    <>
      <div
        className="guide-ring glass glass--waiting"
        aria-hidden="true"
        style={{
          left: ring.left,
          top: ring.top,
          width: ring.width,
          height: ring.height,
          borderRadius: ring.radius,
        }}
      />
      <div
        ref={setCardRef}
        className="guide-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby="guide-card-title"
        data-placed={place ? 'true' : 'false'}
        style={place ? { left: place.left, top: place.top } : { left: ring.left, top: ring.top + ring.height + 10 }}
      >
        <div key={step.id} className="guide-card__body">
          <div className="guide-card__head">
            <span id="guide-card-title" className="guide-card__title">{t(step.titleKey)}</span>
            <span className="guide-card__count">{index + 1} / {steps.length}</span>
          </div>
          <p className="guide-card__text">{t(bodyKey)}</p>
          {shortcuts.length > 0 && (
            <div className="guide-card__shortcuts">
              {shortcuts.map((shortcut) => <span key={shortcut}>{shortcut}</span>)}
            </div>
          )}
        </div>
        <div className="guide-card__actions">
          <Button variant="ghost" size="sm" onClick={finish}>{t('guide.skip')}</Button>
          <span className="guide-card__spacer" />
          {index > 0 && <Button size="sm" onClick={() => go(-1)}>{t('guide.back')}</Button>}
          <Button variant="primary" size="sm" onClick={() => go(1)}>
            {last ? t('guide.done') : t('guide.next')}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}
