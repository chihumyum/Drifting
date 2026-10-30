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
import { OPTIONS_CLOSE_MS, SPRING_MS, weightedEasing } from '../../lib/motion';
import { AnchoredPopover } from './AnchoredPopover';
import { leaveSliderGlass, takeSliderGlass, type SliderGlassRect } from './glass-slider-handoff';

export interface GlassSliderOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

function optionValuesKey(options: readonly GlassSliderOption<string>[]): string {
  return options.map((option) => option.value).join('\u0000');
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
  /**
   * Shared by sliders that replace one another in one commit, like the view
   * switch each Super View draws in its own header: the new slider picks the
   * glass up where the old one left it and slides on to its own choice
   * (`glass-slider-handoff.ts`). Side by side only; collapsed ignores it.
   */
  handoff?: string;
  /**
   * How the glass travels to a new choice. By default the weighted spring;
   * a slider that switches what a push brings in (the Super View switch)
   * rides that push instead, so the glass lands with it, as the block under
   * a sidebar's panel tabs does.
   */
  travel?: { ms: number; easing: string };
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
  const optionsKey = optionValuesKey(props.options);
  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure || !onNaturalWidth) return undefined;
    const report = () => onNaturalWidth(measure.getBoundingClientRect().width);
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [collapsed, onNaturalWidth, optionsKey]);

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
  handoff,
  travel,
}: GlassSliderProps<T> & { measure?: ReactNode }) {
  const vertical = orientation === 'vertical';
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<SliderGlassRect | null>(null);
  // The first placement lands without motion; later changes slide.
  const [placed, setPlaced] = useState(false);
  // Where a slider this one replaced left its glass (`handoff`). It is drawn
  // there until the first placement, so that placement slides on from it.
  const [handedFrom, setHandedFrom] = useState<SliderGlassRect | null>(null);
  const shown = !placed && handedFrom ? handedFrom : thumb;
  // Callers often build `options` inline. Keying on their values keeps a
  // parent's unrelated re-render from forcing a synchronous layout here;
  // label and size changes reach the track through its ResizeObserver.
  const optionsKey = optionValuesKey(options);

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
  }, [value, optionsKey]);

  useEffect(() => {
    if (!thumb || placed) return undefined;
    const frame = window.requestAnimationFrame(() => setPlaced(true));
    return () => window.cancelAnimationFrame(frame);
  }, [thumb, placed]);

  // Like the block under the chosen panel tab, the slider's glass runs with
  // the distance it slides (--flow, lib/glass-flow.ts) and stops when it lands.
  const thumbRef = useRef<HTMLElement | null>(null);
  const slidFrom = useRef<number | null>(null);
  // Where the glass is drawn and when it last set off, for a handoff.
  const glassAt = useRef<{ rect: SliderGlassRect | null; setOff: number }>({ rect: null, setOff: -Infinity });
  useEffect(() => {
    const track = trackRef.current;
    const element = thumbRef.current;
    if (!shown || !track || !element) return;
    if (!track.style.getPropertyValue('--flow')) track.style.setProperty('--flow', '0');
    const at = vertical ? shown.y : shown.x;
    if (placed && slidFrom.current !== null && slidFrom.current !== at) {
      glassAt.current.setOff = performance.now();
      trackGlassFlow(track, () => (vertical ? element.getBoundingClientRect().top : element.getBoundingClientRect().left));
    }
    slidFrom.current = at;
    glassAt.current.rect = shown;
  }, [shown, placed, vertical]);

  // Hand the glass over between sliders that replace one another. Only one
  // still mid-slide is measured; at rest it is where it was last drawn.
  const tookHandoff = useRef(false);
  // How long a slide takes, read when this slider leaves its glass behind.
  const travelMs = useRef(SPRING_MS);
  useLayoutEffect(() => {
    travelMs.current = travel?.ms ?? SPRING_MS;
  });
  useLayoutEffect(() => {
    const track = trackRef.current;
    const element = thumbRef.current;
    const drawn = glassAt.current;
    if (!handoff || !track || !element) return undefined;
    // Like a measurement, this is read in the commit that replaced the old
    // slider and drawn before paint; only the first run may take it.
    const pickUp = () => {
      const handed = takeSliderGlass(handoff);
      if (handed) setHandedFrom(handed);
    };
    if (!tookHandoff.current) {
      tookHandoff.current = true;
      pickUp();
    }
    return () => {
      const { rect, setOff } = drawn;
      if (!rect) return;
      if (performance.now() - setOff >= travelMs.current) {
        leaveSliderGlass(handoff, rect);
        return;
      }
      const from = track.getBoundingClientRect();
      const glass = element.getBoundingClientRect();
      leaveSliderGlass(handoff, { x: glass.left - from.left, y: glass.top - from.top, w: glass.width, h: glass.height });
    };
  }, [handoff]);

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
          '--slider-x': `${shown?.x ?? 0}px`,
          '--slider-y': `${shown?.y ?? 0}px`,
          '--slider-w': `${shown?.w ?? 0}px`,
          '--slider-h': `${shown?.h ?? 0}px`,
          // The weight of the bottom timeline's glass clips: the weighted
          // spring the dock's tabs use (lib/motion.ts).
          '--slider-ms': `${travel?.ms ?? SPRING_MS}ms`,
          '--slider-ease': travel?.easing ?? weightedEasing(),
        } as CSSProperties
      }
    >
      <i ref={thumbRef} aria-hidden="true" className="glass-slider__thumb glass is-on" data-visible={shown ? 'true' : undefined} />
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
    closeTimer.current = setTimeout(() => setOpen(false), OPTIONS_CLOSE_MS);
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
