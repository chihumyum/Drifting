/**
 * Dep-graph value snapshot + diff — the engine half of the "changed-canon hint".
 *
 * The staleness selector (useStaleReviews) already knows WHICH deps changed (an entity's
 * updatedAt is newer than the chapter's last review). What it can't say is WHAT changed —
 * it has the current value but not the value the last review validated against. These two
 * functions close that gap:
 *
 *   snapshotConsulted() — at review END, freeze the VALUE-state (summary + KV facts) of
 *     the canon the judge consulted. Persisted on the shadow_job row (consulted_snapshot).
 *   computeChangedDeps() — at re-review START, find the chapter's last completed review and
 *     diff its snapshot against CURRENT canon → the old→new field changes, fed to the judge
 *     as SemanticEvalContext.changedDeps (rendered by buildChangedDepsHint).
 *
 * This is what makes the dep-hint REAL in prod: the eval previously synthesized the diff
 * from golden-vs-mutation; here it falls out of (last snapshot) vs (current canon).
 */
import { useDataStore } from '../../store/data-store';
import { parseKv } from '../../domain/kv';
import type { ConsultedSnapshotRef, ShadowConsultedRef } from '../../domain/shadow-job';
import type { ChangedDepHint } from '../ai/shadow-rules';

const SUMMARY_FIELD = '简介';
/** Keep a single from/to value from bloating the judge prompt (summaries can be long). */
function clip(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function factsOf(kvJson: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of parseKv(kvJson)) out[kv.key] = kv.value;
  return out;
}

/**
 * Freeze the value-state of the consulted canon — call at review end with the entities
 * the judge actually read. Elements/storylines carry KV facts + summary; nodes carry
 * summary (their prose isn't snapshotted — too heavy, and node-prose deps are rare).
 * Categories have no validated canon → skipped.
 */
export function snapshotConsulted(refs: ShadowConsultedRef[]): ConsultedSnapshotRef[] {
  const s = useDataStore.getState();
  const out: ConsultedSnapshotRef[] = [];
  for (const ref of refs) {
    if (ref.kind === 'element') {
      const e = s.bookElements.find((x) => x.id === ref.id);
      if (!e) continue;
      const facts = factsOf(e.kvJson);
      out.push({
        kind: 'element',
        id: e.id,
        label: e.name,
        summary: e.summary || undefined,
        facts: Object.keys(facts).length ? facts : undefined,
      });
    } else if (ref.kind === 'storyline') {
      const sl = s.storylines.find((x) => x.id === ref.id);
      if (!sl) continue;
      const facts = factsOf(sl.kvJson);
      out.push({
        kind: 'storyline',
        id: sl.id,
        label: sl.name,
        summary: sl.summary || undefined,
        facts: Object.keys(facts).length ? facts : undefined,
      });
    } else if (ref.kind === 'node') {
      const n = s.bookNodes.find((x) => x.id === ref.id);
      if (!n) continue;
      out.push({ kind: 'node', id: n.id, label: n.title, summary: n.summary || undefined });
    }
  }
  return out;
}

/** Per-key diff of two fact maps → one ChangedDepHint per changed/added/removed key. */
function diffFacts(
  name: string,
  before: Record<string, string> | undefined,
  after: Record<string, string>,
): ChangedDepHint[] {
  const out: ChangedDepHint[] = [];
  const b = before ?? {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(after)])) {
    const from = b[key];
    const to = after[key];
    if ((from ?? '') === (to ?? '')) continue;
    out.push({ name, fact: key, from: clip(from ?? '（无）'), to: clip(to ?? '（已删除）') });
  }
  return out;
}

/**
 * Diff the chapter's last-review value snapshot against current canon → the dep-hint.
 * Returns [] when there's no prior snapshot (first review, or legacy row): the judge
 * then runs cold, exactly as before. Reads only the in-memory store (no DB/async), so
 * it's safe to call inline at the top of a review.
 */
export function computeChangedDeps(projectId: string, chapterId: string): ChangedDepHint[] {
  const s = useDataStore.getState();
  // Baseline = the chapter's most recent COMPLETED review that captured a value snapshot.
  const prior = s.shadowJobs
    .filter(
      (j) =>
        j.projectId === projectId &&
        j.chapterId === chapterId &&
        j.status === 'done' &&
        j.finishedAt &&
        j.consultedSnapshot.length > 0,
    )
    .sort((a, b) => ((a.finishedAt ?? '') < (b.finishedAt ?? '') ? 1 : -1))[0];
  if (!prior) return [];

  const out: ChangedDepHint[] = [];
  for (const snap of prior.consultedSnapshot) {
    if (snap.kind === 'element') {
      const e = s.bookElements.find((x) => x.id === snap.id);
      if (!e) continue; // deleted/unavailable — skip (conservative; no value to re-verify)
      out.push(...diffFacts(e.name, snap.facts, factsOf(e.kvJson)));
      if ((snap.summary ?? '') !== (e.summary ?? '')) {
        out.push({
          name: e.name,
          fact: SUMMARY_FIELD,
          from: clip(snap.summary || '（空）'),
          to: clip(e.summary || '（空）'),
        });
      }
    } else if (snap.kind === 'storyline') {
      const sl = s.storylines.find((x) => x.id === snap.id);
      if (!sl) continue;
      out.push(...diffFacts(sl.name, snap.facts, factsOf(sl.kvJson)));
      if ((snap.summary ?? '') !== (sl.summary ?? '')) {
        out.push({
          name: sl.name,
          fact: SUMMARY_FIELD,
          from: clip(snap.summary || '（空）'),
          to: clip(sl.summary || '（空）'),
        });
      }
    } else if (snap.kind === 'node') {
      const n = s.bookNodes.find((x) => x.id === snap.id);
      if (!n) continue;
      if ((snap.summary ?? '') !== (n.summary ?? '')) {
        out.push({
          name: n.title,
          fact: SUMMARY_FIELD,
          from: clip(snap.summary || '（空）'),
          to: clip(n.summary || '（空）'),
        });
      }
    }
  }
  return out;
}
