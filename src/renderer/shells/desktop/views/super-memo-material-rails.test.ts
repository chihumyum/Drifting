import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SMM_RAIL_DEFAULTS,
  SMM_RAIL_MIN,
  dragRailWidth,
  readRailWidths,
  storeRailWidths,
} from './super-memo-material-rails';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    items,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TODO & Materials rail widths', () => {
  it('follows the pointer between one card and what the library leaves', () => {
    expect(dragRailWidth(280, 120.4, 900)).toBe(400);
    expect(dragRailWidth(280, -200, 900)).toBe(SMM_RAIL_MIN);
    expect(dragRailWidth(280, 1000, 620)).toBe(620);
  });

  it('keeps one card wide even when the split has no room to give', () => {
    expect(dragRailWidth(280, 200, 100)).toBe(SMM_RAIL_MIN);
    expect(dragRailWidth(300, 0, -50)).toBe(SMM_RAIL_MIN);
  });

  it('remembers both widths on this machine', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(readRailWidths()).toEqual(SMM_RAIL_DEFAULTS);
    storeRailWidths({ todo: 520, comment: 300 });
    expect(readRailWidths()).toEqual({ todo: 520, comment: 300 });
  });

  it('falls back per rail on missing, damaged or too narrow values', () => {
    vi.stubGlobal('localStorage', memoryStorage({
      'super-memo-material:rail-widths': JSON.stringify({ todo: 'wide', comment: 90 }),
    }));
    expect(readRailWidths()).toEqual({ todo: SMM_RAIL_DEFAULTS.todo, comment: SMM_RAIL_MIN });

    vi.stubGlobal('localStorage', memoryStorage({ 'super-memo-material:rail-widths': '{' }));
    expect(readRailWidths()).toEqual(SMM_RAIL_DEFAULTS);
  });

  it('works without storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(readRailWidths()).toEqual(SMM_RAIL_DEFAULTS);
    expect(() => storeRailWidths({ todo: 300, comment: 300 })).not.toThrow();
  });
});
