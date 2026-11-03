import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import {
  createRelateSimulation,
  readRelateRecord,
  relateCooled,
  relatePositions,
  relateSpringSignature,
  settleRelate,
  writeRelateRecord,
  RELATE_DRAG_ALPHA,
  type ElementLayoutMode,
  type RelateNodeInput,
  type RelatePoint,
  type RelateSimulation,
  type RelateSpring,
} from './element-relate-layout';

/** Moves between two known layouts (the islands, a remembered 关系 layout) take the structural ease. */
export const RELATE_MOVE_MS = 520;

function ease(t: number): number {
  // cubic-bezier(0.32, 0.72, 0, 1), solved for x by bisection.
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const b = (s: number, p1: number, p2: number) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 22; i += 1) {
    const mid = (lo + hi) / 2;
    if (b(mid, 0.32, 0) < t) lo = mid; else hi = mid;
  }
  return b((lo + hi) / 2, 0.72, 1);
}

export const relateEase = ease;

function copy(points: ReadonlyMap<string, RelatePoint>): Map<string, RelatePoint> {
  return new Map([...points].map(([id, point]) => [id, { x: point.x, y: point.y }]));
}

export interface ElementRelateLayoutInput {
  projectId: string | undefined;
  /** False keeps the hook idle (the paused mobile shell). */
  enabled: boolean;
  nodes: readonly RelateNodeInput[];
  springs: readonly RelateSpring[];
  /** The window's width over its height when a run starts. */
  aspect: () => number;
  reducedMotion: () => boolean;
  /** Called on every frame the layout moves; it paints from `live`. */
  onFrame: () => void;
}

export interface ElementRelateLayout {
  /** The layout the author chose last for this project. */
  mode: ElementLayoutMode;
  setMode: (mode: ElementLayoutMode) => void;
  /** Where each element is right now; written every frame while the layout moves. */
  live: MutableRefObject<Map<string, RelatePoint>>;
  /** The layout as it last came to rest, null before the first. */
  rest: ReadonlyMap<string, RelatePoint> | null;
  pins: ReadonlyMap<string, RelatePoint>;
  /** A run or a move is under way: lines that are not redrawn per frame step aside. */
  moving: boolean;
  /** The layout has caught up with what pulls on it. */
  current: boolean;
  /** Let the simulation find the layout from `start`; returns where it will come to rest. */
  settle: (start: ReadonlyMap<string, RelatePoint>, alpha: number) => Map<string, RelatePoint>;
  /** Move every element to a known place over RELATE_MOVE_MS. */
  moveTo: (target: ReadonlyMap<string, RelatePoint>, done?: () => void) => void;
  /** Put every element somewhere at once (where the islands show them, before a change of layout). */
  place: (points: ReadonlyMap<string, RelatePoint>) => void;
  beginDrag: (id: string) => void;
  dragTo: (id: string, point: RelatePoint) => void;
  endDrag: (id: string) => void;
  unpin: (id: string) => void;
  /** 重新排布: forget every pin and settle again from where the elements are. */
  relayout: () => Map<string, RelatePoint>;
}

/**
 * Drives the 关系 layout (element-relate-layout.ts): the simulation and the
 * moves are advanced on animation frames that only write `live` and call
 * `onFrame`; React hears of the layout once it has cooled (`rest`), and
 * that is what the project remembers.
 */
