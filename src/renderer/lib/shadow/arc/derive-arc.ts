// Element Arc engine — the READ pipeline. Derives an element's cross-chapter
// trajectory from prose via a deterministic distillation tree:
//
//   work-list → LEAF (per appearance, parallel) → DISTILL (per segment) → SYNTHESIZE → ArcMap
//
// All three stages are plain structured LLM calls (callStructured), wired by this
// orchestrator — NOT autonomous agents (the orchestrator already knows everything
// to feed each call). The pure helpers (buildAppearances / groupAppearances /
// assembleArcMap) carry the deterministic logic and are unit-tested without an LLM
// or DB; the LLM/DB live behind ArcEngineDeps so the orchestration is testable with
// fakes. See domain/element-arc.ts and lib/shadow/ELEMENT-ARC.md.
import type { Static } from '@sinclair/typebox';
import loglevel from 'loglevel';
import { buildDefaultLLMClient } from '../../ai/client/build-default-client';
import { callStructured } from '../../ai/call-structured';
import { AIError } from '../../ai/types';
import { resolveWritingLanguage } from '../../ai/output-language';
import { arcLeafPrompt } from '../../ai/prompts/templates/arc-leaf';
import { arcDistillPrompt } from '../../ai/prompts/templates/arc-distill';
import { arcSynthesizePrompt } from '../../ai/prompts/templates/arc-synthesize';
import { docToBlocks, docToPlainText, type DocBlock } from '../../agent/serialize';
import { parseKv } from '../../../domain/kv';
import { createBookElementSqliteRepository } from '../../../sqlite-repo/element-repo';
import { createBookNodeSqliteRepository } from '../../../sqlite-repo/node-repo';
import { createBookContentRepository } from '../../../sqlite-repo/content-repo';
import { createInlineMentionRepository } from '../../../sqlite-repo/inline-mention-repo';
import { createElementPatchRepository } from '../../../sqlite-repo/element-patch-repo';
import { createElementCategoryRepository } from '../../../sqlite-repo/element-category-repo';
import type {
  ArcAppearance,
  ArcLeaf,
  ArcMap,
  ArcPatchInput,
  ArcSegment,
} from '../../../domain/element-arc';

type LeafOut = Static<typeof arcLeafPrompt.output>;
type DistillOut = Static<typeof arcDistillPrompt.output>;
type SynthOut = Static<typeof arcSynthesizePrompt.output>;

// Up to ~this many appearances per segment before the orchestrator adds another
// reduction group. Keeps each distill call's input small. Adaptive: numSegments =
// ceil(N / GROUP_SIZE), so a 12-chapter element folds to 1 group, a 40-chapter one
// to several. (Stacking >1 reduction LEVEL is a later refinement; v1 is leaf→seg→top.)
const GROUP_SIZE = 4;
const DEFAULT_CONCURRENCY = 4;

// Arc runs flash + THINKING mode. flash WITHOUT thinking returns invalid JSON for
// ~40% of these prose-heavy structured calls (measured: leaf 6/16, distill 2/5 —
// equal across stages, so it's model-bound, not input size). A reasoning pass before
// the tool call makes the output far more disciplined; DeepSeek-V3.2+ supports tool
// calls in thinking mode, so it composes with the forced-tool-call mechanism (single
// shot → no reasoning_content round-trip to worry about). Arc is low-freq + manual,
// so the extra reasoning cost is fine. (Bump ARC_MODEL to -pro if flash still slips.)
const ARC_MODEL = 'deepseek-v4-flash';
const ARC_THINKING = true;

const arcLog = loglevel.getLogger('arc');

// callStructured does NOT retry (by design — see its header). Weak models
// occasionally emit invalid JSON in a forced tool-call; a retry usually clears it.
// Retry only the transient kinds; never auth / invalid-input / aborted.
const RETRYABLE_KINDS: ReadonlySet<string> = new Set(['parse', 'rate-limit', 'network', 'unknown']);

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const kind = e instanceof AIError ? e.kind : 'unknown';
      if (!RETRYABLE_KINDS.has(kind) || i === attempts - 1) throw e;
      arcLog.warn(`[arc] ${label} 第 ${i + 1} 次失败（${kind}）— 重试`);
      await new Promise((r) => setTimeout(r, (i + 1) * 700));
    }
  }
  throw lastErr;
}

