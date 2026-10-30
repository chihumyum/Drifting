import { defaultActName, sortActs, type BookAct } from '../../../domain/book-act';
import { CHAPTER_ORDER_STRIDE, type BookNode } from '../../../domain/book-node';
import type { TimelineMarker } from '../../../domain/timeline-marker';
import type { DbExecutor } from '../../../lib/db';
import { createBookActRepository } from '../../../sqlite-repo/book-act-repo';
import { createBookNodeSqliteRepository } from '../../../sqlite-repo/node-repo';
import { createTimelineMarkerRepository } from '../../../sqlite-repo/timeline-marker-repo';
import { useDataStore } from '../../../store/data-store';
import { deterministicAgentEntityId } from './entity-write-revision';
import {
  WorkbenchNoChangeError,
  optionalText,
  requiredText,
  sameAuthoredName,
  type WorkbenchApplyInput,
  type WorkbenchCommand,
  type WorkbenchScope,
} from './drifting-workbench-types';

/**
 * The book structure as one scope: every chapter's reading position
 * (`bookOrder`), every chapter's and idea's place on the narrative timeline
 * (`narrativeOrder`), the acts (boundaries on the reading axis) and the
 * timeline markers (labels on the narrative axis). Titles and prose are not
 * part of the image, so renaming or writing never makes a structure write
 * stale; the Agent moves things by name and the runtime picks coordinates.
 */
export interface StructureNode {
  id: string;
  kind: 'chapter' | 'drift';
  bookOrder: number | null;
  narrativeOrder: number | null;
}

export interface StructureAct {
  id: string;
  name: string;
  color: string | null;
  startOrder: number | null;
  driftNodeId: string | null;
  createdAt: string;
}

export interface StructureMarker {
  id: string;
  label: string;
  narrativeOrder: number;
  driftNodeId: string | null;
  createdAt: string;
}

export interface BookStructureState {
  nodes: StructureNode[];
  acts: StructureAct[];
  markers: StructureMarker[];
}

const byId = <T extends { id: string }>(left: T, right: T) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

async function loadStructure(db: DbExecutor, projectId: string): Promise<BookStructureState> {
  const [nodes, acts, markers] = await Promise.all([
    createBookNodeSqliteRepository(projectId, db).findAll(),
    createBookActRepository(projectId, db).findAll(),
    createTimelineMarkerRepository(projectId, db).findAll(),
  ]);
  return {
    nodes: nodes
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        bookOrder: node.kind === 'chapter' ? node.bookOrder : null,
        narrativeOrder: node.narrativeOrder,
      }))
      .sort(byId),
    acts: acts
      .map((act) => ({
        id: act.id,
        name: act.name,
        color: act.color,
        startOrder: act.startOrder,
        driftNodeId: act.driftNodeId,
        createdAt: act.createdAt,
      }))
      .sort(byId),
    markers: markers
      .map((marker) => ({
        id: marker.id,
        label: marker.label,
        narrativeOrder: marker.narrativeOrder,
        driftNodeId: marker.driftNodeId,
        createdAt: marker.createdAt,
      }))
      .sort(byId),
  };
}

