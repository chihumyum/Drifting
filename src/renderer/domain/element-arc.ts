// Element Arc — the read-only「弧线透镜」. An element's cross-chapter development
// DERIVED from prose (NOT reconciled against an authored arc; see DESIGN.md for
// that future mode). Built by a deterministic distillation TREE — per-appearance
// LEAF extraction → segment DISTILL → top SYNTHESIZE → ArcMap — i.e. plain
// structured LLM calls wired by an orchestrator, not autonomous agents. The hard
// reasoning happens at the top over a small DISTILLED input, which is why it
// holds up on long multi-chapter elements. See lib/shadow/ELEMENT-ARC.md.

// Generic across element KINDS (character / object / location / org / concept), not
// character-only: state(状态), action(行为/发生之事), relation(关系/归属),
// significance(作用/意义), change(变化), other.
export type ArcSignal = 'state' | 'action' | 'relation' | 'significance' | 'change' | 'other';
export type ArcConfidence = 'low' | 'med' | 'high';
export type ArcAxis = 'narrativeOrder' | 'bookOrder';

// One appearance = the element's presence in one chapter, placed on the narrative
// axis. The work-list (which chapters, in what order) is built from inline-mention
// backlinks + node order — mentions miss pronoun-only appearances (known v1 limit).
export interface ArcAppearance {
  chapterId: string;
  chapterTitle: string;
  order: number; // narrativeOrder ?? bookOrder
  fromNarrative: boolean; // order came from narrativeOrder (vs bookOrder fallback)
}

// Provenance is CHAPTER-level (a claim's `order` → chapterId), NOT block-level: the
// LLM isn't agentic and can't verify block ids, and threading opaque ids layer by
// layer bloated the distill input and broke its JSON output. A claim is grounded at
// its chapter; the UI click-throughs there. (Reverted from an earlier block design.)

// ── Leaf (level 0): factual extraction for one appearance, no reasoning ──
export interface ArcObservation {
  text: string;
  signal: ArcSignal;
}
export interface ArcDivergence {
  note: string;
}
export interface ArcLeaf {
  chapterId: string;
  chapterTitle: string;
  order: number;
  oneLineState: string;
  observations: ArcObservation[];
  divergenceFromCanon: ArcDivergence[];
}

// ── Reduction node: a segment digest over a contiguous run of appearances ──
export interface ArcMotivation {
  claim: string;
  confidence: ArcConfidence; // motivation is the interpretive layer → always tagged
  orders: number[]; // chapters (narrative order) this is drawn from
}
// A dimension's movement across the segment. Dimensions are CHOSEN per element
// kind (character: 能力/关系/情绪/立场; object: 状态/归属/意义; location: 氛围/到场者/格局…),
// not a fixed character-only schema.
export interface ArcTrend {
  dimension: string;
  trend: string;
}
export interface ArcSegment {
  label: string;
  spanOrders: number[];
  chapterIds: string[];
  subArc: string;
  trends: ArcTrend[];
  motivations: ArcMotivation[];
}

// ── Top: the ArcMap ──
export interface ArcPoint {
  order: number;
  chapterId: string; // the chapter this point is anchored to (click-through target)
  label: string;
  state: string;
  motivation?: string;
  confidence: ArcConfidence;
}
export interface ArcTension {
  kind: 'contrast' | 'possible-drift' | 'uncommitted-evolution';
  note: string; // neutral surfacing ("ch20 vs ch8 — intended?"), never prescriptive
  orders: number[]; // the chapters this tension spans
  chapterIds: string[]; // resolved from orders (click-through)
}
// Overlay of the author's actual patches onto the blind-derived arc: did the
// derivation independently land on the beats the author committed? (Self-check.)
export interface ArcPatchMarker {
  atOrder: number;
  patchTitle: string;
  alignsWithDerived: boolean;
  note: string;
}
export interface ArcMap {
  elementId: string;
  elementName: string;
  axis: ArcAxis;
  narrative: string;
  points: ArcPoint[];
  tensions: ArcTension[];
  patchOverlay: ArcPatchMarker[];
  // appearances = chapters that contributed; skipped = appearances whose leaf
  // extraction failed (e.g. the model kept returning invalid JSON) and were
  // dropped so one bad chapter doesn't kill the whole derivation.
  coverage: { appearances: number; generatedAtOrder: number; skipped: number };
}

// An authored patch fed to the SYNTHESIZE step for overlay (the author's arc).
export interface ArcPatchInput {
  atOrder: number;
  title: string;
  body: string;
}

// ── Persisted job: one row per element (latest derivation), lives in `element_arc`,
// surfaced in the element editor's arc section (NOT the shadow task list). ──
export type ElementArcStatus = 'running' | 'done' | 'failed';

export interface ElementArcJob {
  id: string;
  projectId: string;
  elementId: string;
  status: ElementArcStatus;
  includeDrafts: boolean;
  result: ArcMap | null; // the derived ArcMap once status === 'done'
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