// The data + LLM access the orchestrator needs. Real wiring in createDefaultArcDeps;
// fakes injected in tests. Keeps deriveElementArc pure orchestration.
export interface ArcEngineDeps {
  loadElementCanon(elementId: string): Promise<{ name: string; canonText: string } | null>;
  loadAppearances(elementId: string): Promise<ArcAppearance[]>;
  loadProseBlocks(chapterId: string): Promise<DocBlock[]>;
  loadPatches(elementId: string): Promise<ArcPatchInput[]>;
  runLeaf(input: Static<typeof arcLeafPrompt.input>): Promise<LeafOut>;
  runDistill(input: Static<typeof arcDistillPrompt.input>): Promise<DistillOut>;
  runSynthesize(input: Static<typeof arcSynthesizePrompt.input>): Promise<SynthOut>;
  concurrency?: number;
}

// ── pure helpers (no I/O — unit-tested directly) ───────────────────────────────

// Backlinks (element ← chapters that mention it) + node order → an ordered, deduped
// appearance list. Drops nodes with no axis position (outline/unplaced); axis order
// = narrativeOrder ?? bookOrder. Mentions miss pronoun-only appearances (v1 limit).
export function buildAppearances(
  backlinks: { fromId: string; fromTitle: string }[],
  nodeOrder: Map<
    string,
    { title: string; narrativeOrder: number | null; bookOrder: number | null; finished: boolean }
  >,
  includeDrafts: boolean,
): ArcAppearance[] {
  const seen = new Set<string>();
  const apps: ArcAppearance[] = [];
  for (const bl of backlinks) {
    if (seen.has(bl.fromId)) continue;
    seen.add(bl.fromId);
    const node = nodeOrder.get(bl.fromId);
    if (!node) continue;
    // Default to finished-only: an arc is "the trajectory you committed to prose".
    // Drafts are in-flux — including them makes the derivation chase moving text.
    if (!includeDrafts && !node.finished) continue;
    const fromNarrative = node.narrativeOrder != null;
    const order = node.narrativeOrder ?? node.bookOrder;
    if (order == null) continue; // unplaced (outline etc.) — skip
    apps.push({ chapterId: bl.fromId, chapterTitle: node.title || bl.fromTitle, order, fromNarrative });
  }
  apps.sort((a, b) => a.order - b.order);
  return apps;
}

// Contiguous grouping for the distill level. numSegments = ceil(N / GROUP_SIZE);
// each group is a run of appearances labeled by its order span.
export function groupAppearances(apps: ArcAppearance[]): { label: string; indices: number[] }[] {
  if (apps.length === 0) return [];
  const numSegs = Math.max(1, Math.ceil(apps.length / GROUP_SIZE));
  const size = Math.ceil(apps.length / numSegs);
  const groups: { label: string; indices: number[] }[] = [];
  for (let start = 0; start < apps.length; start += size) {
    const indices: number[] = [];
    for (let j = start; j < Math.min(start + size, apps.length); j++) indices.push(j);
    const first = apps[indices[0]!]!.order;
    const last = apps[indices[indices.length - 1]!]!.order;
    groups.push({ label: first === last ? `n${first}` : `n${first}–n${last}`, indices });
  }
  return groups;
}

// Fold the LLM stage outputs + the work-list into the public ArcMap (pure).
export function assembleArcMap(
  elementId: string,
  elementName: string,
  apps: ArcAppearance[],
  synth: SynthOut,
  orderToChapter: Map<number, string>,
  skipped = 0,
): ArcMap {
  const axis = apps.some((a) => a.fromNarrative) ? 'narrativeOrder' : 'bookOrder';
  return {
    elementId,
    elementName,
    axis,
    narrative: synth.narrative,
    points: synth.points.map((p) => ({
      order: p.order,
      chapterId: orderToChapter.get(p.order) ?? '',
      label: p.label,
      state: p.state,
      motivation: p.motivation,
      confidence: p.confidence,
    })),
    tensions: synth.tensions.map((t) => ({
      kind: t.kind,
      note: t.note,
      orders: t.orders,
      chapterIds: t.orders.map((o) => orderToChapter.get(o) ?? ''),
    })),
    patchOverlay: synth.patchOverlay.map((o) => ({
      atOrder: o.atOrder,
      patchTitle: o.patchTitle,
      alignsWithDerived: o.alignsWithDerived,
      note: o.note,
    })),
    coverage: {
      appearances: apps.length,
      generatedAtOrder: apps.length ? apps[apps.length - 1]!.order : 0,
      skipped,
    },
  };
}