async function applyStructure(tx: DbExecutor, input: WorkbenchApplyInput<BookStructureState>): Promise<void> {
  const { projectId, from, to, at, changes, journal } = input;
  const append = (
    entityType: 'node' | 'bookAct' | 'timelineMarker',
    mutationType: 'create' | 'update' | 'delete',
    entityId: string,
    payload?: Record<string, unknown>,
  ) => journal.appendDomainMutation(changes, { entityType, mutationType, entityId, projectId, ...(payload ? { payload } : {}) });

  const nodeRepo = createBookNodeSqliteRepository(projectId, tx);
  const fromNodes = new Map(from.nodes.map((node) => [node.id, node]));
  if (from.nodes.length !== to.nodes.length || to.nodes.some((node) => !fromNodes.has(node.id))) {
    throw new Error('章节或构想在这次调整中途增删了；重新读取结构后再试');
  }
  for (const node of to.nodes) {
    const before = fromNodes.get(node.id)!;
    const patch: { bookOrder?: number | null; narrativeOrder?: number | null } = {};
    if (before.bookOrder !== node.bookOrder) patch.bookOrder = node.bookOrder;
    if (before.narrativeOrder !== node.narrativeOrder) patch.narrativeOrder = node.narrativeOrder;
    if (Object.keys(patch).length === 0) continue;
    const persisted = await nodeRepo.update(node.id, { ...patch, updatedAt: at });
    if (!persisted) throw new Error('该章节或构想已不存在');
    append('node', 'update', node.id, patch);
  }

  const actRepo = createBookActRepository(projectId, tx);
  const fromActs = new Map(from.acts.map((act) => [act.id, act]));
  const toActs = new Map(to.acts.map((act) => [act.id, act]));
  for (const act of to.acts) {
    const before = fromActs.get(act.id);
    if (!before) {
      const row: BookAct = { ...act, projectId, updatedAt: at };
      await actRepo.create(row);
      append('bookAct', 'create', act.id, {
        id: act.id,
        name: act.name,
        color: act.color,
        startOrder: act.startOrder,
        driftNodeId: act.driftNodeId,
        createdAt: act.createdAt,
        updatedAt: at,
      });
      continue;
    }
    const patch: Partial<Pick<BookAct, 'name' | 'color' | 'startOrder' | 'driftNodeId'>> = {};
    if (before.name !== act.name) patch.name = act.name;
    if (before.color !== act.color) patch.color = act.color;
    if (before.startOrder !== act.startOrder) patch.startOrder = act.startOrder;
    if (before.driftNodeId !== act.driftNodeId) patch.driftNodeId = act.driftNodeId;
    if (Object.keys(patch).length === 0) continue;
    await actRepo.update(act.id, { ...patch, updatedAt: at });
    append('bookAct', 'update', act.id, { ...patch, updatedAt: at });
  }
  for (const act of from.acts) {
    if (toActs.has(act.id)) continue;
    await actRepo.delete(act.id);
    append('bookAct', 'delete', act.id);
  }

  const markerRepo = createTimelineMarkerRepository(projectId, tx);
  const fromMarkers = new Map(from.markers.map((marker) => [marker.id, marker]));
  const toMarkers = new Map(to.markers.map((marker) => [marker.id, marker]));
  for (const marker of to.markers) {
    const before = fromMarkers.get(marker.id);
    if (!before) {
      const row: TimelineMarker = { ...marker, projectId, updatedAt: at };
      await markerRepo.create(row);
      append('timelineMarker', 'create', marker.id, {
        id: marker.id,
        narrativeOrder: marker.narrativeOrder,
        label: marker.label,
        driftNodeId: marker.driftNodeId,
        createdAt: marker.createdAt,
        updatedAt: at,
      });
      continue;
    }
    const patch: Partial<Pick<TimelineMarker, 'label' | 'narrativeOrder' | 'driftNodeId'>> = {};
    if (before.label !== marker.label) patch.label = marker.label;
    if (before.narrativeOrder !== marker.narrativeOrder) patch.narrativeOrder = marker.narrativeOrder;
    if (before.driftNodeId !== marker.driftNodeId) patch.driftNodeId = marker.driftNodeId;
    if (Object.keys(patch).length === 0) continue;
    await markerRepo.update(marker.id, { ...patch, updatedAt: at });
    append('timelineMarker', 'update', marker.id, { ...patch, updatedAt: at });
  }
  for (const marker of from.markers) {
    if (toMarkers.has(marker.id)) continue;
    await markerRepo.delete(marker.id);
    append('timelineMarker', 'delete', marker.id);
  }
}

async function projectStructure(projectId: string): Promise<void> {
  const [nodes, acts, markers] = await Promise.all([
    createBookNodeSqliteRepository(projectId).findAll(),
    createBookActRepository(projectId).findAll(),
    createTimelineMarkerRepository(projectId).findAll(),
  ]);
  const byNode = new Map(nodes.map((node) => [node.id, node]));
  useDataStore.setState((state) => ({
    bookNodes: state.bookNodes.map((node) => {
      const persisted = byNode.get(node.id);
      if (!persisted) return node;
      return {
        ...node,
        bookOrder: persisted.bookOrder,
        narrativeOrder: persisted.narrativeOrder,
        updatedAt: persisted.updatedAt,
      } as BookNode;
    }),
  }));
  const state = useDataStore.getState();
  state.setBookActs(acts);
  state.setTimelineMarkers(markers);
}

