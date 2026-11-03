// 要素全景's second layout, 关系 (docs/design-system/components.md, 要素全景):
// beside the fixed category islands the elements can be laid out by their
// relations. A d3-force simulation pulls related elements together and keeps
// every element apart; the run is deterministic for a given start, so the
// same run played frame by frame and computed at once end in the same place
// (reduced motion shows that end straight away). An element the author drags
// stays where it is put (a pin) and the rest settle around it.

import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Force,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export interface RelatePoint { x: number; y: number }

export interface RelateNodeInput {
  id: string;
  name: string;
  /** Where the element's island puts it, world px. */
  anchor: RelatePoint;
}

/** A relation the author drew, or two elements mentioned in one paragraph. */
export interface RelateSpring {
  a: string;
  b: string;
  kind: 'relation' | 'prose';
  /** Relations: the role names written on the line, both ends or the one in the middle. */
  roles?: readonly string[];
  /** Prose: in how many paragraphs. */
  count?: number;
}

export interface RelateSimNode extends SimulationNodeDatum {
  id: string;
  hw: number;
  hh: number;
  ax: number;
  ay: number;
  degree: number;
}

interface RelateSimLink extends SimulationLinkDatum<RelateSimNode> {
  rest: number;
  strength: number;
}

export type RelateSimulation = Simulation<RelateSimNode, RelateSimLink>;

// A cell in the 关系 layout is the island's sand cell without its fixed
// width: mark and name, centred on its point. Its size comes from the
// characters, not a font measurement, so a layout is the same before and
// after the web fonts arrive.
const CELL_PAD_X = 8;
const CELL_MARK = 12;
const CELL_GAP = 5;
const CELL_FONT = 12;
export const RELATE_CELL_MAX_W = 160;
export const RELATE_CELL_H = 26;
export const RELATE_ROLE_FONT = 11.5;

export function textWidth(text: string, px: number): number {
  let width = 0;
  for (const character of text) width += character.charCodeAt(0) > 0x2e7f ? px : px * 0.56;
  return width;
}

export function relateCellHalf(name: string): { hw: number; hh: number } {
  const width = Math.min(RELATE_CELL_MAX_W, CELL_PAD_X * 2 + CELL_MARK + CELL_GAP + textWidth(name, CELL_FONT));
  return { hw: width / 2, hh: RELATE_CELL_H / 2 };
}

/** The knockout a role name sits in on its line. */
export function relateRoleHalf(text: string): { hw: number; hh: number } {
  return { hw: (textWidth(text, RELATE_ROLE_FONT) + 8) / 2, hh: 8 };
}

// One run cools in RELATE_TICKS ticks; two regimes, a book's worth of
// elements and a few hundred.
export const RELATE_ALPHA_MIN = 0.002;
export const RELATE_TICKS = 90;
const ALPHA_DECAY = 1 - Math.pow(RELATE_ALPHA_MIN, 1 / RELATE_TICKS);
const VELOCITY_DECAY = 0.42;
const COLLIDE_MARGIN = { x: 12, y: 8 };
const COLLIDE_OUTRIGHT_ALPHA = 0.06;
const HUB_ROOM = 14;
const CELL_ROOM = 2.5;
interface RelateForces { charge: number; reach: number; anchor: number; area: number }
const FORCES_SMALL: RelateForces = { charge: -320, reach: 640, anchor: 0.03, area: 0.9 };
const FORCES_LARGE: RelateForces = { charge: -130, reach: 420, anchor: 0.06, area: 0.22 };
const LARGE_BOOK = 100;
/** Dragging warms the layout to this, so the neighbours follow the hand. */
export const RELATE_DRAG_ALPHA = 0.3;

function forcesFor(count: number): RelateForces {
  return count > LARGE_BOOK ? FORCES_LARGE : FORCES_SMALL;
}

/**
 * Each element is held, weakly, near its island's place on a small map of
 * the islands redrawn to the window's proportions: the categories keep their
 * directions without the islands' long rows, and an element with no
 * relations rests near its own category.
 */
