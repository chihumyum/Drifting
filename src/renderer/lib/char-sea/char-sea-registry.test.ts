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
    expect(charSeaRegistry.getHolds()).toEqual({ loading: 0, title: 0, rain: 1, surfaces: 0 });
    expect(charSeaRegistry.loadingSince()).toBeNull();
    const shelf = charSeaRegistry.hold('surface');
    rain();
    rain();
    expect(charSeaRegistry.getHolds()).toEqual({ loading: 0, title: 0, rain: 0, surfaces: 1 });
    shelf();
  });

  it('counts the name a first run raises apart from the waits', () => {
    const title = charSeaRegistry.hold('title');
    expect(charSeaRegistry.getHolds()).toEqual({ loading: 0, title: 1, rain: 0, surfaces: 0 });
    expect(charSeaRegistry.loadingSince()).toBeNull();
    title();
    expect(charSeaRegistry.getHolds()).toEqual({ loading: 0, title: 0, rain: 0, surfaces: 0 });
  });
});

describe('glass on the sea', () => {
  const element = () => ({ compareDocumentPosition: () => 0 }) as unknown as HTMLElement;

  it('changes a resting line and its waiting in place, keeping the glass it is', () => {
    const glass = element();
    let changes = 0;
    const stop = charSeaRegistry.onShapes(() => { changes += 1; });
    const remove = charSeaRegistry.addShape(glass, { rest: 0, radius: 2, arrive: true }, true);
    const [entry] = charSeaRegistry.shapes();
    expect(entry).toMatchObject({ options: { rest: 0, radius: 2, arrive: true }, waiting: true });

    charSeaRegistry.update(glass, { rest: 0.85, waiting: false });
    const [after] = charSeaRegistry.shapes();
    expect(after.id).toBe(entry.id);
    expect(after).toMatchObject({ options: { rest: 0.85, arrive: true }, waiting: false });
    // An update that changes nothing is not a change.
    const seen = changes;
    charSeaRegistry.update(glass, { rest: 0.85, waiting: false });
    expect(changes).toBe(seen);
    remove();
    stop();
  });

  it('hands a ring a page drops to whoever draws the sea', () => {
    const rings: number[][] = [];
    const stop = charSeaRegistry.onDrop((x, y, amplitude) => rings.push([x, y, amplitude]));
    charSeaRegistry.drop(300, 200, 1.1);
    charSeaRegistry.drop(10, 20);
    stop();
    charSeaRegistry.drop(1, 1);
    expect(rings).toEqual([[300, 200, 1.1], [10, 20, 1.2]]);
  });
});