export const BOOK_STRUCTURE_SCOPE: WorkbenchScope<BookStructureState> = {
  kind: 'book_structure',
  readTool: 'read_book_structure',
  readArguments: () => ({}),
  load: (db, projectId) => loadStructure(db, projectId),
  apply: applyStructure,
  project: (projectId) => projectStructure(projectId),
};

// ---- Names, the only thing the Agent passes --------------------------------

interface NamedNode {
  id: string;
  kind: 'chapter' | 'drift';
  title: string;
}

function namedNodes(projectId: string): NamedNode[] {
  return useDataStore
    .getState()
    .bookNodes.filter((node) => node.projectId === projectId)
    .map((node) => ({ id: node.id, kind: node.kind, title: node.title }));
}

function resolveNode(
  projectId: string,
  value: unknown,
  field: string,
  kind?: 'chapter' | 'drift',
): NamedNode {
  const reference = stripPrefix(requiredText(value, field)).name;
  const nodes = namedNodes(projectId).filter((node) => !kind || node.kind === kind);
  const direct = nodes.find((node) => node.id === reference);
  if (direct) return direct;
  const matches = nodes.filter((node) => sameAuthoredName(node.title, reference));
  if (matches.length === 1) return matches[0]!;
  const noun = kind === 'drift' ? '构想' : kind === 'chapter' ? '章节' : '章节或构想';
  if (matches.length > 1) throw new Error(`有 ${matches.length} 个${noun}都叫「${reference}」`);
  throw new Error(`没有名为「${reference}」的${noun}`);
}

function resolveAct(state: BookStructureState, value: unknown, field = 'act'): StructureAct {
  const reference = requiredText(value, field);
  const direct = state.acts.find((act) => act.id === reference);
  if (direct) return direct;
  const matches = state.acts.filter((act) => sameAuthoredName(act.name, reference));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`有 ${matches.length} 幕都叫「${reference}」`);
  throw new Error(`没有名为「${reference}」的幕；用 read_book_structure 查看`);
}

function resolveMarker(state: BookStructureState, projectId: string, value: unknown, field = 'marker'): StructureMarker {
  const reference = stripPrefix(requiredText(value, field)).name;
  const direct = state.markers.find((marker) => marker.id === reference);
  if (direct) return direct;
  const matches = state.markers.filter((marker) => sameAuthoredName(markerLabel(marker, projectId), reference));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`有 ${matches.length} 个时间刻度都叫「${reference}」`);
  throw new Error(`没有名为「${reference}」的时间刻度；用 read_book_structure 查看`);
}

/** A marker bound to an idea is captioned by that idea's title. */
export function markerLabel(marker: Pick<StructureMarker, 'label' | 'driftNodeId'>, projectId: string): string {
  if (marker.driftNodeId) {
    const drift = namedNodes(projectId).find((node) => node.id === marker.driftNodeId);
    if (drift) return drift.title;
  }
  return marker.label;
}

const PREFIXES: ReadonlyArray<[string, 'chapter' | 'drift' | 'marker']> = [
  ['章节:', 'chapter'],
  ['章节：', 'chapter'],
  ['构想:', 'drift'],
  ['构想：', 'drift'],
  ['刻度:', 'marker'],
  ['刻度：', 'marker'],
];

function stripPrefix(value: string): { kind?: 'chapter' | 'drift' | 'marker'; name: string } {
  for (const [prefix, kind] of PREFIXES) {
    if (value.startsWith(prefix)) return { kind, name: value.slice(prefix.length).trim() };
  }
  return { name: value };
}

/** A point on the narrative axis: a placed chapter or idea, or a marker. */
interface AxisAnchor {
  kind: 'chapter' | 'drift' | 'marker';
  id: string;
  label: string;
  order: number;
}

