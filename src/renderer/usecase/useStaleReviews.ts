/**
 * Incremental-review staleness selector. A *finished* chapter was validated
 * against canon at its last shadow review (`validatedAt` = the chapter's most
 * recent shadow-job finishedAt). If any canon entity it depends on changed AFTER
 * that, the validation is stale → it needs re-review. Derived & stateless:
 * re-running shadow (a new finishedAt) clears it automatically.
 *
 * Dependencies = prose inline-mentions (elements + settings/drift nodes, from the
 * dependency index) ⋃ the chapter's storylines (membership ⇒ shared facts).
 * Over-approximate on purpose — for a regression signal, flag-too-much beats
 * miss-a-real-inconsistency (and it stays advisory).
 */
import { useEffect, useMemo, useState } from 'react';
import { events } from '../lib/events';
import { useDataStore } from '../store/data-store';
import {
  loadChapterDependencies,
  type ChapterDependencyIndex,
} from '../lib/shadow/dependency-index';

export interface StaleChange {
  kind: 'element' | 'drift' | 'chapter' | 'storyline';
  name: string;
}

export interface StaleReview {
  chapterId: string;
  chapterTitle: string;
  validatedAt: string;
  changes: StaleChange[];
}

function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

export function useStaleReviews(projectId: string): StaleReview[] {
  const [deps, setDeps] = useState<ChapterDependencyIndex>(() => new Map());

  // Load the dependency edges; refresh when the prose-mention projection changes.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void loadChapterDependencies(projectId).then((m) => {
        if (!cancelled) setDeps(m);
      });
    };
    load();
    const onRef = (p: { projectId: string }) => {
      if (p.projectId === projectId) load();
    };
    events.on('references:changed', onRef);
    return () => {
      cancelled = true;
      events.off('references:changed', onRef);
    };
  }, [projectId]);

  const shadowJobs = useDataStore((s) => s.shadowJobs);
  const bookNodes = useDataStore((s) => s.bookNodes);
  const bookElements = useDataStore((s) => s.bookElements);
  const storylines = useDataStore((s) => s.storylines);
  const nodeStorylineMapping = useDataStore((s) => s.nodeStorylineMapping);

  return useMemo(() => {
    // validatedAt per chapter = latest shadow finishedAt; skip chapters with a
    // review still running (don't nag mid-flight).
    const validatedAt = new Map<string, string>();
    const running = new Set<string>();
    for (const j of shadowJobs) {
      if (j.projectId !== projectId) continue;
      if (j.status === 'running') running.add(j.chapterId);
      if (j.finishedAt) {
        const prev = validatedAt.get(j.chapterId);
        if (!prev || isNewer(j.finishedAt, prev)) validatedAt.set(j.chapterId, j.finishedAt);
      }
    }

    const elementById = new Map(bookElements.map((e) => [e.id, e] as const));
    const nodeById = new Map(bookNodes.map((n) => [n.id, n] as const));
    const storylineById = new Map(storylines.map((s) => [s.id, s] as const));

    const out: StaleReview[] = [];
    for (const node of bookNodes) {
      if (node.projectId !== projectId) continue;
      if (node.writingStatus !== 'finished') continue; // only validated chapters
      if (running.has(node.id)) continue;
      const baseline = validatedAt.get(node.id);
      if (!baseline) continue; // never shadow-reviewed → no baseline to invalidate

      const changes: StaleChange[] = [];
      for (const dep of deps.get(node.id) ?? []) {
        if (dep.kind === 'element') {
          const e = elementById.get(dep.id);
          if (e && isNewer(e.updatedAt, baseline)) changes.push({ kind: 'element', name: e.name });
        } else {
          const n = nodeById.get(dep.id);
          if (n && isNewer(n.updatedAt, baseline)) {
            changes.push({ kind: n.kind === 'drift' ? 'drift' : 'chapter', name: n.title });
          }
        }
      }
      for (const slId of nodeStorylineMapping[node.id] ?? []) {
        const sl = storylineById.get(slId);
        if (sl && isNewer(sl.updatedAt, baseline)) changes.push({ kind: 'storyline', name: sl.name });
      }

      if (changes.length > 0) {
        out.push({ chapterId: node.id, chapterTitle: node.title, validatedAt: baseline, changes });
      }
    }

    // Most-recently-impacted chapters first.
    out.sort((a, b) => (a.validatedAt < b.validatedAt ? 1 : -1));
    return out;
  }, [deps, shadowJobs, bookNodes, bookElements, storylines, nodeStorylineMapping, projectId]);
}
