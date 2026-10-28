import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { springEasing } from '../topBars/TopTimeline/tab-reorder';

export interface GlassSliderOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

// The slider moves with the weight of the bottom timeline's glass clips: the
// same critically damped spring the dock's tabs use, over the same 520 ms.
const SLIDE_MS = 520;
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
 */
export function GlassSlider<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}: {
  options: readonly GlassSliderOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  // The first placement lands without motion; later changes slide.
  const [placed, setPlaced] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const place = () => {
      const chosen = [...track.querySelectorAll<HTMLElement>('[data-value]')].find(
        (option) => option.dataset.value === value,
      );
      if (chosen) setThumb({ x: chosen.offsetLeft, w: chosen.offsetWidth });
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
      className={`glass-slider${className ? ` ${className}` : ''}`}
      data-placed={placed ? 'true' : undefined}
      onKeyDown={handleKeyDown}
      style={
        {
          '--slider-x': `${thumb?.x ?? 0}px`,
          '--slider-w': `${thumb?.w ?? 0}px`,
          '--slider-ms': `${SLIDE_MS}ms`,
          '--slider-ease': slideEasing(),
        } as CSSProperties
      }
    >
      <i aria-hidden="true" className="glass-slider__thumb glass is-on" data-visible={thumb ? 'true' : undefined} />
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
    </div>
  );
}