function resolveAxisAnchor(state: BookStructureState, projectId: string, value: unknown, field: string): AxisAnchor {
  const raw = requiredText(value, field);
  const { kind, name } = stripPrefix(raw);
  const candidates: AxisAnchor[] = [];
  if (kind !== 'marker') {
    for (const node of namedNodes(projectId)) {
      if (kind && node.kind !== kind) continue;
      if (node.id !== name && !sameAuthoredName(node.title, name)) continue;
      const order = state.nodes.find((entry) => entry.id === node.id)?.narrativeOrder ?? null;
      if (order === null) {
        throw new Error(`「${node.title}」还没有放上叙事时间线，不能作为参照`);
      }
      candidates.push({ kind: node.kind, id: node.id, label: node.title, order });
    }
  }
  if (!kind || kind === 'marker') {
    for (const marker of state.markers) {
      const label = markerLabel(marker, projectId);
      if (marker.id === name || sameAuthoredName(label, name)) {
        candidates.push({ kind: 'marker', id: marker.id, label, order: marker.narrativeOrder });
      }
    }
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new Error(`「${name}」同时指向多处；写成「章节:${name}」「构想:${name}」或「刻度:${name}」`);
  }
  throw new Error(`叙事时间线上没有「${name}」`);
}

// ---- Coordinates ------------------------------------------------------------

function between(low: number, high: number): number {
  const middle = low + (high - low) / 2;
  if (!(middle > low && middle < high)) {
    throw new Error('这里已经没有可插入的位置；请作者先在时间线上“打散”后再试');
  }
  return middle;
}

/** Narrative positions of everything except `exceptId`. */
function axisOrders(state: BookStructureState, exceptId?: string): number[] {
  return [
    ...state.nodes.filter((node) => node.id !== exceptId && node.narrativeOrder !== null).map((node) => node.narrativeOrder!),
    ...state.markers.filter((marker) => marker.id !== exceptId).map((marker) => marker.narrativeOrder),
  ].sort((left, right) => left - right);
}

function narrativePosition(
  state: BookStructureState,
  projectId: string,
  args: Readonly<Record<string, unknown>>,
  movingId: string | undefined,
): { order: number; description: string } {
  const after = optionalText(args.after);
  const before = optionalText(args.before);
  if (Boolean(after) === Boolean(before)) throw new Error('after 和 before 必须且只能给一个');
  const anchor = resolveAxisAnchor(state, projectId, after ?? before, after ? 'after' : 'before');
  if (anchor.id === movingId) throw new Error('不能以自己为参照');
  const orders = axisOrders(state, movingId);
  if (after) {
    const next = orders.find((order) => order > anchor.order);
    return {
      order: next === undefined ? anchor.order + CHAPTER_ORDER_STRIDE : between(anchor.order, next),
      description: `「${anchor.label}」之后`,
    };
  }
  const previous = [...orders].reverse().find((order) => order < anchor.order);
  return {
    order: previous === undefined ? anchor.order - CHAPTER_ORDER_STRIDE : between(previous, anchor.order),
    description: `「${anchor.label}」之前`,
  };
}

interface ReadingChapter {
  id: string;
  order: number;
}

function readingChapters(state: BookStructureState, exceptId?: string): ReadingChapter[] {
  return state.nodes
    .filter((node) => node.kind === 'chapter' && node.id !== exceptId && node.bookOrder !== null)
    .map((node) => ({ id: node.id, order: node.bookOrder! }))
    .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : 1));
}

function finiteBoundaries(state: BookStructureState, exceptActId?: string): number[] {
  return state.acts
    .filter((act) => act.id !== exceptActId && act.startOrder !== null)
    .map((act) => act.startOrder!)
    .sort((left, right) => left - right);
}

/** The act covering `order`, by the same rule as domain/book-act.ts. */
function actAt(state: BookStructureState, order: number, exceptActId?: string): StructureAct | null {
  let match: StructureAct | null = null;
  for (const act of sortActs(state.acts.filter((entry) => entry.id !== exceptActId) as BookAct[])) {
    if ((act.startOrder ?? Number.NEGATIVE_INFINITY) <= order) match = act;
    else break;
  }
  return match;
}

