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
  EvolveTraceStep,
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
  /** false (default) ⇒ only 「finished」 chapters are in scope — don't rewrite
   *  half-written drafts. Mirrors arc derivation's same-named filter. */
  includeDrafts?: boolean;
}

export interface EvolveOpts {
  /** Strict cap on edit↔verify rounds (§6). Default 3. */
  maxRounds?: number;
  /** Detect-only: scope + round-0 critique, no editing. Validates the critic. */
  dryRun?: boolean;
  /** Abort: a manual STOP. Aborts in-flight model calls and ends the loop with
   *  stopReason 'aborted' — staged edits stay staged (still under the human gate). */
  signal?: AbortSignal;
  /** Max chapters critiqued concurrently (read-only, always safe). Default 5. */
  critiqueConcurrency?: number;
  /** Max chapters edited concurrently. Shadow-FC is independent per chapter and
   *  can fan out; unknown future transports should stay serial. Default 1. */
  editConcurrency?: number;
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
  /** Streams every leaf step (critic 查证/裁决 rounds, editor tool calls) tagged with
   *  round/phase/chapter — the inspectable trail the evolve UI renders. */
  onTrace?: (ev: EvolveTraceStep) => void;
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

/** blockIds already pending per scoped chapter — taken at run start so the result
 *  reports only THIS run's edits. Without it, a previous run's still-unreviewed
 *  edits bleed into the next run's result (e.g. a clean second pass "showing" the
 *  first pass's changes). Same before-set pattern as runScopedAgentTurn. */
function pendingSnapshot(scoped: ScopedChapter[]): Map<string, Set<string>> {
  const pending = useAgentEditStore.getState().pending;
  const m = new Map<string, Set<string>>();
  for (const { chapterId } of scoped) {
    const e = pending[entityKey('node', chapterId)];
    if (e?.changes.length) m.set(chapterId, new Set(e.changes.map((c) => c.blockId)));
  }
  return m;
}

function harvestPending(
  scoped: ScopedChapter[],
  before: Map<string, Set<string>>,
): Record<string, AgentBlockChange[]> {
  const pending = useAgentEditStore.getState().pending;
  const out: Record<string, AgentBlockChange[]> = {};
  for (const { chapterId } of scoped) {
    const e = pending[entityKey('node', chapterId)];
    if (!e?.changes.length) continue;
    const prior = before.get(chapterId);
    const fresh = prior ? e.changes.filter((c) => !prior.has(c.blockId)) : e.changes;
    if (fresh.length) out[chapterId] = fresh;
  }
  return out;
}

/** Semaphore as a wrapper: at most `limit` wrapped calls run at once; excess queue
 *  up. Unlike a mapLimit over one list, separate limiters let the edit lane and the
 *  verify lane overlap — a chapter's verify runs while the next chapter's edit is in
 *  flight (the per-chapter pipeline below). Release hands the slot straight to the
 *  next waiter (no decrement/re-acquire race). */
function makeLimiter(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async (fn) => {
    if (active >= limit) await new Promise<void>((r) => waiters.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
}

export async function runEvolve(
  params: EvolveParams,
  leaves: EvolveLeaves,
  opts: EvolveOpts = {},
): Promise<EvolveResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const log = opts.log ?? (() => {});
  const { change, effectiveFromOrder, projectId, includeDrafts = false } = params;
  const signal = opts.signal;
  const aborted = () => signal?.aborted === true;
  const critiqueConcurrency = Math.max(1, opts.critiqueConcurrency ?? 5);
  const editConcurrency = Math.max(1, opts.editConcurrency ?? 1);

  // The change the leaves actually target. For a 'mixed' change we narrow it to the
  // factual sub-change (the essence part is surfaced for manual handling instead).
  let effective = change;
  let manualNote: string | undefined;
  // Per-chapter failures isolated here so ONE bad chapter (e.g. a transient
  // malformed-JSON from the judge) never aborts the whole batch.
  const errors: EvolveError[] = [];
  // The full round-0 discovery list — captured once, surfaced for a readable log.
  let initialSpots: ContradictionSpot[] = [];

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
      const worklist = await scopeAppearances(
        projectId,
        change.elementId,
        effectiveFromOrder,
        includeDrafts,
      );
      log(`essence → 不自动改；出场 ${worklist.length} 章，作为逐场重构清单交作者`);
      return {
        scoped: worklist.map(({ chapterId, title, order }) => ({ chapterId, title, order })),
        rounds: 0,
        stopReason: 'out-of-scope',
        initialSpots: [],
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

  const scoped = await scopeChapters(
    projectId,
    effective.elementId,
    effectiveFromOrder,
    includeDrafts,
  );
  log(
    `scope：${scoped.length} 章提到《${effective.elementName}》且在生效区间内${includeDrafts ? '（含草稿）' : '（仅已完成章）'}`,
  );
  if (scoped.length === 0) {
    return {
      scoped,
      rounds: 0,
      stopReason: 'no-scope',
      initialSpots: [],
      resolvedCount: 0,
      residual: [],
      edits: [],
      pendingByChapter: {},
      errors,
      note: manualNote,
    };
  }

  // What was already staged before this run — so every harvest below reports only
  // this run's edits, not a previous run's still-unreviewed leftovers.
  const pendingBefore = pendingSnapshot(scoped);

  // Critique one chapter, isolating a failure: a thrown critic (e.g. transient
  // malformed-JSON) is logged + recorded, NOT propagated — that chapter is simply
  // "not assessed" this pass, the rest of the batch carries on. An abort is NOT a
  // failure: skip silently (the loop ends with stopReason 'aborted' afterwards).
  // Tag a leaf's trail step with where in the loop it happened, for the UI trace.
  const traceFor =
    (
      round: number,
      phase: EvolveTraceStep['phase'],
      ch: ScopedChapter,
      actor: EvolveTraceStep['actor'],
    ) =>
    (step: EvolveTraceStep['step']) =>
      opts.onTrace?.({
        round,
        phase,
        chapterId: ch.chapterId,
        chapterTitle: ch.title,
        actor,
        step,
      });

  const safeCritique = async (
    ch: ScopedChapter,
    phase: 'detect' | 'verify',
    round: number,
  ): Promise<ContradictionSpot[]> => {
    if (aborted()) return [];
    try {
      return await leaves.critique(
        ch.chapterId,
        ch.title,
        effective,
        signal,
        traceFor(round, phase, ch, 'critic'),
      );
    } catch (e) {
      if (aborted()) return [];
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${phase}《${ch.title}》失败：${msg}（已隔离，继续）`);
      errors.push({ chapterId: ch.chapterId, phase, error: msg });
      return [];
    }
  };

  const abortedResult = (
    open: ContradictionSpot[],
    initialKeys: Set<string>,
    rounds: number,
    edits: EditTurnResult[],
  ): EvolveResult => {
    const residualKeys = new Set(open.map(spotKey));
    log('已手动停止：保留已暂存的改动，交人审。');
    return {
      scoped,
      rounds,
      stopReason: 'aborted',
      initialSpots,
      resolvedCount: [...initialKeys].filter((k) => !residualKeys.has(k)).length,
      residual: open,
      edits,
      pendingByChapter: harvestPending(scoped, pendingBefore),
      errors,
      note: manualNote,
    };
  };

  // Two concurrency lanes shared across rounds: edits (1 = serial for the Agent-SDK
  // singleton, >1 for Shadow-FC) and read-only critiques.
  const editLimit = makeLimiter(editConcurrency);
  const critiqueLimit = makeLimiter(critiqueConcurrency);

  // Round 0 — detect across the whole scope (candidate → real work-list). Read-only
  // per chapter → fan out on the critique lane. Order preserved by Promise.all.
  const detected = await Promise.all(
    scoped.map((ch) =>
      critiqueLimit(async () => {
        const spots = await safeCritique(ch, 'detect', 0);
        if (spots.length) log(`  detect《${ch.title}》：${spots.length} 处冲突`);
        return spots;
      }),
    ),
  );
  let open: ContradictionSpot[] = detected.flat();
  initialSpots = [...open];
  const initialKeys = new Set(open.map(spotKey));
  if (aborted()) return abortedResult(open, initialKeys, 0, []);
  log(
    `初始矛盾集：${open.length} 处，跨 ${groupByChapter(open).size} 章${errors.length ? `（${errors.length} 章探测失败）` : ''}`,
  );

  if (opts.dryRun) {
    return {
      scoped,
      rounds: 0,
      stopReason: 'dry-run',
      initialSpots,
      resolvedCount: 0,
      residual: open,
      edits: [],
      pendingByChapter: harvestPending(scoped, pendingBefore),
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
    log(
      `blast radius ${chaptersHit} 章命中冲突 ≥ 阈值 ${threshold} → 暂停，待确认（force:true 续跑）`,
    );
    return {
      scoped,
      rounds: 0,
      stopReason: 'needs-confirmation',
      initialSpots,
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
    if (aborted()) return abortedResult(open, initialKeys, rounds, edits);
    rounds++;
    log(`── round ${rounds} ──`);
    const byChapter = [...groupByChapter(open).entries()];

    // PIPELINE — per chapter: edit → immediately verify, NO barrier in between. A
    // chapter's verify (critique lane) overlaps the next chapter's edit (edit lane),
    // so the adversarial check follows each edit as soon as it lands instead of
    // waiting for the whole round's edits. Edit lane is >1 for Shadow-FC and should
    // remain 1 for transports that do not explicitly support parallel turns.
    // Verify runs even when the edit failed — its spots still stand and must stay
    // in the open set (safeCritique only returns [] for abort/critic-failure, both
    // of which are recorded elsewhere).
    const next: ContradictionSpot[] = [];
    await Promise.all(
      byChapter.map(async ([chapterId, spots]) => {
        const ch = scoped.find((c) => c.chapterId === chapterId)!;
        await editLimit(async () => {
          if (aborted()) return;
          let res: EditTurnResult;
          try {
            res = await leaves.edit(
              chapterId,
              ch.title,
              effective,
              spots,
              signal,
              traceFor(rounds, 'edit', ch, 'editor'),
            );
          } catch (e) {
            if (aborted()) return;
            const msg = e instanceof Error ? e.message : String(e);
            res = { chapterId, ok: false, editedBlockIds: [], error: msg };
            errors.push({ chapterId, phase: 'edit', error: msg });
          }
          edits.push(res);
          log(
            `  edit《${ch.title}》：${res.ok ? `改了 ${res.editedBlockIds.length} 块` : `失败 ${res.error ?? ''}`}`,
          );
        });
        const verified = await critiqueLimit(() => safeCritique(ch, 'verify', rounds));
        if (!aborted()) log(`  verify《${ch.title}》：剩 ${verified.length} 处`);
        next.push(...verified);
      }),
    );
    if (aborted()) return abortedResult(open, initialKeys, rounds, edits);
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
    initialSpots,
    resolvedCount,
    residual: open,
    edits,
    pendingByChapter: harvestPending(scoped, pendingBefore),
    errors,
    note: manualNote,
  };
}
