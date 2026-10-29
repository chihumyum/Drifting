import type { CSSProperties } from 'react';

/**
 * A number chosen along a track (a font size, a delay, a zoom). The track is
 * a hairline with an ink line for the part already travelled; the knob is
 * the Switch's thumb, and a round glass halo comes up round it under the
 * pointer (ui-controls.css `.ui-range`). An unseen native range input on top
 * keeps the pointer, keyboard and assistive behaviour of the system slider.
 */
export function GlassRange({
  value,
  min,
  max,
  step = 1,
  onChange,
  ariaLabel,
  disabled = false,
  wide = false,
  id,
  className = '',
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Fill the row instead of a fixed 150px. */
  wide?: boolean;
  id?: string;
  className?: string;
}) {
  const progress = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return (
    <span
      className={['ui-range', wide ? 'ui-range--wide' : '', disabled ? 'is-disabled' : '', className]
        .filter(Boolean)
        .join(' ')}
      style={{ '--range-p': progress } as CSSProperties}
    >
      <span className="ui-range__track" aria-hidden="true" />
      <span className="ui-range__fill" aria-hidden="true" />
      <span className="ui-range__halo glass glass--round" aria-hidden="true" />
      <span className="ui-range__knob" aria-hidden="true" />
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </span>
  );
}
