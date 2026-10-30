/**
 * One glass slider can replace another in a single commit: each of the three
 * Super Views draws its own header, so switching views unmounts one view
 * switch and mounts the next. Sliders that stand for the same control share a
 * handoff key (`GlassSlider`'s `handoff`). The one leaving leaves where its
 * glass is; the one arriving picks the glass up there and slides on to its own
 * choice, instead of landing still under it.
 *
 * What a slider leaves is only good for the commit that unmounted it: React
 * runs the old slider's layout cleanup and the new one's layout effect in the
 * same synchronous commit, before any microtask. A slider mounted later (the
 * Super View closed and opened again) finds nothing and lands still, as every
 * first placement does.
 */
export interface SliderGlassRect {
  /** Offset of the glass from the slider's track, in CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const left = new Map<string, SliderGlassRect>();

/** Leave the glass of a slider that is unmounting, for one that replaces it. */
export function leaveSliderGlass(key: string, rect: SliderGlassRect): void {
  left.set(key, rect);
  queueMicrotask(() => {
    if (left.get(key) === rect) left.delete(key);
  });
}

/** Take the glass a replaced slider left under `key` in this commit, if any. */
export function takeSliderGlass(key: string): SliderGlassRect | undefined {
  const rect = left.get(key);
  left.delete(key);
  return rect;
}
