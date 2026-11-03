import { describe, expect, it } from 'vitest';
import {
  createRelateSimulation,
  parseRelateRecord,
  relateBend,
  relateCellHalf,
  relateEdgeGeometry,
  relatePositions,
  relateSpringSignature,
  serializeRelateRecord,
  settleRelate,
  RELATE_DRAG_ALPHA,
  RELATE_TICKS,
  type RelateNodeInput,
  type RelatePoint,
  type RelateSpring,
} from './element-relate-layout';

// A synthetic book: three islands of elements in a row, a few relations
// across them and some paragraphs that mention two at once.
function book(count = 30, hubEvery = 3): { nodes: RelateNodeInput[]; springs: RelateSpring[] } {
  const names = ['林潮', '老船长', '修灯人阿岚', '北岬灯塔', '缺页日志', '港务局', '盐仓', '夜航'];
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `e${String(i).padStart(3, '0')}`,
    name: `${names[i % names.length]}${i >= names.length ? i : ''}`,
    anchor: { x: (i % 3) * 420 + (Math.floor(i / 3) % 3) * 110, y: Math.floor(i / 9) * 70 },
  }));
  const springs: RelateSpring[] = [];
  for (let i = 1; i < count; i += hubEvery) springs.push({ a: nodes[0].id, b: nodes[i].id, kind: 'relation', roles: ['师父', '徒弟'] });
  for (let i = 2; i < count; i += 5) springs.push({ a: nodes[i].id, b: nodes[(i * 7) % count].id, kind: 'relation', roles: ['旧识'] });
  for (let i = 0; i + 4 < count; i += 4) springs.push({ a: nodes[i].id, b: nodes[i + 4].id, kind: 'prose', count: 1 + (i % 5) });
  return { nodes, springs };
}

const fromAnchors = (nodes: readonly RelateNodeInput[]) => new Map(nodes.map((node) => [node.id, node.anchor]));

function overlaps(nodes: readonly RelateNodeInput[], positions: ReadonlyMap<string, RelatePoint>): number {
  let count = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = positions.get(nodes[i].id)!;
      const b = positions.get(nodes[j].id)!;
      const ha = relateCellHalf(nodes[i].name);
      const hb = relateCellHalf(nodes[j].name);
      // A pixel of touching is allowed; the margin keeps cells apart beyond it.
      if (ha.hw + hb.hw - Math.abs(a.x - b.x) > 1.5 && ha.hh + hb.hh - Math.abs(a.y - b.y) > 1.5) count += 1;
    }
  }
  return count;
}

