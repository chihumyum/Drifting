/**
 * Side-effect runner: after a successful debounce, fire a cheap summary
 * call against the just-scanned blocks and persist the result as a
 * `block_section` row.
 *
 * Caller (useCopilot) calls this fire-and-forget — it must not block the
 * user-visible suggestion persistence, and failures here are non-fatal
 * (the next debounce will re-summarize on its own).
 *
 * Hash invariant: blockSignature is computed from the SAME blockIds list
 * and the SAME getBlockText callback used at this moment. Read paths
 * (lib/copilot/prior-sections.ts) recompute against the editor's current
 * state and drop rows whose signature no longer matches.
 */
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import loglevel from 'loglevel';
import { callStructured } from '../ai/call-structured';
import { blockSectionSummaryPrompt } from '../ai/prompts/templates/block-section-summary';
import { isBlockType } from '../extensions/block-id';
import { computeBlockSignature } from './block-signature';
import { copilotRuntime } from './runtime';
import type { CopilotRuntime } from './capability';
import { createBlockSectionRepository } from '../../sqlite-repo/block-section-repo';
import { encodeBlockIds } from '../../domain/block-section';
import { useDataStore } from '../../store/data-store';
import { syncBlockSectionCreate } from '../../usecase/sync-helpers';

const log = loglevel.getLogger('copilot:block-section-summary');

export interface ProduceBlockSectionSummaryInput {
  projectId: string;
  chapterId: string;
  /** Block ids the debounce just scanned, in document order. */
  blockIds: string[];
  /** Editor reference — used to read current text per block for signing. */
  editor: Editor;
  /** Optional override; defaults to the shared copilot runtime. */
  runtime?: CopilotRuntime;
  signal?: AbortSignal;
}

export async function produceBlockSectionSummary(
  input: ProduceBlockSectionSummaryInput,
): Promise<void> {
  if (input.blockIds.length === 0) return;

  // Snapshot current block texts. The same snapshot is used for both the
  // LLM input and the signature, so the row we write is always consistent
  // with itself (no race between text-read and signature-compute).
  const textsById = collectBlockTexts(input.editor, input.blockIds);
  const orderedBlockIds = input.blockIds.filter((id) => textsById.has(id));
  if (orderedBlockIds.length === 0) return;

  const recentText = orderedBlockIds
    .map((id) => textsById.get(id) ?? '')
    .filter((t) => t.length > 0)
    .join('\n\n');
  if (!recentText) return;

  const signature = computeBlockSignature(orderedBlockIds, (id) => textsById.get(id) ?? '');

  let summaryText: string;
  try {
    const runtime = input.runtime ?? copilotRuntime;
    const client = await runtime.getClient();
    const result = await callStructured(
      client,
      blockSectionSummaryPrompt,
      { recentText },
      { signal: input.signal },
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
    blockSignature: signature,
    summary: summaryText,
    source: 'copilot-rolling',
  });

  // Mirror into the data-store so the next debounce's prior-section
  // gathering sees this row without re-querying SQLite.
  useDataStore.getState().addBlockSection(created);

  // Push to server — same sync model as elementPatch. Recovery on 404 is
  // wired in entity-sync.service via the blockSection branch.
  syncBlockSectionCreate(created.id, created.projectId, {
    id: created.id,
    chapterId: created.chapterId,
    blockIdsJson: encodeBlockIds(created.blockIds),
    blockSignature: created.blockSignature,
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