/** A reading position that stays inside the act its neighbor belongs to. */
function readingPosition(
  state: BookStructureState,
  projectId: string,
  args: Readonly<Record<string, unknown>>,
  movingId: string,
): { order: number; description: string } {
  const given = ['after', 'before', 'act'].filter((key) => optionalText(args[key]));
  if (given.length !== 1) throw new Error('after、before、act 必须且只能给一个');
  const chapters = readingChapters(state, movingId);
  const boundaries = finiteBoundaries(state);
  if (optionalText(args.act)) {
    const act = resolveAct(state, args.act);
    const start = act.startOrder ?? Number.NEGATIVE_INFINITY;
    const end = boundaries.find((boundary) => boundary > start) ?? Number.POSITIVE_INFINITY;
    const members = chapters.filter((chapter) => chapter.order >= start && chapter.order < end);
    const last = members[members.length - 1];
    const low = last ? last.order : start;
    if (low === Number.NEGATIVE_INFINITY) {
      const first = end === Number.POSITIVE_INFINITY ? 0 : end;
      return { order: first - CHAPTER_ORDER_STRIDE / 2, description: `「${act.name}」末尾` };
    }
    const order =
      end === Number.POSITIVE_INFINITY
        ? low + CHAPTER_ORDER_STRIDE
        : last
          ? between(low, end)
          : low;
    return { order, description: `「${act.name}」末尾` };
  }
  const after = optionalText(args.after);
  const anchor = resolveNode(projectId, after ?? args.before, after ? 'after' : 'before', 'chapter');
  if (anchor.id === movingId) throw new Error('不能以自己为参照');
  const anchorOrder = chapters.find((chapter) => chapter.id === anchor.id)?.order;
  if (anchorOrder === undefined) throw new Error(`「${anchor.title}」不在阅读顺序里`);
  if (after) {
    const next = chapters.find((chapter) => chapter.order > anchorOrder)?.order ?? Number.POSITIVE_INFINITY;
    const boundary = boundaries.find((value) => value > anchorOrder) ?? Number.POSITIVE_INFINITY;
    const high = Math.min(next, boundary);
    return {
      order: high === Number.POSITIVE_INFINITY ? anchorOrder + CHAPTER_ORDER_STRIDE : between(anchorOrder, high),
      description: `「${anchor.title}」之后`,
    };
  }
  const previous = [...chapters].reverse().find((chapter) => chapter.order < anchorOrder)?.order;
  const own = actAt(state, anchorOrder)?.startOrder ?? null;
  const floor = own !== null && own < anchorOrder ? own : null;
  if (own !== null && own === anchorOrder) {
    throw new Error(`「${anchor.title}」正好在幕的起点上；改用 after 或 act 指定位置`);
  }
  const low = Math.max(previous ?? Number.NEGATIVE_INFINITY, floor ?? Number.NEGATIVE_INFINITY);
  return {
    order: low === Number.NEGATIVE_INFINITY ? anchorOrder - CHAPTER_ORDER_STRIDE : between(low, anchorOrder),
    description: `「${anchor.title}」之前`,
  };
}

/** A boundary just before `chapter`, or after every chapter for an empty act. */
function boundaryBefore(state: BookStructureState, chapterId: string | null, exceptActId?: string): number {
  const chapters = readingChapters(state);
  const taken = new Set(finiteBoundaries(state, exceptActId));
  let order: number;
  if (chapterId) {
    const index = chapters.findIndex((chapter) => chapter.id === chapterId);
    if (index < 0) throw new Error('该章节不在阅读顺序里');
    const chapter = chapters[index]!;
    const previous = chapters[index - 1];
    order = previous ? between(previous.order, chapter.order) : chapter.order - CHAPTER_ORDER_STRIDE / 2;
  } else {
    const last = chapters[chapters.length - 1]?.order ?? 0;
    const lastBoundary = [...taken].sort((left, right) => left - right).pop() ?? Number.NEGATIVE_INFINITY;
    order = Math.max(last, lastBoundary) + CHAPTER_ORDER_STRIDE / 2;
  }
  if (taken.has(order)) throw new Error('那里已经有一个幕的起点');
  return order;
}

// ---- Commands ---------------------------------------------------------------

const projectScope = (projectId: string) => projectId;

function replaceNode(state: BookStructureState, id: string, patch: Partial<StructureNode>): BookStructureState {
  return { ...state, nodes: state.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) };
}

function withAct(state: BookStructureState, act: StructureAct): BookStructureState {
  return { ...state, acts: [...state.acts.filter((entry) => entry.id !== act.id), act].sort(byId) };
}

