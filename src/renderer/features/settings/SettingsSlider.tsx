import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  adjustSettingsSliderValue,
  formatSettingsSliderValue,
  normalizeSettingsSliderValue,
  parseSettingsSliderValue,
  type SettingsSliderBounds,
} from './settings-slider-value';
import { BrushIcon } from '../../components/ui/BrushIcon';
import { SettingsRange } from './SettingsPrimitives';
import { settingsOnDesktop } from './settings-on-desktop';

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

  const numberInput = (className?: string) => (
    <input
      className={className}
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
  );
  const stepButton = (direction: 1 | -1, className: string, iconSize: number) => (
    <button
      type="button"
      className={className}
      aria-label={t(direction === 1 ? 'settings.increase_value' : 'settings.decrease_value', { label })}
      disabled={disabled || (direction === 1 ? current >= max : current <= min)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => adjust(direction)}
    >
      <BrushIcon name={direction === 1 ? 'chevron-up' : 'chevron-down'} size={iconSize} />
    </button>
  );

  // Desktop: the number slider and number field of components.md.
  if (settingsOnDesktop()) {
    return (
      <div className="set-slider">
        <SettingsRange
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          ariaLabel={numericLabel}
          onChange={apply}
        />
        <label
          className="ui-field ui-field--sm ui-field--mono ui-number glass glass--rest glass--field glass--small"
        >
          {numberInput()}
          {unit && <span className="ui-field__meta" aria-hidden="true">{unit}</span>}
          <span className="ui-number__steps">
            {stepButton(1, 'ui-number__step', 9)}
            {stepButton(-1, 'ui-number__step', 9)}
          </span>
        </label>
      </div>
    );
  }

  return (
    <div className="set-slider">
      <SettingsRange
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        ariaLabel={numericLabel}
        onChange={apply}
        style={{ width: 140 }}
      />
      <span className="set-slider__value">
        <span className="set-slider__number-control">
          {numberInput('set-input set-slider__number')}
          <span className="set-slider__steppers">
            {stepButton(1, 'set-slider__step', 12)}
            {stepButton(-1, 'set-slider__step', 12)}
          </span>
        </span>
        {unit && <span className="set-slider__unit" aria-hidden="true">{unit}</span>}
      </span>
    </div>
  );
}
