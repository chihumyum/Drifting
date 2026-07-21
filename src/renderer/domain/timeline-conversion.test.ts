import { describe, expect, it } from 'vitest';
import {
  buildTimelineConversion,
  convertOrderToTime,
  convertTimeToOrder,
} from './timeline-conversion';

describe('timeline numeric conversion', () => {
  it('interpolates and extrapolates between the widest marker pair', () => {
    const conversion = buildTimelineConversion([
      { narrativeOrder: 10, label: '1940 spring' },
      { narrativeOrder: 30, label: '1960' },
      { narrativeOrder: 20, label: '1950' },
    ]);
    expect(convertOrderToTime(conversion, 15)).toBe(1945);
    expect(convertTimeToOrder(conversion, 1970)).toBe(40);
  });

  it('keeps a constant forward mapping but rejects its ambiguous inverse', () => {
    const conversion = buildTimelineConversion([
      { narrativeOrder: 10, label: 'Year 1940' },
      { narrativeOrder: 30, label: '1940 again' },
    ]);
    expect(convertOrderToTime(conversion, 20)).toBe(1940);
    expect(convertTimeToOrder(conversion, 1940)).toBeNull();
  });

  it('rejects insufficient and non-finite inputs', () => {
    expect(buildTimelineConversion([{ narrativeOrder: 1, label: 'prologue' }])).toBeNull();
    const conversion = buildTimelineConversion([
      { narrativeOrder: 0, label: '0' },
      { narrativeOrder: 10, label: '10' },
    ]);
    expect(convertOrderToTime(conversion, Number.NaN)).toBeNull();
    expect(convertTimeToOrder(conversion, Number.POSITIVE_INFINITY)).toBeNull();
  });
});
