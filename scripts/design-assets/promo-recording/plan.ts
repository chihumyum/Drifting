// Plans the finished video from a take's timeline (README.md, "How a take
// becomes a video"): which instant of the recording each output frame shows
// (typing and Agent waits run faster), where the camera looks and how close,
// and where the pointer, its clicks and the speed badge are drawn. compose.swift
// renders exactly this; nothing here reads pixels.
//
// Coordinates: window points (top-left origin) in the timeline; canvas points
// in the plan — the window centred on a 16:9 backdrop a little larger than it.

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
  rect?: Rect | null;
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
  /** Seconds a Agent wait is squeezed into, at most. */
  agentWaitSeconds: number;
  /** Speed badges for stretches at least this fast; Infinity for none. */
  badgeFrom: number;
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
}

export interface Plan {
  fps: number; width: number; height: number;
  canvas: { width: number; height: number };
  window: Rect;
  pixelScale: number;
  frames: PlanFrame[];
  /** Output seconds of each keystroke and click, for the sound. */
  sounds: { t: number; kind: 'key' | 'space' | 'return' | 'click' }[];
  duration: number;
}

const TYPING_SPEED: Record<Pace, number> = { slow: 2, normal: 4, fast: 10 };
/** Close to one framing for all writing, so the camera does not breathe with every line's pace. */
const TYPING_ZOOM: Record<Pace, number> = { slow: 1.85, normal: 1.8, fast: 1.7 };
const MAX_ZOOM = 2.7;
/** The camera moves towards what is about to happen this much (output seconds) early. */
const LEAD = 0.3;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// ---------------------------------------------------------------- time

/** Recording seconds → playback speed: typing by pace, Agent waits squeezed. */
function speedSegments(events: TimelineEvent[], options: PlanOptions): { from: number; to: number; speed: number; agent: boolean }[] {
  const segments: { from: number; to: number; speed: number; agent: boolean }[] = [];
  let open: TimelineEvent | null = null;
  let agent: TimelineEvent | null = null;
  for (const event of events) {
    if (event.type !== 'mark') continue;
    if (event.name === 'type.start') open = event;
    else if (event.name === 'type.end' && open) {
      // A line the recording frames specially (the opening) plays as typed.
      segments.push({ from: open.t, to: event.t, speed: open.zoom ? 1 : TYPING_SPEED[open.pace ?? 'normal'], agent: false });
      open = null;
    } else if (event.name === 'agent.start') agent = event;
    else if (event.name === 'agent.end' && agent) {
      const length = event.t - agent.t;
      segments.push({ from: agent.t, to: event.t, speed: Math.round(clamp(length / options.agentWaitSeconds, 1, 40)), agent: true });
      agent = null;
    }
  }
  return segments.sort((a, b) => a.from - b.from);
}

/**
 * Output time for each recording time, stepping the recording finely and
 * easing the speed towards each stretch's, so a change of pace never jolts.
 * Returns parallel arrays (recording → output), both increasing.
 */
