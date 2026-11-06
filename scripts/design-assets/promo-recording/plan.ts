// Plans the finished video from a take's timeline (README.md, "How a take
// becomes a video"): which instant of the recording each output frame shows
// (Agent waits run faster; paragraphs typed quickly play at a steady pace; the
// whole may be sped up by `pace`), where
// the camera looks and how close, the opening on a desktop with a Dock, and
// where the pointer, its clicks, the speed badge and the end card are drawn.
// compose.swift renders exactly this; nothing here reads pixels.
//
// Coordinates: window points (top-left origin) in the timeline; canvas points
// in the plan — the window centred on a 16:9 backdrop a little larger than it.
//
// The camera holds still. A framing is chosen when something new happens
// (a shot, the start of writing, a prompt being typed) and kept while the
// action stays well inside it; only when the caret or the next click would
// leave its safe area does the camera move, once, to bring it back in. The
// moves are eased with a critically damped spring.

export interface Rect { x: number; y: number; width: number; height: number }
type Pace = 'slow' | 'normal' | 'fast';

export interface TimelineEvent {
  t: number;
  type: string;
  name?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  pace?: Pace;
  kind?: string;
  zoom?: number;
  /** A shot's margin around its rectangle (40 points unless set). */
  pad?: number;
  /** A shot's frame stays inside this (the page column), where it fits. */
  within?: Rect | null;
  rect?: Rect | null;
  focus?: Rect | null;
  column?: { text: Rect; paper: Rect } | null;
  what?: string;
  scale?: number;
}

export interface Timeline {
  window: { width: number; height: number };
  recording: { pixelWidth: number; pixelHeight: number; pointWidth: number; pointHeight: number };
  events: TimelineEvent[];
}

export interface PlanOptions {
  fps: number;
  width: number;
  height: number;
  /** Seconds an Agent wait is squeezed into, at most. */
  agentWaitSeconds: number;
  /** Speed badges for stretches at least this fast; Infinity for none. */
  badgeFrom: number;
  /** Seconds of the closing card; 0 for none. */
  endCard: number;
  /**
   * How much faster than recorded the video plays once the window has opened
   * (1 = as typed). Quick paragraphs and Agent waits speed up with it; the
   * opening and the end card, and every sound, keep their own pace.
   */
  pace: number;
  /** How much faster than recorded typing plays (prose, prompts and fields); `pace` unless given. */
  typingPace?: number;
}

export interface PlanFrame {
  /** Recording seconds shown. */
  s: number;
  /** Camera centre (canvas points) and zoom (1 = the whole canvas). */
  cx: number; cy: number; z: number;
  /** Pointer tip (canvas points), opacity, press scale. */
  px: number; py: number; pa: number; pp: number;
  /** Click ripples: centre, radius (canvas points), opacity. */
  r: [number, number, number, number][];
  /** Speed badge text and opacity. */
  b: string | null; ba: number;
  /**
   * When the capture shrank the window to fit something attached to it: the
   * scale it applied and where the content starts, in points of the frame.
   */
  k?: [number, number, number];
  /** The window opening: opacity and scale about its centre (absent: shown, 1). */
  w?: [number, number];
  /** The Dock: opacity, how far it has slid down (canvas points), the icon's bounce (points), the running dot's opacity. */
  d?: [number, number, number, number];
  /** The closing card's opacity. */
  e?: number;
}

export interface Plan {
  fps: number; width: number; height: number;
  canvas: { width: number; height: number };
  window: Rect;
  pixelScale: number;
  /** The Dock's icon: centre (canvas points) and size. */
  dock: { x: number; y: number; size: number } | null;
  frames: PlanFrame[];
  /** Output seconds of each keystroke and click, for the sound. */
  sounds: { t: number; kind: 'key' | 'space' | 'return' | 'click' }[];
  duration: number;
}