describe('the 关系 layout of the element overview', () => {
  it('settles from the islands in one run without cells on top of each other', () => {
    const { nodes, springs } = book();
    const simulation = createRelateSimulation({ nodes, springs, start: fromAnchors(nodes), pins: new Map(), aspect: 1.6, alpha: 1 });
    const ticks = settleRelate(simulation);
    expect(ticks).toBeGreaterThan(RELATE_TICKS - 5);
    expect(ticks).toBeLessThan(RELATE_TICKS + 5);
    expect(overlaps(nodes, relatePositions(simulation))).toBe(0);
  });

  it('is deterministic: a run played tick by tick ends where the run computed at once does', () => {
    const { nodes, springs } = book();
    const input = { nodes, springs, start: fromAnchors(nodes), pins: new Map<string, RelatePoint>(), aspect: 1.6, alpha: 1 };
    const ahead = createRelateSimulation(input);
    settleRelate(ahead);
    const played = createRelateSimulation(input);
    while (played.alpha() >= played.alphaMin()) played.tick();
    expect([...relatePositions(played)]).toEqual([...relatePositions(ahead)]);
  });

  it('pulls related elements closer than the islands held them', () => {
    const { nodes, springs } = book();
    const simulation = createRelateSimulation({ nodes, springs, start: fromAnchors(nodes), pins: new Map(), aspect: 1.6, alpha: 1 });
    settleRelate(simulation);
    const after = relatePositions(simulation);
    const distance = (map: ReadonlyMap<string, RelatePoint>, a: string, b: string) =>
      Math.hypot(map.get(a)!.x - map.get(b)!.x, map.get(a)!.y - map.get(b)!.y);
    const relations = springs.filter((spring) => spring.kind === 'relation');
    const before = fromAnchors(nodes);
    const mean = (map: ReadonlyMap<string, RelatePoint>) =>
      relations.reduce((sum, spring) => sum + distance(map, spring.a, spring.b), 0) / relations.length;
    expect(mean(after)).toBeLessThan(mean(before));
  });

  it('keeps a dragged element where it was put while the rest settle around it', () => {
    const { nodes, springs } = book();
    const pin = { x: 2000, y: -400 };
    const pins = new Map([[nodes[0].id, pin]]);
    const simulation = createRelateSimulation({ nodes, springs, start: fromAnchors(nodes), pins, aspect: 1.6, alpha: RELATE_DRAG_ALPHA });
    settleRelate(simulation);
    const after = relatePositions(simulation);
    expect(after.get(nodes[0].id)).toEqual(pin);
    // Its relations followed it part of the way.
    const partner = after.get(nodes[1].id)!;
    expect(partner.x).toBeGreaterThan(nodes[1].anchor.x);
    expect(overlaps(nodes, after)).toBe(0);
  });

  it('writes a directed relation’s roles off each end and a symmetric one’s in the middle', () => {
    const half = { hw: 30, hh: 13 };
    const directed = relateEdgeGeometry({
      fromId: 'a', toId: 'b', from: { x: 0, y: 0 }, to: { x: 300, y: 0 },
      fromHalf: half, toHalf: half, bend: 0, roles: ['师父', '徒弟'],
    });
    expect(directed.d).toBe('M 0.0 0.0 Q 150.0 0.0 300.0 0.0');
    expect(directed.labels.map((label) => label.text)).toEqual(['师父', '徒弟']);
    expect(directed.labels[0].x).toBeLessThan(80);
    expect(directed.labels[1].x).toBeGreaterThan(220);
    expect(directed.labelAlpha).toBe(1);
    // Ends named by id order still put each role at its own cell.
    const reversed = relateEdgeGeometry({
      fromId: 'b', toId: 'a', from: { x: 300, y: 0 }, to: { x: 0, y: 0 },
      fromHalf: half, toHalf: half, bend: 0, roles: ['师父', '徒弟'],
    });
    expect(reversed.labels[0].x).toBeGreaterThan(220);
    expect(reversed.labels[1].x).toBeLessThan(80);
    const symmetric = relateEdgeGeometry({
      fromId: 'a', toId: 'b', from: { x: 0, y: 0 }, to: { x: 0, y: 200 },
      fromHalf: half, toHalf: half, bend: 0.07, roles: ['旧识'],
    });
    expect(symmetric.labels).toHaveLength(1);
    expect(symmetric.labels[0].y).toBeCloseTo(100, 0);
    // A line too short for its names carries none.
    const short = relateEdgeGeometry({
      fromId: 'a', toId: 'b', from: { x: 0, y: 0 }, to: { x: 90, y: 0 },
      fromHalf: half, toHalf: half, bend: 0, roles: ['托付人', '受托人'],
    });
    expect(short.labels).toEqual([]);
    expect(relateBend(0, 1)).toBe(0.07);
    expect(relateBend(0, 2)).toBeCloseTo(-0.08);
    expect(relateBend(1, 2)).toBeCloseTo(0.08);
  });

  it('remembers the layout per project and survives a corrupt record', () => {
    const record = {
      mode: 'relate' as const,
      positions: new Map([['a', { x: 1.234, y: -5.67 }]]),
      pins: new Map([['a', { x: 1.234, y: -5.67 }]]),
      signature: 'x1',
    };
    const parsed = parseRelateRecord(serializeRelateRecord(record));
    expect(parsed.mode).toBe('relate');
    expect(parsed.positions?.get('a')).toEqual({ x: 1.2, y: -5.7 });
    expect(parsed.pins.get('a')).toEqual({ x: 1.2, y: -5.7 });
    expect(parsed.signature).toBe('x1');
    // 关系 is the default; the islands only when the author chose them.
    expect(parseRelateRecord(null).mode).toBe('relate');
    expect(parseRelateRecord('{not json').mode).toBe('relate');
    expect(parseRelateRecord(JSON.stringify({ v: 1, mode: 'isles', positions: null, pins: {}, signature: null })).mode).toBe('isles');
    expect(parseRelateRecord(JSON.stringify({ mode: 'relate', positions: { a: ['1', 2] } })).positions).toBeNull();
  });

  it('settles again when what pulls on the layout changes', () => {
    const { nodes, springs } = book();
    const signature = relateSpringSignature(nodes, springs);
    expect(relateSpringSignature(nodes, [...springs].reverse())).toBe(signature);
    expect(relateSpringSignature(nodes, springs.slice(1))).not.toBe(signature);
    expect(relateSpringSignature(nodes.slice(1), springs)).not.toBe(signature);
  });

  it('keeps a few hundred elements apart within the same run, a protagonist with thirty relations among them', () => {
    const { nodes, springs } = book(300, 10);
    const simulation = createRelateSimulation({ nodes, springs, start: fromAnchors(nodes), pins: new Map(), aspect: 1.6, alpha: 1 });
    expect(settleRelate(simulation)).toBeLessThan(RELATE_TICKS + 5);
    expect(overlaps(nodes, relatePositions(simulation))).toBe(0);
  });
});
