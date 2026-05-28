/**
 * useCopilot — generic capability runner (coverage-map model, post PR D-1).
 *
 * Trigger model:
 *   - On every text-changing transaction, reset a debounce timer.
 *   - When the timer fires, compute the chapter's coverage map ONCE
 *     (uncoveredBlocks + priorSections), then run every enabled capability
 *     against that snapshot in parallel.
 *   - Each capability has its own fingerprint of "what I last ran against"
 *     — if the coverage map hasn't changed since last fire, the capability
 *     skips the LLM call. Avoids wasting tokens when caps fire at staggered
 *     intervals and the user hasn't actually changed anything since.
 *   - When accumulated uncovered blocks ≥ threshold AND no summary is
 *     already in flight, fire-and-forget a block_section summary call.
 *     That summary on completion shrinks the uncovered set, naturally
 *     compressing context for the next fire.
 *
 * What was REMOVED in PR D-1 vs the previous implementation:
 *   - session-store / dirty queue tracking (state lives in block_section + editor)
 *   - markDirty / drainDirty / per-block fingerprint Map
 *   - "fire summary after all caps succeed" coupling
 *   - per-block readBlockText fingerprint to gate dirty marking
 */
import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';

const log = loglevel.getLogger('copilot:run');
log.setLevel(loglevel.levels.INFO);
import { AIError } from '../lib/ai/types';
import {
  capabilitiesForTrigger,
  type CopilotCapability,
} from '../lib/copilot/capability';
import { copilotRuntime } from '../lib/copilot/runtime';
import { buildBaseBlockContext } from '../lib/copilot/base-block-context';
import { produceBlockSectionSummary } from '../lib/copilot/produce-block-section-summary';
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
  const debounceMs = useSettingsStore((s) => s.copilotDebounceMs);
  const summariesEnabled = useSettingsStore((s) => s.copilotGenerateSummaries);
  const summarySectionSize = useSettingsStore((s) => s.copilotSummarySectionSize);
  const enabledTaskKey = useSettingsStore(
    (s) => (s.copilotTasks ?? []).slice().sort().join('|'),
  );

  // Per-capability fingerprint: hash of (uncoveredBlock ids + their texts)
  // at the time the cap last ran. If the next fire computes the same
  // fingerprint, skip the cap entirely — nothing has changed for it.
  const lastFingerprintRef = useRef<Record<string, string>>({});
  const inFlightRef = useRef<AbortController | null>(null);
  // Chapter-level lock so two near-simultaneous cap fires don't both kick
  // a summary call. Per-mount → naturally tied to chapter session.
  const summaryInFlightRef = useRef(false);

  useEffect(() => {
    if (!copilotEnabled) return;

    const enabledIds = new Set(enabledTaskKey ? enabledTaskKey.split('|') : []);
    const isEnabled = (cap: CopilotCapability): boolean =>
      enabledIds.size === 0 || enabledIds.has(cap.id);

    log.info(
      `[useCopilot] mount nodeId=${nodeId} debounceMs=${debounceMs} summariesEnabled=${summariesEnabled} sectionSize=${summarySectionSize} enabledTasks=[${enabledTaskKey}]`,
    );

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let updateCount = 0;
    let fireCount = 0;

    const runDetection = async (): Promise<void> => {
      fireCount += 1;
      const localFireId = fireCount;

      const baseContext = await buildBaseBlockContext({ editor, chapterId: nodeId });
      if (!baseContext) {
        log.debug(`[useCopilot] fire #${localFireId} skip (coverage map empty)`);
        return;
      }

      const capabilities = capabilitiesForTrigger('editor-block-debounced').filter(isEnabled);
      if (capabilities.length === 0) {
        log.debug(`[useCopilot] fire #${localFireId} skip (no enabled capabilities)`);
        return;
      }

      // Fingerprint over uncovered ids + texts. Cheap; two caps both
      // computing this on the same snapshot agree.
      const fingerprint = computeUncoveredFingerprint(baseContext.uncoveredBlocks);

      // Cancel any previous run. One controller per chapter mount is enough
      // — late firings of the same cap would just want to clobber anyway.
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;

      log.info(
        `[useCopilot] fire #${localFireId} dispatch chapter=${nodeId.slice(0, 8)} uncovered=${baseContext.uncoveredBlocks.length} priorSections=${baseContext.priorSections.length} caps=[${capabilities.map((c) => c.id).join(',')}]`,
      );

      try {
        const perCapability = await Promise.all(
          capabilities.map(async (cap) => {
            // Per-cap fingerprint skip — saves a full LLM call when nothing
            // has changed since this cap last ran.
            if (lastFingerprintRef.current[cap.id] === fingerprint) {
              log.debug(`[useCopilot] cap=${cap.id} skip (fingerprint unchanged)`);
              return { cap, results: [] } as const;
            }
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
              lastFingerprintRef.current[cap.id] = fingerprint;
              return { cap, results } as const;
            } catch (err) {
              if (err instanceof AIError && err.kind === 'aborted') {
                return { cap, results: [] } as const;
              }
              if (err instanceof AIError && err.kind === 'auth') {
                return { cap, results: [] } as const;
              }
              log.warn(`[copilot] capability "${cap.id}" detect failed`, err);
              return { cap, results: [] } as const;
            }
          }),
        );

        if (controller.signal.aborted) return;

        const defaultAnchorBlockId = baseContext.uncoveredBlocks[0]!.blockId;

        let persistedAny = false;
        for (const { cap, results } of perCapability) {
          for (const result of results) {
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
              log.warn(`[copilot] persist "${cap.id}" suggestion failed`, err);
            }
          }
        }

        if (persistedAny) {
          events.emit('copilot:suggestion-persisted', {
            targetKind: 'node',
            targetId: nodeId,
          });
        }

        // Threshold-triggered summary. Decoupled from any specific cap —
        // first fire to see uncovered ≥ threshold AND no summary in flight
        // wins. Uses cap controller's signal so aborting the whole run
        // (chapter-switch) cancels the in-flight summary too.
        if (
          summariesEnabled &&
          baseContext.uncoveredBlocks.length >= summarySectionSize &&
          !summaryInFlightRef.current
        ) {
          summaryInFlightRef.current = true;
          const blockIds = baseContext.uncoveredBlocks.map((b) => b.blockId);
          void produceBlockSectionSummary({
            projectId,
            chapterId: nodeId,
            blockIds,
            editor,
            signal: controller.signal,
          }).finally(() => {
            summaryInFlightRef.current = false;
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
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void runDetection();
      }, debounceMs);
    };

    editor.on('update', onEditorUpdate);

    return () => {
      log.info(
        `[useCopilot] cleanup nodeId=${nodeId} totalUpdates=${updateCount} totalFires=${fireCount}`,
      );
      editor.off('update', onEditorUpdate);
      if (debounceTimer) clearTimeout(debounceTimer);
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      // Clear fingerprints so a re-mount on the same chapter doesn't get
      // confused by state from a previous editor instance with stale block ids.
      lastFingerprintRef.current = {};
      summaryInFlightRef.current = false;
    };
  }, [
    editor,
    copilotEnabled,
    enabledTaskKey,
    projectId,
    nodeId,
    debounceMs,
    summariesEnabled,
    summarySectionSize,
    createCopilotSuggestion,
  ]);
}

/**
 * Cheap hash of (uncoveredBlock ids + their text). djb2 over each block's
 * id+text concatenated. Two fires on the same coverage state produce the
 * same string; any block change or addition produces a different one.
 */
function computeUncoveredFingerprint(blocks: { blockId: string; text: string }[]): string {
  let h = 5381;
  for (const b of blocks) {
    const s = b.blockId + '' + b.text;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h |= 0;
    }
  }
  return (h >>> 0).toString(36);
}
