/**
 * useCopilot — generic capability runner.
 *
 * On debounced editor updates, the hook dispatches to every enabled
 * `editor-block-debounced` capability registered in the framework registry.
 * Each capability returns suggestions; the hook persists them as
 * copilot-source manuscript comments via the existing createCopilotSuggestion
 * helper. The hook itself knows nothing about entity-candidate vs
 * element-patch vs any future capability — that knowledge lives behind the
 * CopilotCapability interface.
 *
 * Concurrency:
 *   - Per-block AbortController shared across all capabilities at that block.
 *     A fresh trigger on the same block cancels every in-flight capability
 *     call atomically.
 *   - Per-block content fingerprint: skip the whole capability set if the
 *     focus block's text is unchanged from the last detection run.
 *
 * Settings:
 *   - `copilotEnabled` (master) must be true.
 *   - `copilotTasks` (capability id allow-list): if non-empty, only those
 *     capabilities run; if empty, all registered capabilities run (default-on
 *     for first-time users — settings UI in PR 4b makes this explicit).
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
  // via the CopilotPanel preset Seg. Setting changes propagate by useEffect
  // teardown + re-mount (debounceMs is in the deps).
  const debounceMs = useSettingsStore((s) => s.copilotDebounceMs);
  // Stringify for stable useEffect dep — array identity changes on every set.
  const enabledTaskKey = useSettingsStore(
    (s) => (s.copilotTasks ?? []).slice().sort().join('|'),
  );

  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  const lastTextRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!copilotEnabled) return;

    // Snapshot refs for cleanup safety.
    const inFlight = inFlightRef.current;
    const lastText = lastTextRef.current;

    const enabledIds = new Set(enabledTaskKey ? enabledTaskKey.split('|') : []);
    const isEnabled = (cap: CopilotCapability): boolean =>
      // Empty allow-list = "all registered" (default-on). Non-empty = strict.
      enabledIds.size === 0 || enabledIds.has(cap.id);

    log.info(
      `[useCopilot] mount  nodeId=${nodeId} debounceMs=${debounceMs} enabledTasks=[${enabledTaskKey}]`,
    );

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let updateCount = 0;
    let fireCount = 0;

    const runDetection = async (): Promise<void> => {
      fireCount += 1;
      const localFireId = fireCount;
      const blockId = getBlockIdAtCursor(editor);
      if (!blockId) {
        log.debug(`[useCopilot] fire #${localFireId} skip (no block at cursor)`);
        return;
      }

      // Sample focus text via the editor doc — we need it to fingerprint.
      // Cheap; the capability's context builder will read it again, that's fine.
      const focusText = readFocusText(editor, blockId);
      if (!focusText) {
        log.debug(`[useCopilot] fire #${localFireId} skip (empty focus)`);
        return;
      }
      if (lastText.get(blockId) === focusText) {
        log.debug(
          `[useCopilot] fire #${localFireId} skip (fingerprint unchanged for block ${blockId.slice(0, 8)})`,
        );
        return;
      }
      // CRITICAL: set the fingerprint BEFORE awaiting the LLM call. If we set
      // it after, a second debounce fire that arrives while the first is
      // in-flight will see the OLD fingerprint and re-run, doubling API
      // calls per pause-type-pause cycle.
      lastText.set(blockId, focusText);

      const capabilities = capabilitiesForTrigger('editor-block-debounced').filter(isEnabled);
      if (capabilities.length === 0) {
        log.debug(`[useCopilot] fire #${localFireId} skip (no enabled capabilities)`);
        return;
      }
      log.info(
        `[useCopilot] fire #${localFireId} dispatch block=${blockId.slice(0, 8)} caps=[${capabilities.map((c) => c.id).join(',')}]`,
      );

      // Shared signal across all capabilities at this block: a fresh trigger
      // cancels every in-flight call atomically.
      const previous = inFlight.get(blockId);
      if (previous) previous.abort();
      const controller = new AbortController();
      inFlight.set(blockId, controller);

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
                focusBlockId: blockId,
                signal: controller.signal,
              });
              return { cap, results };
            } catch (err) {
              if (err instanceof AIError && err.kind === 'aborted') return { cap, results: [] };
              if (err instanceof AIError && err.kind === 'auth') {
                // No API key — quietly no-op for this run; the settings panel
                // (PR 4b) will prompt the user to configure one.
                return { cap, results: [] };
              }
              log.warn(`[copilot] capability "${cap.id}" detect failed`, err);
              return { cap, results: [] };
            }
          }),
        );

        if (controller.signal.aborted) return;
        // (lastText was set pre-await — see comment above where it's set.)

        // Persist each capability's results. createCopilotSuggestion is
        // capability-agnostic — it just writes whatever metadata it's given.
        let persistedAny = false;
        for (const { cap, results } of perCapability) {
          for (const result of results) {
            try {
              await createCopilotSuggestion({
                targetKind: 'node',
                targetId: nodeId,
                targetBlockId: result.overrideTargetBlockId ?? blockId,
                anchorJson: result.anchorJson,
                metadata: result.metadata,
              });
              persistedAny = true;
            } catch (err) {
              log.warn(`[copilot] persist "${cap.id}" suggestion failed`, err);
            }
          }
        }

        // Auto-open the comment rail if it's currently hidden — otherwise
        // suggestions land in an invisible margin and the user has no clue
        // they were created. useEntityMarginNotes subscribes to this event.
        if (persistedAny) {
          events.emit('copilot:suggestion-persisted', {
            targetKind: 'node',
            targetId: nodeId,
          });
        }
      } finally {
        if (inFlight.get(blockId) === controller) {
          inFlight.delete(blockId);
        }
      }
    };

    const onEditorUpdate = (): void => {
      updateCount += 1;
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
      for (const ctrl of inFlight.values()) ctrl.abort();
      inFlight.clear();
      lastText.clear();
    };
  }, [editor, copilotEnabled, enabledTaskKey, projectId, nodeId, debounceMs, createCopilotSuggestion]);
}

/**
 * Pull the plain-text content of the named block out of the editor doc.
 * Used only for fingerprinting — we don't bother caching since blocks are
 * cheap to walk and the capability will read the full doc anyway.
 */
function readFocusText(editor: Editor, blockId: string): string {
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
