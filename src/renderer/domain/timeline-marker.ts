// User-defined time-grid marker on the narrative timeline.
//
// A marker pins a free-form label (e.g. "1937", "卷 二") to a specific
// `narrativeOrder` position. The label is purely cosmetic on the axis;
// `narrativeOrder` shares the same number space as BookNode.narrativeOrder,
// so a marker placed at narrativeOrder=12 appears directly above the slot
// where a chapter with narrativeOrder=12 would sit.
//
// A marker can optionally BIND a drift node (`driftNodeId`): the drift
// becomes the marker's content — its title labels the pin, clicking the pin
// opens the drift's editor, and the whole prose/agent/snapshot stack comes
// for free. Bound drifts are filtered OUT of the drift panel; "is bound" is
// always DERIVED from this column (single source of truth — there is no
// persisted status flag on the drift itself, so deleting a marker puts the
// drift straight back in the panel). Unbinding copies the drift's title into
// `label` so the pin keeps a meaningful caption. SQLite FKs aren't enforced
// in this app (no PRAGMA foreign_keys), so drift delete / drift→chapter
// conversion must unbind explicitly — see unbindMarkersForDrift in
// hooks/useTimelineMarkers.ts.
//
// When at least two markers carry numeric labels, useTimelineMarkers exposes
// linear-interpolation helpers so callers can convert freely between
// `narrativeOrder` and the numeric time value — the hook for things like
// "jump to year 1939" or "what year is this chapter?". Labels stay free-text
// so projects can mix non-numeric markers like "卷 二".
//
// Markers were localStorage-only until 2026-06; they're a synced table now
// because drift binding is a cross-device fact (the drift itself syncs, so
// its bound/unbound state must too). One-time legacy import lives in
// hooks/useTimelineMarkers.ts.
export interface TimelineMarker {
  id: string;
  projectId: string;
  narrativeOrder: number;
  label: string;
  driftNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}
