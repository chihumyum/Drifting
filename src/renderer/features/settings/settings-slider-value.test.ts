import { describe, expect, it } from 'vitest';
import {
  adjustSettingsSliderValue,
  formatSettingsSliderValue,
  normalizeSettingsSliderValue,
  parseSettingsSliderValue,
} from './settings-slider-value';

describe('editable settings slider values', () => {
  it.each(['', ' ', '-', '.', '1e', 'abc', 'NaN', 'Infinity', '1e309'])(
    'keeps incomplete or non-finite input %j out of preferences',
    (text) => expect(parseSettingsSliderValue(text)).toBeNull(),
  );

  it.each([['0', 0], ['1.50', 1.5], ['720', 720], [' 24 ', 24]])(
    'reads the complete numeric input %s',
    (text, expected) => expect(parseSettingsSliderValue(String(text))).toBe(expected),
  );

  it.each([
    { min: 12, max: 28, integer: true, increment: 1 },
    { min: 1, max: 2, increment: 0.01 },
    { min: 0, max: 2.5, increment: 0.01 },
    { min: 480, max: 1280, integer: true, increment: 1 },
    { min: 25, max: 75, integer: true, increment: 1 },
  ])('bounds typed values and fine arrow adjustments for $min–$max', (bounds) => {
    const { min, max, increment } = bounds;
    expect(normalizeSettingsSliderValue(-Number.MAX_VALUE, bounds)).toBe(min);
    expect(normalizeSettingsSliderValue(Number.MAX_VALUE, bounds)).toBe(max);
    expect(adjustSettingsSliderValue(min, -increment, bounds)).toBe(min);
    expect(adjustSettingsSliderValue(max, increment, bounds)).toBe(max);
    let value = min;
    const count = Math.round((max - min) / increment);
    for (let index = 1; index <= count; index += 1) {
      value = adjustSettingsSliderValue(value, increment, bounds);
      expect(value).toBe(Number((min + index * increment).toFixed(2)));
    }
    expect(value).toBe(max);
    for (let index = count - 1; index >= 0; index -= 1) {
      value = adjustSettingsSliderValue(value, -increment, bounds);
      expect(value).toBe(Number((min + index * increment).toFixed(2)));
    }
    expect(value).toBe(min);
  });

  it('preserves manual input between slider increments and beyond the default display precision', () => {
    expect(normalizeSettingsSliderValue(1.55, { min: 1, max: 2 })).toBe(1.55);
    expect(normalizeSettingsSliderValue(0.125, { min: 0, max: 2.5 })).toBe(0.125);
    expect(normalizeSettingsSliderValue(721, { min: 480, max: 1280, integer: true })).toBe(721);
    expect(formatSettingsSliderValue(1.555, 2)).toBe('1.555');
    expect(formatSettingsSliderValue(0.125, 2)).toBe('0.125');
    expect(formatSettingsSliderValue(1.5, 2)).toBe('1.50');
  });

  it('increments from the typed value without aligning to an increment grid', () => {
    expect(adjustSettingsSliderValue(1.55, 0.01, { min: 1, max: 2 })).toBe(1.56);
    expect(adjustSettingsSliderValue(0.125, 0.01, { min: 0, max: 2.5 })).toBe(0.135);
    expect(adjustSettingsSliderValue(0.135, -0.01, { min: 0, max: 2.5 })).toBe(0.125);
    expect(adjustSettingsSliderValue(721, 1, { min: 480, max: 1280, integer: true })).toBe(722);
  });

  it('keeps the existing integer preference types separate from decimal ratios', () => {
    expect(normalizeSettingsSliderValue(17.5, { min: 12, max: 28, integer: true })).toBe(17);
    expect(normalizeSettingsSliderValue(721.5, { min: 480, max: 1280, integer: true })).toBe(721);
  });
});