export function useElementRelateLayout(input: ElementRelateLayoutInput): ElementRelateLayout {
  const { projectId, enabled } = input;
  const inputRef = useRef(input);
  const live = useRef(new Map<string, RelatePoint>());
  const simulationRef = useRef<RelateSimulation | null>(null);
  const tweenRef = useRef<{ from: Map<string, RelatePoint>; to: ReadonlyMap<string, RelatePoint>; t0: number; done?: () => void } | null>(null);
  const frameRef = useRef(0);
  const lastRef = useRef(0);
  const [mode, setModeState] = useState<ElementLayoutMode>('relate');
  const [rest, setRest] = useState<ReadonlyMap<string, RelatePoint> | null>(null);
  const [pins, setPinsState] = useState<ReadonlyMap<string, RelatePoint>>(() => new Map());
  const [moving, setMoving] = useState(false);
  const [restSignature, setRestSignature] = useState<string | null>(null);
  const modeRef = useRef(mode);
  const restRef = useRef(rest);
  const pinsRef = useRef(pins);
  const signatureRef = useRef(restSignature);

  const signature = relateSpringSignature(input.nodes, input.springs);
  const signatureNow = useRef(signature);
  // Frames and gestures read the latest inputs through refs.
  useLayoutEffect(() => {
    inputRef.current = input;
    signatureNow.current = signature;
  });

  const persist = useCallback(() => {
    writeRelateRecord(projectId, {
      mode: modeRef.current,
      positions: restRef.current ? copy(restRef.current) : null,
      pins: pinsRef.current,
      signature: signatureRef.current,
    });
  }, [projectId]);

  const setPins = useCallback((next: ReadonlyMap<string, RelatePoint>) => {
    pinsRef.current = next;
    setPinsState(next);
  }, []);

  // The project's remembered layout, before the first paint.
  useLayoutEffect(() => {
    if (!enabled) return;
    const record = readRelateRecord(projectId);
    simulationRef.current = null;
    tweenRef.current = null;
    modeRef.current = record.mode;
    restRef.current = record.positions;
    signatureRef.current = record.signature;
    pinsRef.current = record.pins;
    live.current = record.positions ? copy(record.positions) : new Map();
    setModeState(record.mode);
    setRest(record.positions);
    setRestSignature(record.signature);
    setPinsState(record.pins);
    setMoving(false);
  }, [enabled, projectId]);

  const commit = useCallback(() => {
    const snapshot = copy(live.current);
    restRef.current = snapshot;
    signatureRef.current = signatureNow.current;
    setRest(snapshot);
    setRestSignature(signatureNow.current);
    setMoving(false);
    persist();
  }, [persist]);

  const kickRef = useRef<() => void>(() => undefined);
  const step = useCallback((now: number) => {
    frameRef.current = 0;
    const dt = lastRef.current ? Math.min(50, now - lastRef.current) : 16.7;
    lastRef.current = now;
    let busy = false;
    const simulation = simulationRef.current;
    if (simulation) {
      if (!relateCooled(simulation)) {
        const ticks = Math.max(1, Math.min(3, Math.round(dt / 16.7)));
        for (let i = 0; i < ticks; i += 1) simulation.tick();
        busy = true;
      } else {
        simulationRef.current = null;
        commit();
      }
    }
    const tween = tweenRef.current;
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / RELATE_MOVE_MS);
      const k = ease(t);
      for (const [id, to] of tween.to) {
        const from = tween.from.get(id) ?? to;
        const point = live.current.get(id);
        const x = from.x + (to.x - from.x) * k;
        const y = from.y + (to.y - from.y) * k;
        if (point) { point.x = x; point.y = y; } else live.current.set(id, { x, y });
      }
      if (t >= 1) {
        tweenRef.current = null;
        setMoving(false);
        tween.done?.();
      } else busy = true;
    }
    inputRef.current.onFrame();
    if (busy) kickRef.current();
    else lastRef.current = 0;
  }, [commit]);
  const kick = useCallback(() => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(step);
  }, [step]);
  useLayoutEffect(() => {
    kickRef.current = kick;
  }, [kick]);
  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  const build = useCallback((start: ReadonlyMap<string, RelatePoint>, alpha: number) => {
    const { nodes, springs, aspect } = inputRef.current;
    return createRelateSimulation({ nodes, springs, start, pins: pinsRef.current, aspect: aspect(), alpha });
  }, []);

  const adopt = useCallback((simulation: RelateSimulation) => {
    simulationRef.current = simulation;
    // The simulation's own nodes are the live positions while it runs.
    live.current = new Map(simulation.nodes().map((node) => [node.id, node as unknown as RelatePoint]));
  }, []);

  const settle = useCallback((start: ReadonlyMap<string, RelatePoint>, alpha: number) => {
    tweenRef.current = null;
    // The same run computed at once first: it tells the camera where the
    // layout will rest, and with reduced motion it is the layout shown.
    const ahead = build(start, alpha);
    settleRelate(ahead);
    const end = relatePositions(ahead);
    if (inputRef.current.reducedMotion()) {
      simulationRef.current = null;
      live.current = copy(end);
      inputRef.current.onFrame();
      commit();
      return end;
    }
    adopt(build(start, alpha));
    setMoving(true);
    kick();
    return end;
  }, [adopt, build, commit, kick]);

  const moveTo = useCallback((target: ReadonlyMap<string, RelatePoint>, done?: () => void) => {
    simulationRef.current = null;
    const from = copy(live.current);
    live.current = copy(live.current);
    if (inputRef.current.reducedMotion()) {
      for (const [id, point] of target) live.current.set(id, { x: point.x, y: point.y });
      tweenRef.current = null;
      inputRef.current.onFrame();
      setMoving(false);
      done?.();
      return;
    }
    tweenRef.current = { from, to: target, t0: performance.now(), done };
    setMoving(true);
    kick();
  }, [kick]);

  const place = useCallback((points: ReadonlyMap<string, RelatePoint>) => {
    simulationRef.current = null;
    tweenRef.current = null;
    live.current = copy(points);
  }, []);

  const beginDrag = useCallback((id: string) => {
    tweenRef.current = null;
    if (!simulationRef.current) adopt(build(copy(live.current), 0));
    const simulation = simulationRef.current!;
    const node = simulation.nodes().find((candidate) => candidate.id === id);
    if (!node) return;
    node.fx = node.x;
    node.fy = node.y;
    setMoving(true);
    if (!inputRef.current.reducedMotion()) {
      simulation.alphaTarget(RELATE_DRAG_ALPHA);
      kick();
    }
  }, [adopt, build, kick]);

  const dragTo = useCallback((id: string, point: RelatePoint) => {
    const node = simulationRef.current?.nodes().find((candidate) => candidate.id === id);
    if (!node) return;
    node.fx = point.x;
    node.fy = point.y;
    if (inputRef.current.reducedMotion()) {
      node.x = point.x;
      node.y = point.y;
      inputRef.current.onFrame();
    } else kick();
  }, [kick]);

  const endDrag = useCallback((id: string) => {
    const simulation = simulationRef.current;
    const node = simulation?.nodes().find((candidate) => candidate.id === id);
    if (!simulation || !node || node.fx == null || node.fy == null) return;
    const next = new Map(pinsRef.current);
    next.set(id, { x: node.fx, y: node.fy });
    setPins(next);
    if (inputRef.current.reducedMotion()) {
      settle(copy(live.current), RELATE_DRAG_ALPHA);
      return;
    }
    simulation.alphaTarget(0);
    kick();
  }, [kick, setPins, settle]);

  const unpin = useCallback((id: string) => {
    if (!pinsRef.current.has(id)) return;
    const next = new Map(pinsRef.current);
    next.delete(id);
    setPins(next);
    settle(copy(live.current), 0.4);
  }, [setPins, settle]);

  const relayout = useCallback(() => {
    setPins(new Map());
    return settle(copy(live.current), 1);
  }, [setPins, settle]);

  const setMode = useCallback((next: ElementLayoutMode) => {
    modeRef.current = next;
    setModeState(next);
    persist();
  }, [persist]);

  return {
    mode, setMode, live, rest, pins, moving,
    current: rest !== null && restSignature === signature,
    settle, moveTo, place, beginDrag, dragTo, endDrag, unpin, relayout,
  };
}
