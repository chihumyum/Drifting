// User-defined time-grid boundary on the BottomTimeline.
//
// A marker pins a free-form label (e.g. "1937", "卷 二") to a specific
// `start` position. The label is purely cosmetic on the axis; the
// `start` value is the same integer space BookNode.start uses, so a
// marker placed "at start=12" appears directly above the slot where a
// chapter with start=12 would sit.
//
// When at least two markers carry numeric labels, useTimelineMarkers
// exposes linear-interpolation helpers so callers can convert freely
// between `start` and the numeric time value — this is the future
// hook for things like "jump to year 1939" or "what year is this
// chapter?". The labels stay free-text so a project can mix in
// non-numeric markers like "卷 二".
export interface TimelineMarker {
  id: string;
  start: number;
  label: string;
  createdAt: string;
}
