/**
 * /goal 一键演化 — the orchestrator loop (GOAL-EVOLVE.md §5–6).
 *
 * Deterministic outer loop, two injected model leaves (critic + editor). Flow:
 *   scope → detect (round 0) → [edit flagged → re-detect touched]×N → terminate.
 * Termination (§6): contradiction set empty (converged) | round cap | the set
 * fails to STRICTLY shrink (stalled / ping-pong). The human is the terminal gate
 * — edits stay staged (pending), nothing auto-commits.
 */
import { useAgentEditStore } from '../../store/agent-edit-store';
import { entityKey } from '../agent/tool-entity-ref';
import type { AgentBlockChange } from '../agent/block-diff';
import { scopeChapters, scopeAppearances } from './scope';
import { spotKey } from './types';
import type {
  ElementChange,
  ContradictionSpot,
  EvolveLeaves,
  EvolveResult,
  EditTurnResult,
  ScopedChapter,
  ChangeClass,
  EvolveError,
} from './types';

export interface EvolveParams {
  projectId: string;
  change: ElementChange;
  /** Timeline cutoff: base change → -Infinity (whole book); patch → patch source order. */
  effectiveFromOrder: number;
}

export interface EvolveOpts {
  /** Strict cap on edit↔verify rounds (§6). Default 3. */
  maxRounds?: number;
  /** Detect-only: scope + round-0 critique, no editing. Validates the critic. */
  dryRun?: boolean;
  /** Semantic gate (§3): injected change-classifier. When it returns 'essence'
   *  (a fundamental nature/feel rewrite — the critic's blind spot) the run is
   *  DECLINED before scoping unless forced. Omit → no semantic gate (stub-friendly). */
  classify?: () => Promise<ChangeClass>;
  /** Blast-radius gate (§3): if round-0 lights up contradictions in ≥ this many
   *  chapters, STOP before editing and return the preview ('needs-confirmation')
   *  instead of auto-launching a large rewrite. Default 10. */
  confirmThreshold?: number;
  /** The author okayed a large run — proceed past the confirm gate. */
  force?: boolean;
  log?: (msg: string) => void;
}

function groupByChapter(spots: ContradictionSpot[]): Map<string, ContradictionSpot[]> {
  const m = new Map<string, ContradictionSpot[]>();
  for (const s of spots) {
    const arr = m.get(s.chapterId);
    if (arr) arr.push(s);
    else m.set(s.chapterId, [s]);
  }
  return m;
}

function harvestPending(scoped: ScopedChapter[]): Record<string, AgentBlockChange[]> {
  const pending = useAgentEditStore.getState().pending;
  const out: Record<string, AgentBlockChange[]> = {};
  for (const { chapterId } of scoped) {
    const e = pending[entityKey('node', chapterId)];
    if (e?.changes.length) out[chapterId] = e.changes;
  }
  return out;
}