/** The window's share of the canvas height: the backdrop shows around it in wide shots. */
const WINDOW_SHARE = 0.88;
const MAX_ZOOM = 2.7;
/** The camera moves towards what is about to happen this much (output seconds) early. */
const LEAD = 0.35;
/** How far past the window's edge (canvas points) a close camera may look, so a panel at the edge can sit nearer the middle. */
const EDGE = 70;
/** Characters a second the video plays paragraphs typed quickly (`<!-- quick -->`) at. */
const QUICK_CPS = 8;
/** The Dock's icon size and the gap under its shelf, canvas points. */
const DOCK_ICON = 46;
const DOCK_GAP = 6;
const DOCK_PAD = 7;
/** The drawn arrow's extent from its tip, canvas points (compose.swift: 12 × 19 at 1.25). */
const POINTER_SIZE = { width: 15, height: 24 };

/**
 * Where Drifting's icon sits in the opening's Dock, in window points: centred
 * under the window, on the canvas's bottom margin. The recording parks the real
 * pointer there before it starts, so the hand that clicks it carries on from it.
 */
export function dockSpot(windowSize: { width: number; height: number }) {
  const margin = (windowSize.height / WINDOW_SHARE - windowSize.height) / 2;
  return { x: windowSize.width / 2, y: windowSize.height + margin - DOCK_GAP - DOCK_PAD - DOCK_ICON / 2 };
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const ease = (f: number) => { const x = clamp(f, 0, 1); return x * x * (3 - 2 * x); };
const easeOut = (f: number) => 1 - (1 - clamp(f, 0, 1)) ** 3;

// ---------------------------------------------------------------- time

interface Segment { from: number; to: number; speed: number; agent: boolean }

/**
 * Recording stretches that do not play at their own pace: Agent waits
 * squeezed, paragraphs typed quickly slowed to a steady QUICK_CPS (measured
 * from the keystrokes in them).
 */
function segmentsOf(events: TimelineEvent[], options: PlanOptions): Segment[] {
  const { pace } = options;
  const typingPace = options.typingPace ?? pace;
  const segments: Segment[] = [];
  let agent: TimelineEvent | null = null;
  let quick: TimelineEvent | null = null;
  let typing: TimelineEvent | null = null;
  for (const event of events) {
    if (event.type !== 'mark') continue;
    if (event.name === 'type.start') typing = event;
    else if (event.name === 'type.end' && typing) {
      // Typing at its own pace; a quick paragraph's own stretch (found first, as it starts earlier) wins.
      if (typingPace !== pace) segments.push({ from: typing.t, to: event.t, speed: typingPace, agent: false });
      typing = null;
    } else if (event.name === 'agent.start') agent = event;
    else if (event.name === 'agent.end' && agent) {
      const length = event.t - agent.t;
      // A whole number, as the badge shows it.
      const speed = Math.round(clamp(length * pace / options.agentWaitSeconds, 1, 60));
      segments.push({ from: agent.t, to: event.t, speed: Math.max(pace, speed), agent: true });
      agent = null;
    } else if (event.name === 'quick.start') quick = event;
    else if (event.name === 'quick.end' && quick) {
      const from = quick.t, to = event.t;
      const keys = events.filter((key) => (key.type === 'type' || key.type === 'key') && key.t >= from && key.t < to).length;
      if (keys > 0) segments.push({ from, to, speed: clamp(QUICK_CPS * typingPace / (keys / (to - from)), 0.05, typingPace), agent: false });
      quick = null;
    }
  }
  return segments.sort((a, b) => a.from - b.from);
}

/**
 * Output time for each recording time, stepping the recording finely and
 * easing the speed towards each stretch's, so a change of pace never jolts.
 * Returns parallel arrays (recording → output), both increasing.
 */
function timeMap(start: number, end: number, segments: Segment[], pace: number, paceFrom: number) {
  const step = 1 / 480;
  const source: number[] = [start];
  const output: number[] = [0];
  const speedAt = (t: number) => segments.find((segment) => t >= segment.from && t < segment.to)?.speed ?? (t < paceFrom ? 1 : pace);
  let speed = speedAt(start);
  for (let t = start; t < end; t += step) {
    const target = speedAt(t);
    // About 0.2 s (output) to settle on a new speed, in log space.
    const dtOut = step / speed;
    speed = Math.exp(Math.log(speed) + (Math.log(target) - Math.log(speed)) * Math.min(1, dtOut / 0.2));
    source.push(t + step);
    output.push(output[output.length - 1] + step / speed);
  }
  return { source, output };
}

function interpolate(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let low = 0;
  let high = xs.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (xs[middle] <= x) low = middle; else high = middle;
  }
  const f = (x - xs[low]) / (xs[high] - xs[low] || 1);
  return ys[low] + (ys[high] - ys[low]) * f;
}

