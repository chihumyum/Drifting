/**
 * reverse-chapter-summary (Task 5, part B) — roll a chapter's segment
 * summaries up into BookNode.summary, but ONLY when that field is empty.
 * Per the locked decision, this is manual + fill-empty: it never overwrites
 * the author's hand-written chapter blurb.
 *
 * Self-contained (repo + store + sync, mirroring useBookNode's summary write)
 * so it can be invoked from the inline popover without a hook.
 */
import loglevel from 'loglevel';
import { runStructured } from '../ai/remote/run-structured';
import { chapterSummaryPrompt } from '../ai/prompts/templates/chapter-summary';
import { useDataStore } from '../../store/data-store';
import { createBookNodeSqliteRepository } from '../../sqlite-repo/node-repo';
import { syncNodeUpdate } from '../../usecase/sync-helpers';

const log = loglevel.getLogger('copilot:reverse-summary');

export type ReverseChapterSummaryStatus =
  | 'written'
  | 'skipped-nonempty'
  | 'no-sections'
  | 'failed';

export interface ReverseChapterSummaryResult {
  status: ReverseChapterSummaryStatus;
  summary?: string;
}

export async function generateChapterSummary(params: {
  projectId: string;
  chapterId: string;
  signal?: AbortSignal;
}): Promise<ReverseChapterSummaryResult> {
  const { projectId, chapterId, signal } = params;

  const node = useDataStore.getState().bookNodes.find((n) => n.id === chapterId);
  if (!node) return { status: 'failed' };
  // Fill-empty only — never clobber the author's blurb.
  if (node.summary && node.summary.trim().length > 0) {
    return { status: 'skipped-nonempty' };
  }

  const sectionSummaries = useDataStore
    .getState()
    .blockSections.filter((s) => s.chapterId === chapterId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((s) => s.summary)
    .filter((s) => s.trim().length > 0);
  if (sectionSummaries.length === 0) return { status: 'no-sections' };

  let summary: string;
  try {
    const out = await runStructured(
      chapterSummaryPrompt,
      { sectionSummaries },
      { signal, projectId },
    );
    summary = out.summary.trim();
  } catch (err) {
    log.warn('[reverse-summary] generation failed', err);
    return { status: 'failed' };
  }
  if (!summary) return { status: 'failed' };

  try {
    const repo = createBookNodeSqliteRepository(projectId);
    const now = new Date().toISOString();
    await repo.update(chapterId, { summary, updatedAt: now });
    useDataStore.getState().updateBookNode(chapterId, { summary, updatedAt: now });
    syncNodeUpdate(chapterId, projectId, { summary });
  } catch (err) {
    log.warn('[reverse-summary] persist failed', err);
    return { status: 'failed' };
  }

  log.info(`[reverse-summary] wrote chapter summary for ${chapterId.slice(0, 8)}`);
  return { status: 'written', summary };
}