export async function runEvolve(
  params: EvolveParams,
  leaves: EvolveLeaves,
  opts: EvolveOpts = {},
): Promise<EvolveResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const log = opts.log ?? (() => {});
  const { change, effectiveFromOrder, projectId } = params;

  // The change the leaves actually target. For a 'mixed' change we narrow it to the
  // factual sub-change (the essence part is surfaced for manual handling instead).
  let effective = change;
  let manualNote: string | undefined;
  // Per-chapter failures isolated here so ONE bad chapter (e.g. a transient
  // malformed-JSON from the judge) never aborts the whole batch.
  const errors: EvolveError[] = [];

  // Semantic gate (§3) — is this even the right tool? Run before scoping (cheap).
  // A fundamental essence/nature rewrite (of a character, place, rule, …) is the
  // critic's blind spot, so a best-effort run would silently report a false "done".
  // Decline unless the author forces it (or it's a dry-run inspection). A 'mixed'
  // change is DECOMPOSED: run on its factual part, hand the essence part to the human.
  if (opts.classify) {
    const cls = await opts.classify();
    log(`change class：${cls.kind} — ${cls.reason}`);
    if (cls.kind === 'essence' && !opts.force && !opts.dryRun) {
      // Don't auto-edit (critic under-detects essence → false done), and don't hand
      // a misleadingly-short contradiction list. LOCATE instead: every scene the
      // element appears in, as an honest manual reconception worklist (no critic).
      const worklist = await scopeAppearances(projectId, change.elementId, effectiveFromOrder);
      log(`essence → 不自动改；出场 ${worklist.length} 章，作为逐场重构清单交作者`);
      return {
        scoped: worklist.map(({ chapterId, title, order }) => ({ chapterId, title, order })),
        rounds: 0,
        stopReason: 'out-of-scope',
        resolvedCount: 0,
        residual: [],
        edits: [],
        pendingByChapter: {},
        errors,
        worklist,
        note: `根本性「本质/神韵」改写——loop 不自动改（critic 会漏检→假性 done）：${cls.reason}。下面是《${change.elementName}》的全部出场（${worklist.length} 章），请逐场重构。注意：这是【出场清单】不是矛盾清单。force:true 可强行机械尝试。`,
      };
    }
    if (cls.kind === 'mixed') {
      // Loop targets the discrete/falsifiable sub-change only; the essence sub-change
      // can't be verified by the critic → surfaced for the author, never auto-edited.
      if (cls.factualPart?.trim()) effective = { ...change, newSetting: cls.factualPart.trim() };
      if (cls.essencePart?.trim()) {
        manualNote = `本次改动含「本质/神韵」成分，loop 不处理、需手动：${cls.essencePart.trim()}`;
      }
      log(
        `mixed → 拆分：事实部分自动跑「${cls.factualPart?.trim() || '（未提取，按整体跑）'}」；本质部分留人工「${cls.essencePart?.trim() || '（无）'}」`,
      );
    }
  }

  const scoped = await scopeChapters(projectId, effective.elementId, effectiveFromOrder);
  log(`scope：${scoped.length} 章提到《${effective.elementName}》且在生效区间内`);
  if (scoped.length === 0) {
    return {
      scoped,
      rounds: 0,
      stopReason: 'no-scope',
      resolvedCount: 0,
      residual: [],
      edits: [],
      pendingByChapter: {},
      errors,
      note: manualNote,
    };
  }

  // Critique one chapter, isolating a failure: a thrown critic (e.g. transient
  // malformed-JSON) is logged + recorded, NOT propagated — that chapter is simply
  // "not assessed" this pass, the rest of the batch carries on.
  const safeCritique = async (
    ch: ScopedChapter,
    phase: 'detect' | 'verify',
  ): Promise<ContradictionSpot[]> => {
    try {
      return await leaves.critique(ch.chapterId, ch.title, effective);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${phase}《${ch.title}》失败：${msg}（已隔离，继续）`);
      errors.push({ chapterId: ch.chapterId, phase, error: msg });
      return [];
    }
  };

  // Round 0 — detect across the whole scope (candidate → real work-list).
  let open: ContradictionSpot[] = [];
  for (const ch of scoped) {
    const spots = await safeCritique(ch, 'detect');
    if (spots.length) log(`  detect《${ch.title}》：${spots.length} 处冲突`);
    open.push(...spots);
  }
  const initialKeys = new Set(open.map(spotKey));
  log(`初始矛盾集：${open.length} 处，跨 ${groupByChapter(open).size} 章${errors.length ? `（${errors.length} 章探测失败）` : ''}`);

  if (opts.dryRun) {
    return {
      scoped,
      rounds: 0,
      stopReason: 'dry-run',
      resolvedCount: 0,
      residual: open,
      edits: [],
      pendingByChapter: harvestPending(scoped),
      errors,
      note: manualNote,
    };
  }

  // Blast-radius gate (§3): a wide change means a large, slow, lossy rewrite — and
  // the author should SEE the scope before committing, not discover it after 40
  // auto-edits. The contradiction count is a conservative proxy (it UNDER-counts
  // fundamental essence changes — those are caught earlier by the semantic gate).
  // Stop with a preview unless explicitly forced.
  const chaptersHit = groupByChapter(open).size;
  const threshold = opts.confirmThreshold ?? 10;
  if (!opts.force && chaptersHit >= threshold) {
    log(`blast radius ${chaptersHit} 章命中冲突 ≥ 阈值 ${threshold} → 暂停，待确认（force:true 续跑）`);
    return {
      scoped,
      rounds: 0,
      stopReason: 'needs-confirmation',
      resolvedCount: 0,
      residual: open,
      edits: [],
      pendingByChapter: {},
      errors,
      note: manualNote,
    };
  }

  const edits: EditTurnResult[] = [];
  let rounds = 0;
  let stopReason: EvolveResult['stopReason'] = open.length ? 'max-rounds' : 'converged';
  let prevSize = open.length;

  while (open.length > 0 && rounds < maxRounds) {
    rounds++;
    log(`── round ${rounds} ──`);
    const byChapter = groupByChapter(open);

    // ACT — one chapter = one edit turn (sequential; same-doc safety).
    const touched: ScopedChapter[] = [];
    for (const [chapterId, spots] of byChapter) {
      const ch = scoped.find((c) => c.chapterId === chapterId)!;
      let res: EditTurnResult;
      try {
        res = await leaves.edit(chapterId, ch.title, effective, spots);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res = { chapterId, ok: false, editedBlockIds: [], error: msg };
        errors.push({ chapterId, phase: 'edit', error: msg });
      }
      edits.push(res);
      log(`  edit《${ch.title}》：${res.ok ? `改了 ${res.editedBlockIds.length} 块` : `失败 ${res.error ?? ''}`}`);
      touched.push(ch);
    }

    // VERIFY — re-critique only touched chapters (fresh, full E-scope per chapter).
    const next: ContradictionSpot[] = [];
    for (const ch of touched) {
      const spots = await safeCritique(ch, 'verify');
      next.push(...spots);
      log(`  verify《${ch.title}》：剩 ${spots.length} 处`);
    }
    open = next;

    // Strict-shrink gate (set size). No net shrink → stalled/ping-pong → stop.
    if (open.length === 0) {
      stopReason = 'converged';
      break;
    }
    if (open.length >= prevSize) {
      stopReason = 'stalled';
      log(`未净收缩（${prevSize} → ${open.length}）→ 停，残余交人`);
      break;
    }
    prevSize = open.length;
    stopReason = 'max-rounds'; // provisional; overwritten if we converge next round
  }

  const residualKeys = new Set(open.map(spotKey));
  const resolvedCount = [...initialKeys].filter((k) => !residualKeys.has(k)).length;
  log(`结束：${stopReason}，${rounds} 轮，化解 ${resolvedCount} 处，残余 ${open.length} 处`);

  return {
    scoped,
    rounds,
    stopReason,
    resolvedCount,
    residual: open,
    edits,
    pendingByChapter: harvestPending(scoped),
    errors,
    note: manualNote,
  };
}