function withMarker(state: BookStructureState, marker: StructureMarker): BookStructureState {
  return { ...state, markers: [...state.markers.filter((entry) => entry.id !== marker.id), marker].sort(byId) };
}

interface RestoredRowExtra {
  deletedId: string;
  restoredId: string;
}

const createAct: WorkbenchCommand<BookStructureState> = {
  name: 'create_act',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const first = optionalText(args.firstChapter) ? resolveNode(projectId, args.firstChapter, 'firstChapter', 'chapter') : null;
    const startOrder = boundaryBefore(state, first?.id ?? null);
    const position = sortActs(state.acts as BookAct[]).filter(
      (act) => (act.startOrder ?? Number.NEGATIVE_INFINITY) < startOrder,
    ).length + 1;
    const name = optionalText(args.name) || defaultActName(position);
    if (state.acts.some((act) => sameAuthoredName(act.name, name))) throw new Error(`已经有名为「${name}」的幕`);
    return {
      arguments: { name, firstChapterId: first?.id ?? null },
      path: `/structure/acts/${name}`,
      changeSummary: first ? `新建「${name}」，从「${first.title}」开始` : `在全书末尾新建空的「${name}」`,
    };
  },
  async plan(state, args, context) {
    const name = requiredText(args.name, 'name');
    const startOrder = boundaryBefore(state, (args.firstChapterId as string | null | undefined) ?? null);
    const id = await deterministicAgentEntityId(context.idempotencyKey, 'book_act');
    return { next: withAct(state, { id, name, color: null, startOrder, driftNodeId: null, createdAt: context.at }) };
  },
};

const updateAct: WorkbenchCommand<BookStructureState> = {
  name: 'update_act',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const act = resolveAct(state, args.act);
    const name = optionalText(args.name) || act.name;
    if (name !== act.name && state.acts.some((entry) => entry.id !== act.id && sameAuthoredName(entry.name, name))) {
      throw new Error(`已经有名为「${name}」的幕`);
    }
    const first = optionalText(args.firstChapter) ? resolveNode(projectId, args.firstChapter, 'firstChapter', 'chapter') : null;
    if (name === act.name && !first) throw new WorkbenchNoChangeError(`「${act.name}」`);
    const parts = [
      ...(name !== act.name ? [`改名为「${name}」`] : []),
      ...(first ? [`改为从「${first.title}」开始`] : []),
    ];
    return {
      arguments: { actId: act.id, name, firstChapterId: first?.id ?? null },
      path: `/structure/acts/${name}`,
      changeSummary: `「${act.name}」${parts.join('，')}`,
    };
  },
  async plan(state, args) {
    const act = state.acts.find((entry) => entry.id === args.actId);
    if (!act) throw new Error('这一幕已不存在');
    const firstChapterId = (args.firstChapterId as string | null | undefined) ?? null;
    const startOrder = firstChapterId ? boundaryBefore(state, firstChapterId, act.id) : act.startOrder;
    const next = { ...act, name: requiredText(args.name, 'name'), startOrder };
    if (next.name === act.name && next.startOrder === act.startOrder) throw new WorkbenchNoChangeError(`「${act.name}」`);
    return { next: withAct(state, next) };
  },
};

const deleteAct: WorkbenchCommand<BookStructureState> = {
  name: 'delete_act',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args) {
    const act = resolveAct(state, args.act);
    return {
      arguments: { actId: act.id },
      path: `/structure/acts/${act.name}`,
      changeSummary: `删除「${act.name}」这条分幕线；章节和它们的顺序不变`,
    };
  },
  async plan(state, args, context) {
    const act = state.acts.find((entry) => entry.id === args.actId);
    if (!act) throw new Error('这一幕已不存在');
    return {
      next: { ...state, acts: state.acts.filter((entry) => entry.id !== act.id) },
      extra: {
        deletedId: act.id,
        restoredId: await deterministicAgentEntityId(context.idempotencyKey, 'book_act_restore'),
      } satisfies RestoredRowExtra,
    };
  },
  inverseImage(before, extra) {
    const { deletedId, restoredId } = extra as RestoredRowExtra;
    return {
      ...before,
      acts: before.acts.map((act) => (act.id === deletedId ? { ...act, id: restoredId } : act)).sort(byId),
    };
  },
};