export function relateAnchors(nodes: readonly RelateNodeInput[], aspect: number): Map<string, RelatePoint> {
  const out = new Map<string, RelatePoint>();
  if (nodes.length === 0) return out;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.anchor.x); maxX = Math.max(maxX, node.anchor.x);
    minY = Math.min(minY, node.anchor.y); maxY = Math.max(maxY, node.anchor.y);
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  // Never smaller than the room the cells themselves need, with space for lines between them.
  let cells = 0;
  for (const node of nodes) {
    const half = relateCellHalf(node.name);
    cells += (half.hw * 2 + COLLIDE_MARGIN.x) * (half.hh * 2 + COLLIDE_MARGIN.y);
  }
  const area = Math.max(width * height * forcesFor(nodes.length).area, cells * CELL_ROOM);
  const sx = Math.sqrt(area * aspect) / width;
  const sy = Math.sqrt(area / aspect) / height;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const node of nodes) out.set(node.id, { x: cx + (node.anchor.x - cx) * sx, y: cy + (node.anchor.y - cy) * sy });
  return out;
}

/**
 * Cells are wide and short: they collide as boxes, pushed apart along the
 * axis that overlaps least. While the layout is warm the push goes into the
 * cells' velocities, as d3's own collision does; once it has nearly cooled
 * it moves them outright, a few passes a tick, so a crowded hub still comes
 * to rest with every cell clear. A pinned cell never moves; the other one
 * takes the whole push.
 */
function forceRectCollide(): Force<RelateSimNode, RelateSimLink> {
  let nodes: RelateSimNode[] = [];
  const pass = (outright: boolean) => {
    let maxW = 0;
    let maxH = 0;
    for (const node of nodes) { maxW = Math.max(maxW, node.hw); maxH = Math.max(maxH, node.hh); }
    const cellW = maxW * 2 + COLLIDE_MARGIN.x;
    const cellH = maxH * 2 + COLLIDE_MARGIN.y;
    const buckets = new Map<number, RelateSimNode[]>();
    const keyOf = (gx: number, gy: number) => (gx + 32768) * 65536 + (gy + 32768);
    // Where each cell lands this tick: d3 moves it by what is left of its velocity.
    const nextX = (node: RelateSimNode) => node.x! + node.vx! * (1 - VELOCITY_DECAY);
    const nextY = (node: RelateSimNode) => node.y! + node.vy! * (1 - VELOCITY_DECAY);
    for (const node of nodes) {
      const key = keyOf(Math.floor(nextX(node) / cellW), Math.floor(nextY(node) / cellH));
      const bucket = buckets.get(key);
      if (bucket) bucket.push(node); else buckets.set(key, [node]);
    }
    for (const p of nodes) {
      const gx = Math.floor(nextX(p) / cellW);
      const gy = Math.floor(nextY(p) / cellH);
      for (let ix = gx - 1; ix <= gx + 1; ix += 1) {
        for (let iy = gy - 1; iy <= gy + 1; iy += 1) {
          const bucket = buckets.get(keyOf(ix, iy));
          if (!bucket) continue;
          for (const q of bucket) {
            if (q.index! <= p.index!) continue;
            const wp = p.fx == null ? 1 : 0;
            const wq = q.fx == null ? 1 : 0;
            if (wp + wq === 0) continue;
            const dx = nextX(q) - nextX(p);
            const dy = nextY(q) - nextY(p);
            const ox = p.hw + q.hw + COLLIDE_MARGIN.x - Math.abs(dx);
            if (ox <= 0) continue;
            const oy = p.hh + q.hh + COLLIDE_MARGIN.y - Math.abs(dy);
            if (oy <= 0) continue;
            const alongX = ox < oy;
            const sign = (alongX ? dx : dy) < 0 ? -1 : 1;
            const push = ((alongX ? ox : oy) / (wp + wq)) * sign * (outright ? 1 : 0.5);
            if (alongX) {
              if (outright) { p.x! -= push * wp; q.x! += push * wq; } else { p.vx! -= push * wp; q.vx! += push * wq; }
            } else if (outright) { p.y! -= push * wp; q.y! += push * wq; } else { p.vy! -= push * wp; q.vy! += push * wq; }
          }
        }
      }
    }
  };
  const force = (alpha: number) => {
    const outright = alpha < COLLIDE_OUTRIGHT_ALPHA;
    for (let i = 0; i < (outright ? 4 : 2); i += 1) pass(outright);
  };
  force.initialize = (next: RelateSimNode[]) => { nodes = next; };
  return force;
}

