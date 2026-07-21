export interface TimelineConversionMarker {
  narrativeOrder: number;
  label: string;
}

export interface TimelineConversion {
  a: { order: number; time: number };
  b: { order: number; time: number };
}

function parseNumeric(label: string): number | null {
  // Extract the first signed-decimal token so labels such as "1938 春" can
  // still participate in interpolation.
  const match = /-?\d+(?:\.\d+)?/.exec(label);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function buildTimelineConversion(
  markers: readonly TimelineConversionMarker[],
): TimelineConversion | null {
  const numeric = markers
    .map((marker) => ({ order: marker.narrativeOrder, time: parseNumeric(marker.label) }))
    .filter(
      (marker): marker is { order: number; time: number } =>
        Number.isFinite(marker.order) && marker.time !== null,
    )
    .sort((a, b) => a.order - b.order);
  if (numeric.length < 2) return null;
  const a = numeric[0]!;
  const b = numeric[numeric.length - 1]!;
  return a.order === b.order ? null : { a, b };
}

export function convertOrderToTime(
  conversion: TimelineConversion | null,
  order: number,
): number | null {
  if (!conversion || !Number.isFinite(order)) return null;
  const { a, b } = conversion;
  const result = a.time + (order - a.order) * ((b.time - a.time) / (b.order - a.order));
  return Number.isFinite(result) ? result : null;
}

export function convertTimeToOrder(
  conversion: TimelineConversion | null,
  time: number,
): number | null {
  if (!conversion || !Number.isFinite(time)) return null;
  const { a, b } = conversion;
  // Equal numeric labels define a constant forward mapping. Its inverse is
  // ambiguous, so return no position instead of NaN/Infinity.
  if (a.time === b.time) return null;
  const result = a.order + (time - a.time) * ((b.order - a.order) / (b.time - a.time));
  return Number.isFinite(result) ? result : null;
}