// Plain chapter text for the leaf prompt — block ids dropped (provenance is
// chapter-level now), which also shrinks the input the distill step must fold.
export function formatProse(blocks: DocBlock[]): string {
  return blocks
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join('\n');
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── orchestrator ───────────────────────────────────────────────────────────────

export interface DeriveArcOptions {
  deps?: ArcEngineDeps;
  // Default false → derive from FINISHED chapters only (stable prose). Toggle on to
  // include drafts for a "current full picture" pass.
  includeDrafts?: boolean;
  signal?: AbortSignal;
}

export async function deriveElementArc(
  elementId: string,
  projectId: string,
  opts: DeriveArcOptions = {},
): Promise<ArcMap> {
  const deps =
    opts.deps ?? createDefaultArcDeps(projectId, { includeDrafts: opts.includeDrafts, signal: opts.signal });
  const element = await deps.loadElementCanon(elementId);
  if (!element) throw new Error(`element not found: ${elementId}`);

  const apps = await deps.loadAppearances(elementId);
  const orderToChapter = new Map(apps.map((a) => [a.order, a.chapterId]));

  // Empty work-list → an empty ArcMap (no prose to derive from).
  if (apps.length === 0) {
    return assembleArcMap(
      elementId,
      element.name,
      apps,
      { narrative: '', points: [], tensions: [], patchOverlay: [] },
      orderToChapter,
      0,
    );
  }

  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  // LEAF — parallel, per appearance. A chapter whose extraction keeps failing
  // (e.g. the model repeatedly returns invalid JSON) is SKIPPED, not fatal: one
  // bad leaf must never kill the whole derivation. (deps.runLeaf already retries.)
  const leafResults = await mapLimit(apps, concurrency, async (app) => {
    try {
      const blocks = await deps.loadProseBlocks(app.chapterId);
      const out = await deps.runLeaf({
        canon: element.canonText,
        elementName: element.name,
        chapterTitle: app.chapterTitle,
        order: app.order,
        prose: formatProse(blocks),
      });
      const leaf: ArcLeaf = {
        chapterId: app.chapterId,
        chapterTitle: app.chapterTitle,
        order: app.order,
        oneLineState: out.oneLineState,
        observations: out.observations.map((o) => ({ text: o.text, signal: o.signal })),
        divergenceFromCanon: out.divergenceFromCanon.map((d) => ({ note: d.note })),
      };
      return { app, leaf };
    } catch (e) {
      arcLog.warn(
        `[arc] 跳过章节 n${app.order} ${app.chapterTitle}：${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  });

  const ok = leafResults.filter((x): x is { app: ArcAppearance; leaf: ArcLeaf } => x != null);
  const skipped = apps.length - ok.length;
  if (ok.length === 0) {
    throw new Error('所有章节的抽取都失败了（模型可能连续返回了非法 JSON，请重试或更换模型）');
  }
  const okApps = ok.map((x) => x.app);
  const leaves = ok.map((x) => x.leaf);

  // DISTILL — per contiguous segment of the SURVIVING appearances.
  const groups = groupAppearances(okApps);
  const segments: ArcSegment[] = await mapLimit(groups, concurrency, async (g) => {
    const groupLeaves = g.indices.map((i) => leaves[i]!);
    const out = await deps.runDistill({
      canon: element.canonText,
      segmentLabel: g.label,
      leavesJson: JSON.stringify(groupLeaves),
    });
    return {
      label: g.label,
      spanOrders: g.indices.map((i) => okApps[i]!.order),
      chapterIds: g.indices.map((i) => okApps[i]!.chapterId),
      subArc: out.subArc,
      trends: out.trends,
      motivations: out.motivations.map((m) => ({
        claim: m.claim,
        confidence: m.confidence,
        orders: m.orders,
      })),
    };
  });

  // SYNTHESIZE — top. Patches revealed only here (leaves/segments derived blind).
  const patches = await deps.loadPatches(elementId);
  const synth = await deps.runSynthesize({
    canon: element.canonText,
    elementName: element.name,
    segmentsJson: JSON.stringify(segments),
    patchesJson: JSON.stringify(patches),
  });

  return assembleArcMap(elementId, element.name, okApps, synth, orderToChapter, skipped);
}

// ── default (production) wiring ─────────────────────────────────────────────────

export interface ArcDepsOptions {
  includeDrafts?: boolean;
  signal?: AbortSignal;
}

export function createDefaultArcDeps(projectId: string, opts: ArcDepsOptions = {}): ArcEngineDeps {
  const includeDrafts = opts.includeDrafts ?? false;
  const signal = opts.signal;
  const elementRepo = createBookElementSqliteRepository(projectId);
  const nodeRepo = createBookNodeSqliteRepository(projectId);
  const contentRepo = createBookContentRepository();
  const mentionRepo = createInlineMentionRepository();
  const patchRepo = createElementPatchRepository();
  const categoryRepo = createElementCategoryRepository(projectId);
  const outputLanguage = resolveWritingLanguage(projectId);

  // Build the LLM client once, lazily, shared across all stage calls.
  let clientPromise: ReturnType<typeof buildDefaultLLMClient> | null = null;
  const getClient = () => (clientPromise ??= buildDefaultLLMClient());

  return {
    async loadElementCanon(elementId) {
      const el = await elementRepo.findById(elementId);
      if (!el) return null;
      // Category name de-characterizes the prompts: it tells the model whether this
      // is a person / object / place / org / concept so leaf+distill+synth adapt.
      let categoryName = '';
      if (el.categoryId) {
        const cats = await categoryRepo.findAll();
        categoryName = cats.find((c) => c.id === el.categoryId)?.name ?? '';
      }
      return {
        name: el.name,
        canonText: formatCanon(el.name, categoryName, el.summary, el.kvJson, el.contentJson),
      };
    },

    async loadAppearances(elementId) {
      const backlinks = await mentionRepo.listBacklinksToTarget('element', elementId);
      const distinct = [...new Map(backlinks.map((b) => [b.fromId, b])).values()];
      const nodeOrder = new Map<
        string,
        { title: string; narrativeOrder: number | null; bookOrder: number | null; finished: boolean }
      >();
      for (const bl of distinct) {
        const node = await nodeRepo.findById(bl.fromId);
        if (!node || node.kind !== 'chapter') continue; // arc is over chapter prose
        nodeOrder.set(bl.fromId, {
          title: node.title,
          narrativeOrder: node.narrativeOrder,
          bookOrder: node.bookOrder,
          finished: node.writingStatus === 'finished',
        });
      }
      return buildAppearances(distinct, nodeOrder, includeDrafts);
    },

    async loadProseBlocks(chapterId) {
      const content = await contentRepo.findByNodeId(chapterId);
      return docToBlocks(content?.contentJson ?? '{}');
    },

    async loadPatches(elementId) {
      const patches = await patchRepo.listByElement(elementId);
      return patches
        .filter((p) => !p.invalidatedAt) // invalidated = deleted evidence ⇒ not a sanctioned beat
        .map((p) => ({
          atOrder: p.sourceNarrativeOrder ?? p.sourceBookOrder ?? 0,
          title: p.title ?? '(无题)',
          body: docToPlainText(p.contentJson),
        }));
    },

    async runLeaf(input) {
      const client = await getClient();
      return withRetry('leaf', () =>
        callStructured(client, arcLeafPrompt, input, {
          outputLanguage,
          signal,
          model: ARC_MODEL,
          thinking: ARC_THINKING,
          jsonMode: true,
        }),
      );
    },
    async runDistill(input) {
      const client = await getClient();
      return withRetry('distill', () =>
        callStructured(client, arcDistillPrompt, input, {
          outputLanguage,
          signal,
          model: ARC_MODEL,
          thinking: ARC_THINKING,
          jsonMode: true,
        }),
      );
    },
    async runSynthesize(input) {
      const client = await getClient();
      return withRetry('synth', () =>
        callStructured(client, arcSynthesizePrompt, input, {
          outputLanguage,
          signal,
          model: ARC_MODEL,
          thinking: ARC_THINKING,
          jsonMode: true,
        }),
      );
    },
  };
}

// Element canon as text for the prompts: summary + KV facts + body. Mirrors what
// the Shadow judge grounds on, minus patches (the leaf/distill derive BLIND; patches
// only reach SYNTHESIZE for overlay).
function formatCanon(
  name: string,
  categoryName: string,
  summary: string,
  kvJson: string,
  contentJson: string,
): string {
  const facts = parseKv(kvJson)
    .map((kv) => `- ${kv.key}：${kv.value}`)
    .join('\n');
  const body = docToPlainText(contentJson).trim();
  return [
    `元素：${name}`,
    categoryName ? `类别：${categoryName}` : '',
    summary.trim() ? `summary：${summary.trim()}` : '',
    facts ? `facts：\n${facts}` : '',
    body ? `body：${body}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
