import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { trackGlassFlow } from '../../lib/glass-flow';
import { springEasing } from '../topBars/TopTimeline/tab-reorder';
import { AnchoredPopover } from './AnchoredPopover';

export interface GlassSliderOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

interface GlassSliderProps<T extends string> {
  options: readonly GlassSliderOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  /** Stack the options top to bottom; the slider then slides vertically. */
  orientation?: 'horizontal' | 'vertical';
  /** Show only the chosen option; the rest open, stacked, under the pointer. */
  collapsed?: boolean;
  /** Reports the width the options need side by side, collapsed or not. */
  onNaturalWidth?: (width: number) => void;
}

// The slider moves with the weight of the bottom timeline's glass clips: the
// same critically damped spring the dock's tabs use, over the same 520 ms.
const SLIDE_MS = 520;
// Long enough to cross the gap between the collapsed tab and its options.
const HOVER_CLOSE_MS = 160;
let slideEase: string | null = null;
function slideEasing() {
  if (slideEase === null) {
    const linear = springEasing();
    slideEase = typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', linear)
      ? linear
      : 'cubic-bezier(0.25, 1, 0.5, 1)';
  }
  return slideEase;
}

/**
 * One choice out of several, set side by side on a flat track: a single glass
 * slider sits under the chosen option and slides, with weight, to the next.
 * Only the slider is glass; the options are plain words. Two-state switches
 * (this chapter vs the whole project) use `ScopeToggle` instead.
 *
 * Where the options don't fit, `collapsed` folds them into the chosen one
 * alone; hovering it opens all of them stacked, on the same weighted slider.
 * Choosing slides the glass there and leaves them open, so the slab is seen
 * to move; they close once the pointer leaves.
 */
export function GlassSlider<T extends string>({
  collapsed = false,
  onNaturalWidth,
  ...props
}: GlassSliderProps<T>) {
  // A hidden copy of the options measures their natural width in either state,
  // so a collapsed slider can tell when there is room to open out again.
  const measureRef = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure || !onNaturalWidth) return undefined;
    const report = () => onNaturalWidth(measure.getBoundingClientRect().width);
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [collapsed, onNaturalWidth, props.options]);

  const measure = onNaturalWidth ? (
    <span ref={measureRef} aria-hidden="true" className="glass-slider__measure">
      {props.options.map((option) => (
        <span key={option.value} className="glass-slider__option">{option.label}</span>
      ))}
    </span>
  ) : null;

  return collapsed
    ? <CollapsedGlassSlider {...props} measure={measure} />
    : <GlassSliderTrack {...props} measure={measure} />;
}

function GlassSliderTrack<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
  orientation = 'horizontal',
  measure,
}: GlassSliderProps<T> & { measure?: ReactNode }) {
  const vertical = orientation === 'vertical';
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // The first placement lands without motion; later changes slide.
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const place = () => {
      const chosen = [...track.querySelectorAll<HTMLElement>('[data-value]')].find(
        (option) => option.dataset.value === value,
      );
      if (chosen) {
        setThumb({ x: chosen.offsetLeft, y: chosen.offsetTop, w: chosen.offsetWidth, h: chosen.offsetHeight });
      }
    };
    place();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(track);
    return () => observer.disconnect();
  }, [value, options]);

  useEffect(() => {
    if (!thumb || placed) return undefined;
    const frame = window.requestAnimationFrame(() => setPlaced(true));
    return () => window.cancelAnimationFrame(frame);
  }, [thumb, placed]);

  // Like the block under the chosen panel tab, the slider's glass runs with
  // the distance it slides (--flow, lib/glass-flow.ts) and stops when it lands.
  const thumbRef = useRef<HTMLElement | null>(null);
  const slidFrom = useRef<number | null>(null);
  useEffect(() => {
    const track = trackRef.current;
    const element = thumbRef.current;
    if (!thumb || !track || !element) return;
    if (!track.style.getPropertyValue('--flow')) track.style.setProperty('--flow', '0');
    const at = vertical ? thumb.y : thumb.x;
    if (placed && slidFrom.current !== null && slidFrom.current !== at) {
      trackGlassFlow(track, () => (vertical ? element.getBoundingClientRect().top : element.getBoundingClientRect().left));
    }
    slidFrom.current = at;
  }, [thumb, placed, vertical]);

  const choose = (index: number) => {
    const next = options[(index + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    trackRef.current?.querySelector<HTMLElement>(`[data-index="${(index + options.length) % options.length}"]`)?.focus();
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    const current = options.findIndex((option) => option.value === value);
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') choose(current + 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') choose(current - 1);
    else if (event.key === 'Home') choose(0);
    else if (event.key === 'End') choose(options.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-orientation={vertical ? 'vertical' : undefined}
      className={`glass-slider${vertical ? ' glass-slider--vertical' : ''}${className ? ` ${className}` : ''}`}
      data-placed={placed ? 'true' : undefined}
      onKeyDown={handleKeyDown}
      style={
        {
          '--slider-x': `${thumb?.x ?? 0}px`,
          '--slider-y': `${thumb?.y ?? 0}px`,
          '--slider-w': `${thumb?.w ?? 0}px`,
          '--slider-h': `${thumb?.h ?? 0}px`,
          '--slider-ms': `${SLIDE_MS}ms`,
          '--slider-ease': slideEasing(),
        } as CSSProperties
      }
    >
      <i ref={thumbRef} aria-hidden="true" className="glass-slider__thumb glass is-on" data-visible={thumb ? 'true' : undefined} />
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          data-value={option.value}
          data-index={index}
          className="glass-slider__option"
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
      {measure}
    </div>
  );
}

function CollapsedGlassSlider<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
  measure,
}: GlassSliderProps<T> & { measure?: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const show = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };
  const close = () => {
    clearTimeout(closeTimer.current);
    setOpen(false);
  };

  const current = Math.max(0, options.findIndex((option) => option.value === value));
  const chosen = options[current];
  // Arrow keys still step through the choices without opening them.
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = options[(current + step + options.length) % options.length];
    if (next) onChange(next.value);
  };

  return (
    <>
      <div
        ref={anchorRef}
        role="group"
        aria-label={ariaLabel}
        className={`glass-slider glass-slider--collapsed${className ? ` ${className}` : ''}`}
        onPointerEnter={show}
        onPointerLeave={hideSoon}
        // The one option left is the chosen one, so the glass fills the tab.
        style={
          {
            '--slider-x': '0px',
            '--slider-y': '0px',
            '--slider-w': '100%',
            '--slider-h': '100%',
          } as CSSProperties
        }
      >
        <i aria-hidden="true" className="glass-slider__thumb glass is-on" data-visible="true" />
        <button
          type="button"
          className="glass-slider__option"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={chosen?.title}
          onClick={() => (open ? close() : show())}
          onKeyDown={handleKeyDown}
        >
          {chosen?.label}
        </button>
        {measure}
      </div>
      <AnchoredPopover
        anchorRef={anchorRef}
        open={open}
        onClose={close}
        placement="bottom-start"
        offset={2}
        role="dialog"
        ariaLabel={ariaLabel}
        className="menu-surface menu-surface--rich glass-slider-popover"
        autoFocus={false}
        restoreFocus={false}
      >
        <div onPointerEnter={show} onPointerLeave={hideSoon}>
          <GlassSliderTrack
            options={options}
            value={value}
            ariaLabel={ariaLabel}
            orientation="vertical"
            onChange={onChange}
          />
        </div>
      </AnchoredPopover>
    </>
  );
}