const moveChapter: WorkbenchCommand<BookStructureState> = {
  name: 'move_chapter',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const chapter = resolveNode(projectId, args.chapter, 'chapter', 'chapter');
    const position = readingPosition(state, projectId, args, chapter.id);
    const resolved: Record<string, unknown> = { chapterId: chapter.id };
    for (const key of ['after', 'before'] as const) {
      const value = optionalText(args[key]);
      if (value) resolved[`${key}Id`] = resolveNode(projectId, value, key, 'chapter').id;
    }
    if (optionalText(args.act)) resolved.actId = resolveAct(state, args.act).id;
    return {
      arguments: resolved,
      path: `/chapters/${chapter.title}`,
      changeSummary: `把「${chapter.title}」移到${position.description}`,
    };
  },
  async plan(state, args, context) {
    const chapterId = requiredText(args.chapterId, 'chapterId');
    const current = state.nodes.find((node) => node.id === chapterId && node.kind === 'chapter');
    if (!current) throw new Error('该章节已不存在');
    const order = readingPosition(
      state,
      context.projectId,
      {
        ...(args.afterId ? { after: args.afterId } : {}),
        ...(args.beforeId ? { before: args.beforeId } : {}),
        ...(args.actId ? { act: args.actId } : {}),
      },
      chapterId,
    ).order;
    if (order === current.bookOrder) throw new WorkbenchNoChangeError('章节位置');
    return { next: replaceNode(state, chapterId, { bookOrder: order }) };
  },
};

const setTimelinePosition: WorkbenchCommand<BookStructureState> = {
  name: 'set_timeline_position',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const item = resolveNode(projectId, args.item, 'item', stripPrefix(requiredText(args.item, 'item')).kind as 'chapter' | 'drift' | undefined);
    const current = state.nodes.find((node) => node.id === item.id)!;
    if (args.remove === true) {
      if (optionalText(args.after) || optionalText(args.before)) throw new Error('remove 不能和 after/before 一起使用');
      if (current.narrativeOrder === null) throw new WorkbenchNoChangeError(`「${item.title}」`);
      return {
        arguments: { nodeId: item.id, remove: true },
        path: `/timeline/${item.title}`,
        changeSummary: `把「${item.title}」从叙事时间线上拿下`,
      };
    }
    const position = narrativePosition(state, projectId, args, item.id);
    const anchor = resolveAxisAnchor(state, projectId, optionalText(args.after) ?? args.before, 'anchor');
    return {
      arguments: { nodeId: item.id, anchorId: anchor.id, anchorKind: anchor.kind, side: optionalText(args.after) ? 'after' : 'before' },
      path: `/timeline/${item.title}`,
      changeSummary: `把「${item.title}」放到叙事时间线上${position.description}`,
    };
  },
  async plan(state, args, context) {
    const nodeId = requiredText(args.nodeId, 'nodeId');
    const current = state.nodes.find((node) => node.id === nodeId);
    if (!current) throw new Error('该章节或构想已不存在');
    if (args.remove === true) {
      if (current.narrativeOrder === null) throw new WorkbenchNoChangeError('叙事位置');
      return { next: replaceNode(state, nodeId, { narrativeOrder: null }) };
    }
    const anchor = `${args.anchorKind === 'marker' ? '刻度' : args.anchorKind === 'drift' ? '构想' : '章节'}:${String(args.anchorId)}`;
    const order = narrativePosition(state, context.projectId, { [String(args.side)]: anchor }, nodeId).order;
    if (order === current.narrativeOrder) throw new WorkbenchNoChangeError('叙事位置');
    return { next: replaceNode(state, nodeId, { narrativeOrder: order }) };
  },
};

function markerAnchorArguments(state: BookStructureState, projectId: string, args: Readonly<Record<string, unknown>>) {
  const anchor = resolveAxisAnchor(state, projectId, optionalText(args.after) ?? args.before, 'anchor');
  return { anchorId: anchor.id, anchorKind: anchor.kind, side: optionalText(args.after) ? 'after' : 'before' };
}

function plannedAnchor(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const prefix = args.anchorKind === 'marker' ? '刻度' : args.anchorKind === 'drift' ? '构想' : '章节';
  return { [String(args.side)]: `${prefix}:${String(args.anchorId)}` };
}

