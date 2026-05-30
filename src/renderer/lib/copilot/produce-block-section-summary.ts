/**
 * Produce a block_section row from a set of uncovered blocks.
 *
 * Called by useCopilot when accumulated uncovered blocks cross the size
 * threshold (settings.copilotSummarySectionSize). Decoupled from any
 * specific capability — any cap fire can trigger this, controlled by a
 * single chapter-level in-flight lock to prevent concurrent producers.
 *
 * Per-block hashes (PR D-1): every covered block's text gets hashed at
 * write time. The coverage-map reader uses these per-block hashes to
 * decide which blocks of a section have stayed valid vs which have been
 * edited since.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import loglevel from 'loglevel';
import { runStructured } from '../ai/remote/run-structured';
import { blockSectionSummaryPrompt } from '../ai/prompts/templates/block-section-summary';
import { resolveOutputLanguageName } from '../ai/output-language';
import { isBlockType } from '../extensions/block-id';
import { computeBlockHashes } from './block-signature';
import type { CopilotRuntime } from './capability';
import { createBlockSectionRepository } from '../../sqlite-repo/block-section-repo';
import { encodeBlockHashes, encodeBlockIds } from '../../domain/block-section';
import { useDataStore } from '../../store/data-store';
import { syncBlockSectionCreate } from '../../usecase/sync-helpers';

const log = loglevel.getLogger('copilot:block-section-summary');

export interface ProduceBlockSectionSummaryInput {
  projectId: string;
  chapterId: string;
  /** Block ids to summarize, in document order. */
  blockIds: string[];
  /** Editor reference — used to read current text per block. */
  editor: Editor;
  /** Optional override; defaults to the shared copilot runtime. */
  runtime?: CopilotRuntime;
  signal?: AbortSignal;
}

export async function produceBlockSectionSummary(
  input: ProduceBlockSectionSummaryInput,
): Promise<void> {
  if (input.blockIds.length === 0) return;

  // Snapshot current block texts. Same snapshot drives both the LLM input
  // and the stored per-block hashes — no race between text-read and hash-
  // compute.
  const textsById = collectBlockTexts(input.editor, input.blockIds);
  const orderedBlockIds = input.blockIds.filter((id) => textsById.has(id));
  if (orderedBlockIds.length === 0) return;

  const recentText = orderedBlockIds
    .map((id) => textsById.get(id) ?? '')
    .filter((t) => t.length > 0)
    .join('\n\n');
  if (!recentText) return;

  const blockHashes = computeBlockHashes(orderedBlockIds, (id) => textsById.get(id) ?? '');

  let summaryText: string;
  try {
    // Phase 2: built + run server-side. `input.runtime` (a client-side LLM
    // client override) is no longer consulted for this path.
    const result = await runStructured(
      blockSectionSummaryPrompt,
      { recentText },
      { signal: input.signal, outputLanguage: resolveOutputLanguageName(input.projectId) },
    );
    summaryText = result.summary.trim();
  } catch (err) {
    // Summary failures are silent — they cost us prompt-context quality on
    // the NEXT run, not user-visible work. Don't escalate.
    log.info('[copilot:summary] generation failed, skipping persist', err);
    return;
  }
  if (!summaryText) {
    log.info('[copilot:summary] empty summary returned, skipping persist');
    return;
  }

  const repo = createBlockSectionRepository();
  const created = await repo.create({
    projectId: input.projectId,
    chapterId: input.chapterId,
    blockIds: orderedBlockIds,
    blockHashes,
    summary: summaryText,
    source: 'copilot-rolling',
  });

  // Mirror into the data-store so the next coverage-map pass sees this row.
  useDataStore.getState().addBlockSection(created);

  // Push to server — recovery on 404 lives in entity-sync.service.
  syncBlockSectionCreate(created.id, created.projectId, {
    id: created.id,
    chapterId: created.chapterId,
    blockIdsJson: encodeBlockIds(created.blockIds),
    blockHashesJson: encodeBlockHashes(created.blockHashes),
    summary: created.summary,
    source: created.source,
  });

  log.info(
    `[copilot:summary] wrote block_section ${created.id.slice(0, 8)} (${orderedBlockIds.length} blocks)`,
  );
}

function collectBlockTexts(editor: Editor, wantedIds: string[]): Map<string, string> {
  const wanted = new Set(wantedIds);
  const out = new Map<string, string>();
  editor.state.doc.descendants((node: PMNode) => {
    if (!isBlockType(node.type.name)) return undefined;
    const id = node.attrs?.id as string | null | undefined;
    if (!id) return undefined;
    if (wanted.has(id)) {
      out.set(id, node.textContent.replace(/\s+/g, ' ').trim());
    }
    return false;
  });
  return out;
}
