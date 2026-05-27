/**
 * useCopilot — generic capability runner.
 *
 * Trigger model (changed in PR B):
 *   - Every text-changing transaction marks the cursor's block as dirty in
 *     the per-chapter session store. Multi-block edits (paste, IME) that
 *     happen between debounces are NOT lost — each touched block is in the
 *     dirty set when the timer fires.
 *   - The debounce timer fires `runDetection` for the chapter. It builds a
 *     shared base context (dirty blocks → ordered BlockSnippet[]) once and
 *     hands it to every enabled capability.
 *   - On success: drain the dirty set for the blocks that were just scanned.
 *     On abort/cancel: keep them dirty (the next fire will retry).
 *
 * Concurrency:
 *   - Per-chapter AbortController. A fresh debounce while a previous run is
 *     in flight cancels every in-flight capability call atomically.
 *   - Per-block text fingerprint: an 'update' event that doesn't actually
 *     change the block's text (mark-only transactions like entityLink
 *     stamping) won't mark dirty. This was already in the old hook; ported
 *     to the dirty-queue model so we don't burn LLM calls on no-ops.
 *
 * Settings:
 *   - `copilotEnabled` (master) must be true.
 *   - `copilotTasks` (capability id allow-list): if non-empty, only those
 *     capabilities run; if empty, all registered capabilities run (default-on).
 */
import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';

const log = loglevel.getLogger('copilot:run');
log.setLevel(loglevel.levels.INFO);
import { getBlockIdAtCursor } from '../lib/ai';
import { AIError } from '../lib/ai/types';
import {
  capabilitiesForTrigger,
  type CopilotCapability,
} from '../lib/copilot/capability';
import { copilotRuntime } from '../lib/copilot/runtime';
import { useCopilotSessionStore } from '../lib/copilot/session-store';
import { buildBaseBlockContext } from '../lib/copilot/base-block-context';
import { useManuscriptComment } from '../usecase/useManuscriptComment';
import { useSettingsStore } from '../store/settings-store';
import { events } from '../lib/events';

export interface UseCopilotInput {
  editor: Editor;
  projectId: string;
  /** The BookNode (chapter) this editor is rendering — comment target. */
  nodeId: string;
  userId: string;
}