function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

export interface RelateSimulationInput {
  nodes: readonly RelateNodeInput[];
  springs: readonly RelateSpring[];
  /** Where each element starts; one without falls back to its anchor. */
  start: ReadonlyMap<string, RelatePoint>;
  pins: ReadonlyMap<string, RelatePoint>;
  /** The window's width over its height, for the map of anchors. */
  aspect: number;
  alpha: number;
}

/** A stopped simulation; tick it by hand (`tick()` per frame, or `settleRelate`). */
export function createRelateSimulation(input: RelateSimulationInput): RelateSimulation {
  const forces = forcesFor(input.nodes.length);
  const anchors = relateAnchors(input.nodes, input.aspect);
  const nodes: RelateSimNode[] = input.nodes.map((node) => {
    const start = input.pins.get(node.id) ?? input.start.get(node.id) ?? node.anchor;
    const pin = input.pins.get(node.id);
    const anchor = anchors.get(node.id) ?? node.anchor;
    const half = relateCellHalf(node.name);
    return {
      id: node.id, x: start.x, y: start.y, vx: 0, vy: 0,
      fx: pin ? pin.x : null, fy: pin ? pin.y : null,
      hw: half.hw, hh: half.hh, ax: anchor.x, ay: anchor.y, degree: 0,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links: RelateSimLink[] = [];
  for (const spring of input.springs) {
    const source = byId.get(spring.a);
    const target = byId.get(spring.b);
    if (!source || !target || source === target) continue;
    source.degree += 1;
    target.degree += 1;
    // Room on the line for the role names: both ends, or one in the middle.
    const room = spring.kind === 'relation'
      ? (spring.roles ?? []).reduce((sum, role) => sum + relateRoleHalf(role).hw * 2, 0) + 36
      : 40;
    const base = spring.kind === 'relation' ? 1 : 0.12 + 0.05 * Math.min(spring.count ?? 1, 4);
    links.push({ source, target, rest: source.hw + target.hw + room, strength: base });
  }
  for (const link of links) {
    const source = link.source as RelateSimNode;
    const target = link.target as RelateSimNode;
    link.strength /= Math.min(source.degree, target.degree);
    // A hub's partners need room around it: its lines grow with how many it has.
    link.rest += HUB_ROOM * Math.sqrt(Math.max(0, Math.max(source.degree, target.degree) - 4));
  }
  return forceSimulation<RelateSimNode, RelateSimLink>(nodes)
    .stop()
    .randomSource(lcg(0x2d5e))
    .alpha(input.alpha)
    .alphaMin(RELATE_ALPHA_MIN)
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(VELOCITY_DECAY)
    .force('link', forceLink<RelateSimNode, RelateSimLink>(links).distance((link) => link.rest).strength((link) => link.strength))
    .force('charge', forceManyBody<RelateSimNode>().strength(forces.charge).distanceMax(forces.reach))
    .force('x', forceX<RelateSimNode>((node) => node.ax).strength(forces.anchor))
    .force('y', forceY<RelateSimNode>((node) => node.ay).strength(forces.anchor))
    .force('collide', forceRectCollide());
}

export function relateCooled(simulation: RelateSimulation): boolean {
  return simulation.alpha() < simulation.alphaMin() && simulation.alphaTarget() === 0;
}

/** Run the simulation until it cools. */
export function settleRelate(simulation: RelateSimulation): number {
  let ticks = 0;
  while (!relateCooled(simulation) && ticks < 600) {
    simulation.tick();
    ticks += 1;
  }
  return ticks;
}

export function relatePositions(simulation: RelateSimulation): Map<string, RelatePoint> {
  return new Map(simulation.nodes().map((node) => [node.id, { x: node.x!, y: node.y! }]));
}

/** The world rectangle the cells cover. */
export function relateBounds(positions: ReadonlyMap<string, RelatePoint>, names: ReadonlyMap<string, string>) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [id, point] of positions) {
    const half = relateCellHalf(names.get(id) ?? '');
    minX = Math.min(minX, point.x - half.hw); maxX = Math.max(maxX, point.x + half.hw);
    minY = Math.min(minY, point.y - half.hh); maxY = Math.max(maxY, point.y + half.hh);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** A signature of what pulls on the layout; a layout kept under another one settles again. */
export function relateSpringSignature(nodes: readonly RelateNodeInput[], springs: readonly RelateSpring[]): string {
  const parts = springs.map((spring) => {
    const [a, b] = spring.a < spring.b ? [spring.a, spring.b] : [spring.b, spring.a];
    return `${spring.kind}:${a}:${b}:${spring.count ?? ''}:${(spring.roles ?? []).join('/')}`;
  });
  parts.sort();
  let h = 2166136261;
  const text = `${nodes.map((node) => node.id).sort().join(',')}#${parts.join(';')}`;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ── Lines and role names ───────────────────────────────────────────

/** How far a centred box reaches along a unit direction. */
function reach(hw: number, hh: number, ux: number, uy: number): number {
  const along = Math.abs(ux) > 1e-6 ? hw / Math.abs(ux) : Infinity;
  const across = Math.abs(uy) > 1e-6 ? hh / Math.abs(uy) : Infinity;
  return Math.min(along, across);
}

function onQuad(x0: number, y0: number, cx: number, cy: number, x2: number, y2: number, t: number): RelatePoint {
  const u = 1 - t;
  return { x: u * u * x0 + 2 * u * t * cx + t * t * x2, y: u * u * y0 + 2 * u * t * cy + t * t * y2 };
}

/**
 * How much a line bows, as a share of its length: one relation between a
 * pair is a slight arc; several between the same pair fan out around it.
 */
export function relateBend(index: number, count: number): number {
  return count > 1 ? (index - (count - 1) / 2) * 0.16 : 0.07;
}

export interface RelateRoleLabel { text: string; x: number; y: number }

export interface RelateEdgeGeometry {
  d: string;
  /** Empty when the line is too short to hold its role names. */
  labels: RelateRoleLabel[];
  /** 0–1: role names fade in as the line gets room for them. */
  labelAlpha: number;
}

/**
 * A relation line between two cells, bowed by `bend` (from the endpoint
 * with the smaller id, so a pair's lines fan out whichever way they point),
 * with its role names: a directed relation's at each end, just off the
 * cell it names; a symmetric one's in the middle.
 */
export function relateEdgeGeometry(input: {
  fromId: string;
  toId: string;
  from: RelatePoint;
  to: RelatePoint;
  fromHalf: { hw: number; hh: number };
  toHalf: { hw: number; hh: number };
  bend: number;
  /** [source role, target role] for a directed relation; [shared role] for a symmetric one. */
  roles: readonly string[];
  /** Role names drawn larger than the world (from far away), so their room grows too. */
  labelScale?: number;
}): RelateEdgeGeometry {
  const scale = input.labelScale ?? 1;
  const roleHalf = (text: string) => {
    const half = relateRoleHalf(text);
    return { hw: half.hw * scale, hh: half.hh * scale };
  };
  const forward = input.fromId < input.toId;
  const p0 = forward ? input.from : input.to;
  const p2 = forward ? input.to : input.from;
  const dx = p2.x - p0.x;
  const dy = p2.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  const cx = (p0.x + p2.x) / 2 - dy * input.bend;
  const cy = (p0.y + p2.y) / 2 + dx * input.bend;
  const d = `M ${p0.x.toFixed(1)} ${p0.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  const ux = dx / len;
  const uy = dy / len;
  const GAP = 6;
  const roles = input.roles.filter(Boolean);
  if (roles.length === 0) return { d, labels: [], labelAlpha: 0 };
  if (roles.length === 1) {
    const half = roleHalf(roles[0]);
    const eL = reach(half.hw, half.hh, ux, uy);
    const spare = len - reach(input.fromHalf.hw, input.fromHalf.hh, ux, uy) - reach(input.toHalf.hw, input.toHalf.hh, ux, uy) - 2 * (GAP + eL);
    if (spare <= 0) return { d, labels: [], labelAlpha: 0 };
    const point = onQuad(p0.x, p0.y, cx, cy, p2.x, p2.y, 0.5);
    return { d, labels: [{ text: roles[0], ...point }], labelAlpha: Math.min(1, spare / 24) };
  }
  const ends = [
    { atFrom: true, text: roles[0], half: input.fromHalf },
    { atFrom: false, text: roles[1], half: input.toHalf },
  ].map((end) => {
    const label = roleHalf(end.text);
    const eL = reach(label.hw, label.hh, ux, uy);
    return { ...end, eL, at: reach(end.half.hw, end.half.hh, ux, uy) + GAP + eL };
  });
  const spare = len - ends.reduce((sum, end) => sum + end.at + end.eL, 0) - 6;
  if (spare <= 0) return { d, labels: [], labelAlpha: 0 };
  const labels = ends.map((end) => {
    // `at` runs from the cell the role belongs to.
    const fromP0 = end.atFrom === forward;
    const t = fromP0 ? end.at / len : 1 - end.at / len;
    return { text: end.text, ...onQuad(p0.x, p0.y, cx, cy, p2.x, p2.y, t) };
  });
  return { d, labels, labelAlpha: Math.min(1, spare / 24) };
}

// ── Remembered per project ─────────────────────────────────────────

export type ElementLayoutMode = 'isles' | 'relate';

export interface RelateRecord {
  mode: ElementLayoutMode;
  positions: ReadonlyMap<string, RelatePoint> | null;
  pins: ReadonlyMap<string, RelatePoint>;
  signature: string | null;
}

export function relateStorageKey(projectId: string): string {
  return `super-element-view:relate:${projectId}`;
}

function unpack(value: unknown): Map<string, RelatePoint> {
  const out = new Map<string, RelatePoint>();
  if (!value || typeof value !== 'object') return out;
  for (const [id, point] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(point) && typeof point[0] === 'number' && typeof point[1] === 'number'
      && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
      out.set(id, { x: point[0], y: point[1] });
    }
  }
  return out;
}

function pack(points: ReadonlyMap<string, RelatePoint>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [id, point] of points) out[id] = [Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10];
  return out;
}

/** A book opens in 关系 unless the author chose the islands for it (2026-11-04). */
export function parseRelateRecord(raw: string | null): RelateRecord {
  const empty: RelateRecord = { mode: 'relate', positions: null, pins: new Map(), signature: null };
  if (!raw) return empty;
  try {
    const data = JSON.parse(raw) as { mode?: unknown; positions?: unknown; pins?: unknown; signature?: unknown };
    const positions = data.positions ? unpack(data.positions) : null;
    return {
      mode: data.mode === 'isles' ? 'isles' : 'relate',
      positions: positions && positions.size > 0 ? positions : null,
      pins: unpack(data.pins),
      signature: typeof data.signature === 'string' ? data.signature : null,
    };
  } catch {
    return empty;
  }
}

export function serializeRelateRecord(record: RelateRecord): string {
  return JSON.stringify({
    v: 1,
    mode: record.mode,
    positions: record.positions ? pack(record.positions) : null,
    pins: pack(record.pins),
    signature: record.signature,
  });
}

export function readRelateRecord(projectId: string | undefined): RelateRecord {
  if (!projectId) return parseRelateRecord(null);
  try {
    return parseRelateRecord(localStorage.getItem(relateStorageKey(projectId)));
  } catch {
    return parseRelateRecord(null);
  }
}

export function writeRelateRecord(projectId: string | undefined, record: RelateRecord): void {
  if (!projectId) return;
  try {
    localStorage.setItem(relateStorageKey(projectId), serializeRelateRecord(record));
  } catch {
    /* quota or privacy mode — the layout just isn't remembered */
  }
}
