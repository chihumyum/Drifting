import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAR_SEA_HANDOVER_MS, charSeaRegistry } from './char-sea-registry';

describe('the waits holding the sea', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('remembers when a wait began, through handovers from one wait to the next', () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    expect(charSeaRegistry.loadingSince()).toBeNull();

    const boot = charSeaRegistry.hold('loading');
    expect(charSeaRegistry.loadingSince()).toBe(1000);

    // The project boot lets go and the opening workspace takes hold a moment later.
    now = 1300;
    boot();
    expect(charSeaRegistry.loadingSince()).toBeNull();
    now = 1300 + CHAR_SEA_HANDOVER_MS - 10;
    const opening = charSeaRegistry.hold('loading');
    expect(charSeaRegistry.loadingSince()).toBe(1000);

    // A wait that starts after a real pause is a new one.
    now = 2000;
    opening();
    now = 2000 + CHAR_SEA_HANDOVER_MS + 10;
    const next = charSeaRegistry.hold('loading');
    expect(charSeaRegistry.loadingSince()).toBe(2000 + CHAR_SEA_HANDOVER_MS + 10);
    next();
  });

  it('counts a page in the rain apart from the waits', () => {
    const rain = charSeaRegistry.hold('rain');
    expect(charSeaRegistry.getHolds()).toEqual({ loading: 0, rain: 1, surfaces: 0 });
    expect(charSeaRegistry.loadingSince()).toBeNull();
    const shelf = charSeaRegistry.hold('surface');
    rain();
    rain();
    expect(charSeaRegistry.getHolds()).toEqual({ loading: 0, rain: 0, surfaces: 1 });
    shelf();
  });
});
