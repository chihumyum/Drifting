// User-defined time-grid boundary on the narrative timeline.
//
// A marker pins a free-form label (e.g. "1937", "卷 二") to a specific
// `narrativeOrder` position. The label is purely cosmetic on the axis;
// `narrativeOrder` shares the same integer space as BookNode.narrativeOrder,
// so a marker placed at narrativeOrder=12 appears directly above the slot
// where a chapter with narrativeOrder=12 would sit.
//
// When at least two markers carry numeric labels, useTimelineMarkers exposes
// linear-interpolation helpers so callers can convert freely between
// `narrativeOrder` and the numeric time value — the hook for things like
// "jump to year 1939" or "what year is this chapter?". Labels stay free-text
// so projects can mix non-numeric markers like "卷 二".
export interface TimelineMarker {
  id: string;
  narrativeOrder: number;
  label: string;
  createdAt: string;
}