const createTimelineMarker: WorkbenchCommand<BookStructureState> = {
  name: 'create_timeline_marker',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const label = requiredText(args.label, 'label');
    const position = narrativePosition(state, projectId, args, undefined);
    return {
      arguments: { label, ...markerAnchorArguments(state, projectId, args) },
      path: `/timeline/markers/${label}`,
      changeSummary: `在叙事时间线上${position.description}加时间刻度「${label}」`,
    };
  },
  async plan(state, args, context) {
    const order = narrativePosition(state, context.projectId, plannedAnchor(args), undefined).order;
    const id = await deterministicAgentEntityId(context.idempotencyKey, 'timeline_marker');
    return {
      next: withMarker(state, {
        id,
        label: requiredText(args.label, 'label'),
        narrativeOrder: order,
        driftNodeId: null,
        createdAt: context.at,
      }),
    };
  },
};

const updateTimelineMarker: WorkbenchCommand<BookStructureState> = {
  name: 'update_timeline_marker',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const marker = resolveMarker(state, projectId, args.marker);
    const current = markerLabel(marker, projectId);
    const label = optionalText(args.label);
    const moves = Boolean(optionalText(args.after) || optionalText(args.before));
    if (marker.driftNodeId && label) throw new Error(`「${current}」的标题来自它绑定的构想；改那个构想的标题即可`);
    if ((!label || label === marker.label) && !moves) throw new WorkbenchNoChangeError(`时间刻度「${current}」`);
    const position = moves ? narrativePosition(state, projectId, args, marker.id) : null;
    return {
      arguments: {
        markerId: marker.id,
        label: label || marker.label,
        ...(moves ? markerAnchorArguments(state, projectId, args) : {}),
      },
      path: `/timeline/markers/${label || current}`,
      changeSummary: [
        label && label !== marker.label ? `时间刻度「${current}」改为「${label}」` : `时间刻度「${current}」`,
        position ? `移到${position.description}` : '',
      ].join(''),
    };
  },
  async plan(state, args, context) {
    const marker = state.markers.find((entry) => entry.id === args.markerId);
    if (!marker) throw new Error('该时间刻度已不存在');
    const order = args.anchorId
      ? narrativePosition(state, context.projectId, plannedAnchor(args), marker.id).order
      : marker.narrativeOrder;
    const next = { ...marker, label: String(args.label ?? marker.label), narrativeOrder: order };
    if (next.label === marker.label && next.narrativeOrder === marker.narrativeOrder) {
      throw new WorkbenchNoChangeError('时间刻度');
    }
    return { next: withMarker(state, next) };
  },
};

const deleteTimelineMarker: WorkbenchCommand<BookStructureState> = {
  name: 'delete_timeline_marker',
  scope: BOOK_STRUCTURE_SCOPE,
  scopeId: projectScope,
  resolve(state, args, projectId) {
    const marker = resolveMarker(state, projectId, args.marker);
    const label = markerLabel(marker, projectId);
    return {
      arguments: { markerId: marker.id },
      path: `/timeline/markers/${label}`,
      changeSummary: marker.driftNodeId
        ? `删除时间刻度「${label}」；它绑定的构想回到构想面板`
        : `删除时间刻度「${label}」`,
    };
  },
  async plan(state, args, context) {
    const marker = state.markers.find((entry) => entry.id === args.markerId);
    if (!marker) throw new Error('该时间刻度已不存在');
    return {
      next: { ...state, markers: state.markers.filter((entry) => entry.id !== marker.id) },
      extra: {
        deletedId: marker.id,
        restoredId: await deterministicAgentEntityId(context.idempotencyKey, 'timeline_marker_restore'),
      } satisfies RestoredRowExtra,
    };
  },
  inverseImage(before, extra) {
    const { deletedId, restoredId } = extra as RestoredRowExtra;
    return {
      ...before,
      markers: before.markers.map((marker) => (marker.id === deletedId ? { ...marker, id: restoredId } : marker)).sort(byId),
    };
  },
};

export const BOOK_STRUCTURE_COMMANDS = [
  createAct,
  updateAct,
  deleteAct,
  moveChapter,
  setTimelinePosition,
  createTimelineMarker,
  updateTimelineMarker,
  deleteTimelineMarker,
] as const;