function timeMap(start: number, end: number, segments: ReturnType<typeof speedSegments>) {
  const step = 1 / 480;
  const source: number[] = [start];
  const output: number[] = [0];
  const speedAt = (t: number) => segments.find((segment) => t >= segment.from && t < segment.to)?.speed ?? 1;
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

interface Target { cx: number; cy: number; z: number }

/** What the camera wants to look at, at each recording time. */
function cameraTargets(events: TimelineEvent[], toCanvas: (x: number, y: number) => [number, number], canvas: { width: number; height: number }) {
  const fit = (rect: Rect, pad: number, low: number, high: number): Target => {
    const [x, y] = toCanvas(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const z = Math.min(canvas.width / (rect.width + pad * 2), canvas.height / (rect.height + pad * 2));
    return { cx: x, cy: y, z: clamp(z, low, high) };
  };
  const wide: Target = { cx: canvas.width / 2, cy: canvas.height / 2, z: 1 };
  // Each directive holds from its time until the next.
  const directives: { t: number; target(t: number): Target }[] = [];
  const carets = events.filter((event) => event.type === 'caret' && event.rect) as (TimelineEvent & { rect: Rect })[];
  const caretAt = (t: number): Rect | null => {
    let found: Rect | null = null;
    for (const caret of carets) { if (caret.t <= t) found = caret.rect; else break; }
    return found;
  };
  for (const [index, event] of events.entries()) {
    if (event.type !== 'mark') continue;
    if (event.name === 'type.start') {
      const end = events.slice(index).find((later) => later.type === 'mark' && later.name === 'type.end')?.t ?? Infinity;
      const zoom = event.zoom ?? (event.kind === 'prompt' ? 1.9 : TYPING_ZOOM[event.pace ?? 'normal']);
      const column = event.column?.text ?? null;
      const first = carets.find((caret) => caret.t >= event.t && caret.t <= end)?.rect ?? null;
      directives.push({
        t: event.t,
        target: (t) => {
          const caret = caretAt(Math.min(t, end)) ?? first;
          if (!caret) return column ? fit(column, 80, 1, zoom) : wide;
          // The caret's line a little below the middle, so what was just
          // written fills the frame above it.
          const [x, y] = toCanvas(
            column && event.kind !== 'prompt' ? column.x + column.width / 2 : caret.x,
            caret.y + caret.height / 2 - (event.kind === 'prompt' ? 0 : (canvas.height / zoom) * 0.14),
          );
          return { cx: x, cy: y, z: zoom };
        },
      });
    } else if (event.name === 'shot') {
      const target = event.rect ? fit(event.rect, 40, 1, event.zoom ?? MAX_ZOOM) : wide;
      if (event.rect && event.zoom) target.z = event.zoom;
      directives.push({ t: event.t, target: () => target });
    } else if (event.name === 'target' && event.rect) {
      const target = fit(event.rect, 230, 1.15, event.zoom ?? 2.1);
      directives.push({ t: event.t, target: () => target });
    }
  }
  directives.sort((a, b) => a.t - b.t);
  return (t: number): Target => {
    let current: (typeof directives)[number] | null = null;
    for (const directive of directives) { if (directive.t <= t) current = directive; else break; }
    // Before the first directive, already where it will look.
    return (current ?? directives[0])?.target(t) ?? wide;
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
  const canvasHeight = windowSize.height / 0.86;
  const canvas = { width: canvasHeight * (options.width / options.height), height: canvasHeight };
  const windowRect: Rect = {
    x: (canvas.width - windowSize.width) / 2, y: (canvas.height - windowSize.height) / 2, ...windowSize,
  };
  const toCanvas = (x: number, y: number): [number, number] => [x + windowRect.x, y + windowRect.y];

  const firstType = events.find((event) => event.type === 'mark' && event.name === 'type.start')?.t ?? 0;
  const start = Math.max(0, firstType - 1.1);
  const stop = events.find((event) => event.type === 'record.stop')?.t ?? events[events.length - 1].t;
  const segments = speedSegments(events, options);
  const map = timeMap(start, stop, segments);
  const duration = map.output[map.output.length - 1];
  const sourceAt = (out: number) => interpolate(map.output, map.source, out);
  const outputAt = (src: number) => interpolate(map.source, map.output, src);
  const targetAt = cameraTargets(events, toCanvas, canvas);

  // Pointer samples, presses and when typing hides it (as macOS does).
  const pointer = events.filter((event) => event.type === 'pointer' || event.type === 'pointer.down' || event.type === 'pointer.up');
  const presses: { down: number; up: number; x: number; y: number }[] = [];
  for (const event of events) {
    if (event.type === 'pointer.down') presses.push({ down: event.t, up: Infinity, x: event.x ?? 0, y: event.y ?? 0 });
    else if (event.type === 'pointer.up' && presses.length) presses[presses.length - 1].up = event.t;
  }
  const typing = events.filter((event) => event.type === 'type' || event.type === 'key').map((event) => event.t);
  // Moves made before the video starts (placing the caret off camera) do not show it.
  const moving = events.filter((event) => event.type === 'pointer' && event.t >= start).map((event) => event.t);
  const pointerAt = (t: number): [number, number] => {
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
  const count = Math.floor(duration * options.fps);
  const dt = 1 / options.fps;
  // Already where the first shot looks, rather than zooming in from afar.
  const initial = targetAt(Math.max(sourceAt(LEAD), firstType + 0.2));
  const springs = { x: new Spring(initial.cx, 4.2), y: new Spring(initial.cy, 4.2), z: new Spring(Math.log(initial.z), 3.0) };
  let alpha = 0;
  for (let frame = 0; frame < count; frame += 1) {
    const out = frame * dt;
    const s = sourceAt(out);
    const target = targetAt(sourceAt(out + LEAD));
    springs.x.step(target.cx, dt);
    springs.y.step(target.cy, dt);
    springs.z.step(Math.log(target.z), dt);
    const z = clamp(Math.exp(springs.z.value), 1, MAX_ZOOM);
    // Keep the camera on the canvas; once zoomed in, on the window itself.
    const cw = canvas.width / z;
    const ch = canvas.height / z;
    const inside = clamp((z - 1) / 0.35, 0, 1);
    const bounds = {
      left: windowRect.x * inside, top: windowRect.y * inside,
      right: canvas.width - windowRect.x * inside, bottom: canvas.height - windowRect.y * inside,
    };
    const cx = bounds.right - bounds.left <= cw ? (bounds.left + bounds.right) / 2 : clamp(springs.x.value, bounds.left + cw / 2, bounds.right - cw / 2);
    const cy = bounds.bottom - bounds.top <= ch ? (bounds.top + bounds.bottom) / 2 : clamp(springs.y.value, bounds.top + ch / 2, bounds.bottom - ch / 2);

    const [wx, wy] = pointerAt(s);
    const [px, py] = toCanvas(wx, wy);
    alpha = clamp(alpha + (pointerShown(s) ? 1 : -1) * dt / 0.15, 0, 1);
    const pressed = presses.find((press) => s >= press.down && s < press.up + 0.02);
    const ripples = presses
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
    // Typing is plainly sped up; the badge marks the Agent's waits, which the video squeezes most.
    const badge = segment && segment.agent && segment.speed >= options.badgeFrom ? `×${segment.speed}` : null;
    frames.push({
      s: Math.round(s * 1e4) / 1e4, cx: round(cx), cy: round(cy), z: Math.round(z * 1e4) / 1e4,
      px: round(px), py: round(py), pa: round(alpha), pp: pressed ? 0.86 : 1,
      r: ripples.map(([x, y, radius, opacity]) => [round(x), round(y), round(radius), round(opacity)]), b: badge, ba: badge ? 1 : 0,
      ...(shrunk ? { k: shrunk } : {}),
    });
  }
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
  return {
    fps: options.fps, width: options.width, height: options.height, canvas, window: windowRect,
    pixelScale: timeline.recording.pixelWidth / timeline.recording.pointWidth,
    frames, sounds, duration: count * dt,
  };
}

const round = (value: number) => Math.round(value * 100) / 100;
