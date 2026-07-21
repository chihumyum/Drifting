/**
 * /goal 一键演化 — manual smoke harness (GOAL-EVOLVE.md §12).
 *
 * First-slice trigger: no UI yet. Run from devtools with the open project:
 *   await __goalEvolve({ elementName: 'Aria', field: '视力',
 *     oldSetting: '视力正常', newSetting: '第12章事故后失明',
 *     fromChapterTitle: '第十二章', dryRun: true })
 *
 * dryRun:true → critic-only (validate the contradiction set first). Omit
 * fromChapterTitle → whole-book scope (base-field change). Side-effect import
 * mounts window.__goalEvolve when a project layout loads.
 */
import { useProjectStore } from '../../store/project-store';
import { useDataStore } from '../../store/data-store';
import { evolveElement } from './evolve-element';
import { renderElementProfile } from './element-profile';
import { chapterOrder } from './scope';
import type { ElementChange } from './types';

export interface SmokeInput {
  elementName: string;
  field?: string;
  oldSetting: string;
  newSetting: string;
  /** Patch origin → scope from this chapter onward. Omit → whole book (base change). */
  fromChapterTitle?: string;
  dryRun?: boolean;
  maxRounds?: number;
  /** Proceed past the blast-radius gate (large change). */
  force?: boolean;
  /** Chapters-hit threshold for the gate (default 10). */
  confirmThreshold?: number;
}

export async function goalEvolveSmoke(input: SmokeInput): Promise<void> {
  const project = useProjectStore.getState().currentProject;
  if (!project) {
    console.error('[goal] no current project');
    return;
  }
  const projectId = project.id;
  const s = useDataStore.getState();
  const el = s.bookElements.find(
    (e) =>
      e.projectId === projectId &&
      (e.name === input.elementName || e.aliases.includes(input.elementName)),
  );
  if (!el) {
    console.error(`[goal] no element named "${input.elementName}"`);
    return;
  }

  const fromNodeId = input.fromChapterTitle
    ? s.bookNodes.find((n) => n.projectId === projectId && n.title === input.fromChapterTitle)?.id
    : undefined;
  if (input.fromChapterTitle && !fromNodeId) {
    console.error(`[goal] no chapter named "${input.fromChapterTitle}"`);
    return;
  }
  const effectiveFromOrder = fromNodeId ? chapterOrder(fromNodeId) : Number.NEGATIVE_INFINITY;

  const change: ElementChange = {
    elementId: el.id,
    elementName: el.name,
    field: input.field,
    oldSetting: input.oldSetting,
    newSetting: input.newSetting,
    // Pre-loaded once for the whole fan-out (saves a read_element per chapter).
    profile: renderElementProfile(projectId, el.id),
  };

  const result = await evolveElement(projectId, change, {
    effectiveFromOrder,
    dryRun: input.dryRun,
    maxRounds: input.maxRounds,
    force: input.force,
    confirmThreshold: input.confirmThreshold,
    log: (m) => console.log('[goal]', m),
  });

  if (result.stopReason === 'out-of-scope') {
    console.warn('[goal] 不自动改：', result.note);
    if (result.worklist?.length) {
      console.warn('[goal] 逐场重构清单（出场清单，非矛盾清单）：');
      console.table(result.worklist.map((w) => ({ 章: w.title, 出场块: w.blockIds.join('、') || '—' })));
    }
  }
  if (result.stopReason === 'needs-confirmation')
    console.warn('[goal] 规模较大，已暂停，确认后 force:true 续跑。');
  if (result.note && result.stopReason !== 'out-of-scope') console.warn('[goal] 需人工：', result.note);
  if (result.errors.length) {
    console.warn(`[goal] ${result.errors.length} 章失败（已隔离，未可靠评估）：`);
    console.table(result.errors);
  }
  console.log('[goal] result', result);
  if (result.residual.length) {
    console.warn('[goal] residual contradictions:');
    console.table(
      result.residual.map((r) => ({ ch: r.chapterTitle, blocks: r.blockIds.join(',') || '(chapter)', reason: r.reason })),
    );
  }
  const pendingCount = Object.values(result.pendingByChapter).reduce((n, cs) => n + cs.length, 0);
  console.log(`[goal] ${pendingCount} pending block edits staged for review across ${Object.keys(result.pendingByChapter).length} chapters`);
}

declare global {
  interface Window {
    __goalEvolve?: (i: SmokeInput) => Promise<void>;
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__goalEvolve = goalEvolveSmoke;
}