// ---------------------------------------------------------------- camera

interface Framing { cx: number; cy: number; z: number }

/**
 * The framings the camera holds, each from its recording time until the
 * next: decided once from the marks, so between them nothing moves.
 */
function cameraKeyframes(events: TimelineEvent[], toCanvas: (x: number, y: number) => [number, number], canvas: { width: number; height: number }) {
  const wide: Framing = { cx: canvas.width / 2, cy: canvas.height / 2, z: 1 };
  const view = (framing: Framing) => ({ width: canvas.width / framing.z, height: canvas.height / framing.z });
  /** The framing that shows `rect` (window points) with `pad` around it, at most `high` close. */
  const fit = (rect: Rect, pad: number, high: number, low = 1): Framing => {
    const [x, y] = toCanvas(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const z = Math.min(canvas.width / (rect.width + pad * 2), canvas.height / (rect.height + pad * 2));
    return { cx: x, cy: y, z: clamp(z, low, high) };
  };
  /**
   * The same framing if `rect` lies inside its safe area (`inset` of the view
   * kept clear on every side), else the least move that brings it in —
   * zooming out only if it cannot fit.
   */
  const ensure = (framing: Framing, rect: Rect, inset: number): Framing => {
    const [left, top] = toCanvas(rect.x, rect.y);
    const right = left + rect.width, bottom = top + rect.height;
    let { cx, cy, z } = framing;
    const fits = () => {
      const size = view({ cx, cy, z });
      return rect.width <= size.width * (1 - 2 * inset) && rect.height <= size.height * (1 - 2 * inset);
    };
    while (z > 1 && !fits()) z = Math.max(1, z / 1.12);
    const size = view({ cx, cy, z });
    const safeLeft = cx - size.width * (0.5 - inset), safeRight = cx + size.width * (0.5 - inset);
    const safeTop = cy - size.height * (0.5 - inset), safeBottom = cy + size.height * (0.5 - inset);
    // Move past the edge by a little more than needed, so the next action
    // nearby does not need another move.
    const slack = (span: number) => span * 0.08;
    if (left < safeLeft) cx -= safeLeft - left + slack(size.width);
    else if (right > safeRight) cx += right - safeRight + slack(size.width);
    if (top < safeTop) cy -= safeTop - top + slack(size.height);
    else if (bottom > safeBottom) cy += bottom - safeBottom + slack(size.height);
    return { cx, cy, z };
  };
  /** Slides a framing, without zooming, so its view stays inside `rect` where it fits. */
  const keepWithin = (framing: Framing, rect: Rect): Framing => {
    const [left, top] = toCanvas(rect.x, rect.y);
    const size = view(framing);
    let { cx, cy } = framing;
    if (size.width <= rect.width) cx = clamp(cx, left + size.width / 2, left + rect.width - size.width / 2);
    if (size.height <= rect.height) cy = clamp(cy, top + size.height / 2, top + rect.height - size.height / 2);
    return { cx, cy, z: framing.z };
  };
  const same = (a: Framing, b: Framing) => Math.abs(a.cx - b.cx) < 1 && Math.abs(a.cy - b.cy) < 1 && Math.abs(Math.log(a.z / b.z)) < 0.01;

  const keyframes: { t: number; framing: Framing }[] = [];
  let current = wide;
  const hold = (t: number, framing: Framing) => {
    if (same(framing, current)) return;
    current = framing;
    keyframes.push({ t, framing });
  };
  keyframes.push({ t: -Infinity, framing: wide });

  /** While writing, the paper's column at a fixed closeness; the caret's line just under the middle. */
  let writing: { zoom: number; x: number } | null = null;
  let typing: TimelineEvent | null = null;
  let framedOpening = false;
  const writingAt = (caret: Rect, zoom: number, x: number): Framing => {
    const [, y] = toCanvas(0, caret.y + caret.height / 2);
    return { cx: toCanvas(x, 0)[0], cy: y - (canvas.height / zoom) * 0.06, z: zoom };
  };
  /** The caret band the camera tolerates while writing, as fractions of the view's height. */
  const band = { top: 0.3, bottom: 0.74 };

  for (const event of events) {
    if (event.type === 'caret' && event.rect && typing?.kind === 'prose') {
      const caret = event.rect;
      if (typing.zoom) {
        // The opening line, close, framed once where it starts.
        if (!framedOpening) hold(event.t, writingAt(caret, typing.zoom, caret.x + (canvas.width / typing.zoom) * 0.22));
        framedOpening = true;
        continue;
      }
      if (!writing) { hold(event.t, ensure(current, caret, 0.15)); continue; }
      const size = view(current);
      const [, y] = toCanvas(0, caret.y + caret.height / 2);
      const top = current.cy - size.height / 2;
      const f = (y - top) / size.height;
      if (current.z !== writing.zoom || f < band.top || f > band.bottom) hold(event.t, writingAt(caret, writing.zoom, writing.x));
      continue;
    }
    if (event.type !== 'mark') continue;
    switch (event.name) {
      case 'shot': {
        if (!event.rect) { hold(event.t, wide); break; }
        let framing = fit(event.rect, event.pad ?? 40, event.zoom ?? MAX_ZOOM);
        if (event.zoom) framing.z = event.zoom;
        if (event.within) framing = keepWithin(framing, event.within);
        hold(event.t, framing);
        break;
      }
      case 'writing': {
        const paper = event.column?.paper;
        if (!paper) break;
        const zoom = clamp(canvas.width / (paper.width + 300), 1.2, MAX_ZOOM);
        writing = { zoom, x: paper.x + paper.width / 2 };
        if (event.rect) hold(event.t, writingAt(event.rect, zoom, writing.x));
        break;
      }
      case 'writing.end':
        writing = null;
        break;
      case 'type.start':
        typing = event;
        // A prompt or a field: the box it is typed in, close enough to read.
        if (event.focus && event.kind !== 'prose') hold(event.t, fit(event.focus, 36, event.zoom ?? 2.2));
        break;
      case 'type.end':
        typing = null;
        break;
      case 'target':
        if (!event.rect) break;
        // A click the framing already shows needs no move; an explicit zoom frames it anew.
        if (event.zoom) hold(event.t, fit(event.rect, 230, event.zoom, 1.15));
        else hold(event.t, ensure(current, event.rect, 0.14));
        break;
      default:
        break;
    }
  }
  return (t: number): Framing => {
    let found = keyframes[0].framing;
    for (const keyframe of keyframes) { if (keyframe.t <= t) found = keyframe.framing; else break; }
    return found;
  };
}

/**
 * A critically damped spring per axis (zoom in log space), stepped in output
 * time, so the camera eases in and out of every move and never overshoots.
 */
class Spring {
  value: number;
  velocity = 0;
  constructor(value: number, private readonly omega: number) { this.value = value; }
  step(target: number, dt: number) {
    const x = this.value - target;
    const e = Math.exp(-this.omega * dt);
    const next = (x + (this.velocity + this.omega * x) * dt) * e;
    this.velocity = (this.velocity - this.omega * (this.velocity + this.omega * x) * dt) * e;
    this.value = target + next;
  }
}

// ---------------------------------------------------------------- the plan

export function planVideo(timeline: Timeline, options: PlanOptions): Plan {
  const { events } = timeline;
  const windowSize = { width: timeline.recording.pointWidth, height: timeline.recording.pointHeight };
  const canvasHeight = windowSize.height / WINDOW_SHARE;
  const canvas = { width: canvasHeight * (options.width / options.height), height: canvasHeight };
  const windowRect: Rect = {
    x: (canvas.width - windowSize.width) / 2, y: (canvas.height - windowSize.height) / 2, ...windowSize,
  };
  const toCanvas = (x: number, y: number): [number, number] => [x + windowRect.x, y + windowRect.y];
  const mark = (name: string) => events.find((event) => event.type === 'mark' && event.name === name);

  // The opening: a desktop, a Dock, a click on Drifting, its window opening.
  const introClick = mark('intro.click');
  const introOpen = mark('intro.open');
  const dock = introClick ? (() => {
    const [x, y] = toCanvas(introClick.x ?? windowSize.width / 2, introClick.y ?? windowSize.height + 40);
    return { x, y, size: DOCK_ICON };
  })() : null;

  const firstType = events.find((event) => event.type === 'mark' && event.name === 'type.start')?.t ?? 0;
  const start = introClick ? Math.max(0, introClick.t - 1.8) : Math.max(0, firstType - 1.1);
  const stop = events.find((event) => event.type === 'record.stop')?.t ?? events[events.length - 1].t;
  const segments = segmentsOf(events, options);
  // The opening (the Dock, the window opening, the Dock hiding) plays as drawn.
  const map = timeMap(start, stop, segments, options.pace, introOpen ? introOpen.t + 1.2 : start);
  const recorded = map.output[map.output.length - 1];
  const sourceAt = (out: number) => interpolate(map.output, map.source, out);
  const outputAt = (src: number) => interpolate(map.source, map.output, src);
  const framingAt = cameraKeyframes(events, toCanvas, canvas);

  // Pointer samples, presses and when typing hides it (as macOS does).
  const pointer = events.filter((event) => event.type === 'pointer' || event.type === 'pointer.down' || event.type === 'pointer.up');
  const presses: { down: number; up: number; x: number; y: number }[] = [];
  for (const event of events) {
    if (event.type === 'pointer.down') presses.push({ down: event.t, up: Infinity, x: event.x ?? 0, y: event.y ?? 0 });
    else if (event.type === 'pointer.up' && presses.length) presses[presses.length - 1].up = event.t;
  }
  if (introClick) presses.push({ down: introClick.t, up: introClick.t + 0.09, x: introClick.x ?? 0, y: introClick.y ?? 0 });
  presses.sort((a, b) => a.down - b.down);
  const typing = events.filter((event) => event.type === 'type' || event.type === 'key').map((event) => event.t);
  // Moves made before the video starts (placing the caret off camera) do not show it.
  const moving = events.filter((event) => event.type === 'pointer' && event.t >= start).map((event) => event.t);
  const pointerTimes = pointer.map((event) => event.t);
  /** When the pointer last moved or pressed, at or before `t`. */
  const lastPointerAt = (t: number) => {
    let low = 0, high = pointerTimes.length - 1, found = -Infinity;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (pointerTimes[middle] <= t) { found = pointerTimes[middle]; low = middle + 1; } else high = middle - 1;
    }
    return found;
  };
  const firstRealMove = introOpen ? moving.find((time) => time > introOpen.t) ?? Infinity : -Infinity;
  const pointerAt = (t: number): [number, number] => {
    // The opening's hand: from the middle of the desktop to Drifting in the Dock.
    if (introClick && dock && t < firstRealMove) {
      const from: [number, number] = [canvas.width * 0.64, canvas.height * 0.42];
      const f = ease((t - start - 0.35) / (introClick.t - 0.12 - start - 0.35));
      const lift = Math.sin(Math.PI * f) * canvas.height * 0.05;
      return [from[0] + (dock.x - from[0]) * f - windowRect.x, from[1] + (dock.y - from[1]) * f - lift - windowRect.y];
    }
    let last: TimelineEvent | null = null;
    let next: TimelineEvent | null = null;
    for (const event of pointer) { if (event.t <= t) last = event; else { next = event; break; } }
    if (!last) return [windowRect.width * 0.8, windowRect.height * 0.4];
    if (next && next.type === 'pointer' && last.type === 'pointer' && next.t - last.t < 0.05) {
      const f = (t - last.t) / (next.t - last.t);
      return [(last.x ?? 0) + ((next.x ?? 0) - (last.x ?? 0)) * f, (last.y ?? 0) + ((next.y ?? 0) - (last.y ?? 0)) * f];
    }
    return [last.x ?? 0, last.y ?? 0];
  };
  /** Shown from the first move after typing until the next keystroke. */
  const pointerShown = (t: number) => {
    if (introClick && t < firstRealMove) return true;
    const lastKey = typing.filter((time) => time <= t).pop() ?? -Infinity;
    const lastMove = moving.filter((time) => time <= t).pop() ?? -Infinity;
    return lastMove > lastKey;
  };

  const contents = events.filter((event) => event.type === 'frames.content');
  const contentAt = (t: number) => {
    let found: TimelineEvent | null = null;
    for (const content of contents) { if (content.t <= t + 1e-4) found = content; else break; }
    return found;
  };

  const frames: PlanFrame[] = [];
  const dt = 1 / options.fps;
  const recordedCount = Math.floor(recorded * options.fps);
  const endCount = Math.round(options.endCard * options.fps);
  const initial = framingAt(sourceAt(0));
  const springs = { x: new Spring(initial.cx, 3.6), y: new Spring(initial.cy, 3.6), z: new Spring(Math.log(initial.z), 3.0) };
  // Per frame: whether the pointer should show, and whether it rests cut by the frame's edge.
  const wantPointer: boolean[] = [];
  const restingCut: boolean[] = [];
  for (let frame = 0; frame < recordedCount + endCount; frame += 1) {
    const ending = frame >= recordedCount;
    const out = frame * dt;
    const s = sourceAt(Math.min(out, recorded));
    const target = ending ? { cx: canvas.width / 2, cy: canvas.height / 2, z: 1 } : framingAt(sourceAt(Math.min(out + LEAD, recorded)));
    springs.x.step(target.cx, dt);
    springs.y.step(target.cy, dt);
    springs.z.step(Math.log(target.z), dt);
    const z = clamp(Math.exp(springs.z.value), 1, MAX_ZOOM);
    // Keep the camera on the canvas; once zoomed in, on the window itself.
    const cw = canvas.width / z;
    const ch = canvas.height / z;
    const inside = clamp((z - 1) / 0.35, 0, 1);
    const marginX = Math.max(0, windowRect.x - EDGE) * inside, marginY = Math.max(0, windowRect.y - EDGE * 0.5) * inside;
    const bounds = { left: marginX, top: marginY, right: canvas.width - marginX, bottom: canvas.height - marginY };
    const cx = bounds.right - bounds.left <= cw ? (bounds.left + bounds.right) / 2 : clamp(springs.x.value, bounds.left + cw / 2, bounds.right - cw / 2);
    const cy = bounds.bottom - bounds.top <= ch ? (bounds.top + bounds.bottom) / 2 : clamp(springs.y.value, bounds.top + ch / 2, bounds.bottom - ch / 2);

    const [wx, wy] = pointerAt(s);
    const [px, py] = toCanvas(wx, wy);
    // A hand at rest that the frame's edge cuts through fades out rather than
    // sitting there half drawn; it comes back as soon as it moves.
    const view = { left: cx - cw / 2, right: cx + cw / 2, top: cy - ch / 2, bottom: cy + ch / 2 };
    const reaches = { right: px + POINTER_SIZE.width, bottom: py + POINTER_SIZE.height };
    const inView = px < view.right && reaches.right > view.left && py < view.bottom && reaches.bottom > view.top;
    const cut = inView && (px < view.left || reaches.right > view.right || py < view.top || reaches.bottom > view.bottom);
    const resting = (!introClick || s >= firstRealMove) && s - lastPointerAt(s) > 0.35;
    wantPointer.push(pointerShown(s) && !ending);
    restingCut.push(cut && resting);
    const pressed = presses.find((press) => s >= press.down && s < press.up + 0.02);
    const ripples = ending ? [] : presses
      .map((press) => ({ ...press, age: out - outputAt(press.down) }))
      .filter((press) => press.age >= 0 && press.age < 0.5)
      .map((press): [number, number, number, number] => {
        const [rx, ry] = toCanvas(press.x, press.y);
        const f = press.age / 0.5;
        return [rx, ry, 6 + 26 * (1 - (1 - f) ** 3), 0.38 * (1 - f)];
      });
    const content = contentAt(s);
    const shrunk = content && content.scale !== undefined && Math.abs(content.scale - 1) > 0.002
      ? [content.scale, content.x ?? 0, content.y ?? 0] as [number, number, number] : null;
    const segment = segments.find((candidate) => s >= candidate.from && s < candidate.to);
    // The badge marks the Agent's waits, which the video squeezes.
    const badge = !ending && segment && segment.agent && segment.speed >= options.badgeFrom ? `×${segment.speed}` : null;


    // The opening: the window appears when Drifting is clicked in the Dock, which then hides.
    let windowState: [number, number] | null = null;
    let dockState: [number, number, number, number] | null = null;
    if (introClick && introOpen && dock) {
      const opened = (s - introOpen.t) / 0.42;
      if (opened < 1) windowState = [round(easeOut(opened)), Math.round((0.93 + 0.07 * easeOut(opened)) * 1e4) / 1e4];
      const hidden = ease((s - introOpen.t - 0.75) / 0.4);
      if (hidden < 1) {
        const sinceClick = s - introClick.t;
        // One launch bounce while the app opens.
        const bounce = sinceClick > 0 && sinceClick < 0.62 ? Math.sin(Math.PI * sinceClick / 0.62) * DOCK_ICON * 0.42 : 0;
        dockState = [round(1 - hidden), round(hidden * (DOCK_ICON + DOCK_GAP + DOCK_PAD * 2 + 8)), round(bounce), sinceClick > 0.05 ? 1 : 0];
      }
    }
    const endOpacity = ending ? round(ease((frame - recordedCount) / (options.fps * 0.7))) : 0;

    frames.push({
      s: Math.round(s * 1e4) / 1e4, cx: round(cx), cy: round(cy), z: Math.round(z * 1e4) / 1e4,
      px: round(px), py: round(py), pa: 0, pp: pressed ? 0.86 : 1,
      r: ripples.map(([x, y, radius, opacity]) => [round(x), round(y), round(radius), round(opacity)]), b: badge, ba: badge ? 1 : 0,
      ...(shrunk ? { k: shrunk } : {}),
      ...(windowState ? { w: windowState } : {}),
      ...(dockState ? { d: dockState } : {}),
      ...(endOpacity > 0 ? { e: endOpacity } : {}),
    });
  }
  // The pointer fades in and out over 0.15 s. It hides for a cut rest only when
  // the rest lasts: a moment cut while the camera passes would blink it.
  const minimumRest = Math.round(1.2 * options.fps);
  for (let index = 0; index < restingCut.length;) {
    if (!restingCut[index]) { index += 1; continue; }
    let end = index;
    while (end < restingCut.length && restingCut[end]) end += 1;
    if (end - index < minimumRest) restingCut.fill(false, index, end);
    index = end;
  }
  let alpha = 0;
  frames.forEach((frame, index) => {
    alpha = clamp(alpha + (wantPointer[index] && !restingCut[index] ? 1 : -1) * dt / 0.15, 0, 1);
    frame.pa = round(alpha);
  });
  // Fade the badge in and out over a few frames.
  const labels = frames.map((frame) => frame.b);
  for (let index = 0; index < frames.length; index += 1) {
    if (labels[index]) continue;
    for (let near = 1; near <= 8; near += 1) {
      const neighbour = labels[index - near] ?? labels[index + near];
      if (neighbour) { frames[index].b = neighbour; frames[index].ba = round(1 - near / 9); break; }
    }
  }

  const sounds: Plan['sounds'] = [];
  for (const event of events) {
    if (event.t < start || event.t > stop) continue;
    if (event.type === 'type') sounds.push({ t: outputAt(event.t), kind: event.text === ' ' ? 'space' : 'key' });
    else if (event.type === 'key') sounds.push({ t: outputAt(event.t), kind: event.key === 'return' ? 'return' : 'key' });
    else if (event.type === 'pointer.down') sounds.push({ t: outputAt(event.t), kind: 'click' });
  }
  if (introClick) sounds.push({ t: outputAt(introClick.t), kind: 'click' });
  sounds.sort((a, b) => a.t - b.t);
  return {
    fps: options.fps, width: options.width, height: options.height, canvas, window: windowRect,
    pixelScale: timeline.recording.pixelWidth / timeline.recording.pointWidth,
    dock, frames, sounds, duration: (recordedCount + endCount) * dt,
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
