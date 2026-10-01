import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  adjustSettingsSliderValue,
  formatSettingsSliderValue,
  normalizeSettingsSliderValue,
  parseSettingsSliderValue,
  type SettingsSliderBounds,
} from './settings-slider-value';

export function SettingsSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  precision = 0,
  integer = false,
  unit,
  disabled = false,
}: SettingsSliderBounds & {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  precision?: number;
  unit?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ text: string; appliedValue: number } | null>(null);
  // A reset or external preference change supersedes an unfinished edit.
  const text = draft?.appliedValue === value ? draft.text : formatSettingsSliderValue(value, precision);
  const bounds = { min, max, integer };
  const increment = integer ? 1 : 0.01;
  const current = normalizeSettingsSliderValue(parseSettingsSliderValue(text) ?? value, bounds);
  const numericLabel = unit ? `${label} (${unit})` : label;
  const rangeHint = `${min}–${max}${unit ? ` ${unit}` : ''}`;

  const apply = (next: number) => {
    const normalized = normalizeSettingsSliderValue(next, bounds);
    setDraft(null);
    if (normalized !== value) onChange(normalized);
  };

  const commit = () => apply(parseSettingsSliderValue(text) ?? value);
  const adjust = (direction: 1 | -1) =>
    apply(adjustSettingsSliderValue(current, direction * increment, bounds));

  return (
    <div className="set-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={numericLabel}
        onChange={(event) => apply(Number(event.target.value))}
        style={{ width: 140 }}
      />
      <span className="set-slider__value">
        <span className="set-slider__number-control">
          <input
            className="set-input set-slider__number"
            type="number"
            inputMode={integer ? 'numeric' : 'decimal'}
            min={min}
            max={max}
            step="any"
            value={text}
            disabled={disabled}
            aria-label={numericLabel}
            title={rangeHint}
            onChange={(event) => {
              const nextText = event.target.value;
              const parsed = parseSettingsSliderValue(nextText);
              // Keep empty, partial and out-of-range input editable. Only valid
              // numbers reach the live preview and persisted preference state.
              const next = parsed !== null && parsed >= min && parsed <= max
                ? normalizeSettingsSliderValue(parsed, bounds)
                : value;
              setDraft({ text: nextText, appliedValue: next });
              if (next !== value) onChange(next);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                adjust(event.key === 'ArrowUp' ? 1 : -1);
              }
            }}
          />
          <span className="set-slider__steppers">
            <button
              type="button"
              className="set-slider__step"
              aria-label={t('settings.increase_value', { label })}
              disabled={disabled || current >= max}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => adjust(1)}
            >
              <ChevronUp size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="set-slider__step"
              aria-label={t('settings.decrease_value', { label })}
              disabled={disabled || current <= min}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => adjust(-1)}
            >
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          </span>
        </span>
        {unit && <span className="set-slider__unit" aria-hidden="true">{unit}</span>}
      </span>
    </div>
  );
}