export function useCopilot({
  editor,
  projectId,
  nodeId,
  userId,
}: UseCopilotInput): void {
  const { createCopilotSuggestion } = useManuscriptComment({ projectId, userId });
  const copilotEnabled = useSettingsStore((s) => s.copilotEnabled);
  // Debounce: read from settings so the user can tune Copilot's eagerness
  // via the CopilotPanel preset Seg.
  const debounceMs = useSettingsStore((s) => s.copilotDebounceMs);
  const enabledTaskKey = useSettingsStore(
    (s) => (s.copilotTasks ?? []).slice().sort().join('|'),
  );

  // Per-block text fingerprint. Prevents mark-only transactions (entityLink
  // stamping etc.) from looking like real edits to the dirty queue.
  const lastBlockTextRef = useRef<Map<string, string>>(new Map());
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!copilotEnabled) return;

    const enabledIds = new Set(enabledTaskKey ? enabledTaskKey.split('|') : []);
    const isEnabled = (cap: CopilotCapability): boolean =>
      enabledIds.size === 0 || enabledIds.has(cap.id);

    const session = useCopilotSessionStore.getState();
    session.touchChapter(nodeId);

    log.info(
      `[useCopilot] mount  nodeId=${nodeId} debounceMs=${debounceMs} enabledTasks=[${enabledTaskKey}]`,
    );

    const lastBlockText = lastBlockTextRef.current;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let updateCount = 0;
    let fireCount = 0;

    const runDetection = async (): Promise<void> => {
      fireCount += 1;
      const localFireId = fireCount;

      const dirty = useCopilotSessionStore.getState().getDirty(nodeId);
      if (dirty.size === 0) {
        log.debug(`[useCopilot] fire #${localFireId} skip (no dirty blocks)`);
        return;
      }

      const baseContext = buildBaseBlockContext({
        editor,
        chapterId: nodeId,
        dirtyBlockIds: dirty,
      });
      if (!baseContext) {
        // Every dirty block was empty / deleted. Drain so they don't pile
        // up forever and skip this fire.
        useCopilotSessionStore.getState().drainDirty(nodeId, dirty);
        log.debug(`[useCopilot] fire #${localFireId} skip (no usable dirty blocks)`);
        return;
      }

      const capabilities = capabilitiesForTrigger('editor-block-debounced').filter(isEnabled);
      if (capabilities.length === 0) {
        log.debug(`[useCopilot] fire #${localFireId} skip (no enabled capabilities)`);
        return;
      }

      // Snapshot of which dirty blocks this run is responsible for; only
      // these get drained on success. Late-arriving dirt (transactions that
      // fire while detect is in flight) stays in the queue for the next run.
      const consumedBlockIds = baseContext.editedBlocks.map((b) => b.blockId);

      log.info(
        `[useCopilot] fire #${localFireId} dispatch chapter=${nodeId.slice(0, 8)} blocks=${consumedBlockIds.length} caps=[${capabilities.map((c) => c.id).join(',')}]`,
      );

      // One controller for the chapter — fresh trigger kills the previous run.
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;

      try {
        const perCapability = await Promise.all(
          capabilities.map(async (cap) => {
            try {
              const results = await cap.detect({
                runtime: copilotRuntime,
                editor,
                projectId,
                targetKind: 'node',
                targetId: nodeId,
                baseContext,
                signal: controller.signal,
              });
              return { cap, results };
            } catch (err) {
              if (err instanceof AIError && err.kind === 'aborted') {
                return { cap, results: [], aborted: true } as const;
              }
              if (err instanceof AIError && err.kind === 'auth') {
                return { cap, results: [] } as const;
              }
              log.warn(`[copilot] capability "${cap.id}" detect failed`, err);
              return { cap, results: [], failed: true } as const;
            }
          }),
        );

        if (controller.signal.aborted) return;

        // Default anchor when a capability doesn't override: the first
        // edited block. Capabilities that map a suggestion's evidence to a
        // specific block should set `overrideTargetBlockId` themselves.
        const defaultAnchorBlockId = consumedBlockIds[0]!;

        let persistedAny = false;
        let anyFailed = false;
        for (const entry of perCapability) {
          if ('failed' in entry && entry.failed) anyFailed = true;
          for (const result of entry.results) {
            try {
              await createCopilotSuggestion({
                targetKind: 'node',
                targetId: nodeId,
                targetBlockId: result.overrideTargetBlockId ?? defaultAnchorBlockId,
                anchorJson: result.anchorJson,
                metadata: result.metadata,
              });
              persistedAny = true;
            } catch (err) {
              log.warn(`[copilot] persist "${entry.cap.id}" suggestion failed`, err);
            }
          }
        }

        // Drain dirty for the blocks we consumed — only when no capability
        // failed. Partial failure keeps them dirty so the next run retries.
        // Aborts already short-circuited above.
        if (!anyFailed) {
          useCopilotSessionStore.getState().drainDirty(nodeId, consumedBlockIds);
        }

        if (persistedAny) {
          events.emit('copilot:suggestion-persisted', {
            targetKind: 'node',
            targetId: nodeId,
          });
        }
      } finally {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
      }
    };

    const onEditorUpdate = (): void => {
      updateCount += 1;
      // Mark the cursor's block dirty if its text actually changed since the
      // last time we observed it. Mark-only transactions (entityLink mark
      // stamping etc.) skip this branch and don't trigger Copilot.
      const blockId = getBlockIdAtCursor(editor);
      if (blockId) {
        const text = readBlockText(editor, blockId);
        if (text && lastBlockText.get(blockId) !== text) {
          lastBlockText.set(blockId, text);
          useCopilotSessionStore.getState().markDirty(nodeId, blockId);
        }
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void runDetection();
      }, debounceMs);
    };

    editor.on('update', onEditorUpdate);

    return () => {
      log.info(
        `[useCopilot] cleanup  nodeId=${nodeId} totalUpdates=${updateCount} totalFires=${fireCount}`,
      );
      editor.off('update', onEditorUpdate);
      if (debounceTimer) clearTimeout(debounceTimer);
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      lastBlockText.clear();
      // Dirty queue intentionally NOT cleared — the user navigating away
      // from a chapter shouldn't drop work the next visit could scan.
    };
  }, [editor, copilotEnabled, enabledTaskKey, projectId, nodeId, debounceMs, createCopilotSuggestion]);
}

/**
 * Pull the plain-text content of the named block out of the editor doc.
 * Used for fingerprinting only; capabilities read text from baseContext.
 */
function readBlockText(editor: Editor, blockId: string): string {
  let found = '';
  editor.state.doc.descendants((node) => {
    if (found) return false;
    const id = node.attrs?.id as string | null | undefined;
    if (id === blockId) {
      found = node.textContent.replace(/\s+/g, ' ').trim();
      return false;
    }
    return undefined;
  });
  return found;
}
