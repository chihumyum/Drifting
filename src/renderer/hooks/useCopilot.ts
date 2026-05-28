/**
 * useCopilot — generic capability runner (coverage-map + per-task debounce).
 *
 * Trigger model:
 *   - On every text-changing transaction, RESET each enabled capability's
 *     own debounce timer. Different caps can have different debounces
 *     (entity-candidate ~3s; element-patch ~12s) — each runs on its own
 *     cadence, no shared global timer.
 *   - When a cap's timer fires, compute the chapter's coverage map
 *     (uncoveredBlocks + priorSections) once, fingerprint, and run that
 *     ONE cap. Multiple caps firing close together share the coverage
 *     read where possible via the data-store cache; the heavy work is
 *     the LLM call itself.
 *   - When accumulated uncovered blocks ≥ threshold AND no summary is
 *     already in flight, fire-and-forget a block_section summary call.
 *     The summary is producer-agnostic: any cap fire can trigger it.
 *
 * The per-task debounce is the reason PR D-2 split out from D-1 — D-1
 * removed the dirty queue, D-2 splits the debounce. Both rely on the
 * coverage-map model so capability state stays single-tier (a fingerprint
 * string per cap, vs. the old per-cap dirty Set).
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
import { useSettingsStore, type CopilotTaskId } from '../store/settings-store';
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
  const summariesEnabled = useSettingsStore((s) => s.copilotGenerateSummaries);
  const summarySectionSize = useSettingsStore((s) => s.copilotSummarySectionSize);
  const taskConfigs = useSettingsStore((s) => s.copilotTaskConfigs);
  // Stable string key over the configs map so useEffect can re-bind when a
  // single cap's enabled flag or debounce changes. JSON serialise once per
  // settings change — cheap and bullet-proof against Zustand identity
  // gotchas.
  const taskConfigsKey = JSON.stringify(taskConfigs);

  // Per-capability fingerprint of the coverage state last seen.
  const lastFingerprintRef = useRef<Record<string, string>>({});
  // Per-capability in-flight controller. Lets us abort one cap without
  // blasting the others.
  const inFlightByCapRef = useRef<Record<string, AbortController | null>>({});
  // Per-chapter lock: at most one summary call in flight at a time.
  const summaryInFlightRef = useRef(false);

  useEffect(() => {
    if (!copilotEnabled) return;

    const allCaps = capabilitiesForTrigger('editor-block-debounced');
    const enabledCaps = allCaps.filter((c) => taskConfigs[c.id as CopilotTaskId]?.enabled);

    if (enabledCaps.length === 0) {
      log.info(`[useCopilot] mount nodeId=${nodeId} no enabled caps — idle`);
      return;
    }

    log.info(
      `[useCopilot] mount nodeId=${nodeId} caps=[${enabledCaps.map((c) => `${c.id}@${effectiveDebounceMs(c, taskConfigs)}ms`).join(',')}] summaries=${summariesEnabled} sectionSize=${summarySectionSize}`,
    );

    // Per-cap timer. Map of capId → Timeout (or null when cleared).
    const timers: Record<string, ReturnType<typeof setTimeout> | null> = {};
    let updateCount = 0;
    let fireCount = 0;

    const runFor = async (cap: CopilotCapability): Promise<void> => {
      fireCount += 1;
      const localFireId = fireCount;

      const baseContext = await buildBaseBlockContext({ editor, chapterId: nodeId });
      if (!baseContext) {
        log.debug(`[useCopilot] cap=${cap.id} fire #${localFireId} skip (coverage empty)`);
        return;
      }

      const fingerprint = computeUncoveredFingerprint(baseContext.uncoveredBlocks);
      if (lastFingerprintRef.current[cap.id] === fingerprint) {
        log.debug(`[useCopilot] cap=${cap.id} fire #${localFireId} skip (fingerprint unchanged)`);
        return;
      }

      // Abort any previous in-flight call for THIS cap only.
      inFlightByCapRef.current[cap.id]?.abort();
      const controller = new AbortController();
      inFlightByCapRef.current[cap.id] = controller;

      log.info(
        `[useCopilot] cap=${cap.id} fire #${localFireId} dispatch chapter=${nodeId.slice(0, 8)} uncovered=${baseContext.uncoveredBlocks.length} priorSections=${baseContext.priorSections.length}`,
      );

      try {
        let results: Awaited<ReturnType<typeof cap.detect>> = [];
        try {
          results = await cap.detect({
            runtime: copilotRuntime,
            editor,
            projectId,
            targetKind: 'node',
            targetId: nodeId,
            baseContext,
            signal: controller.signal,
          });
          lastFingerprintRef.current[cap.id] = fingerprint;
        } catch (err) {
          if (err instanceof AIError && err.kind === 'aborted') return;
          if (err instanceof AIError && err.kind === 'auth') return;
          log.warn(`[copilot] capability "${cap.id}" detect failed`, err);
          return;
        }

        if (controller.signal.aborted) return;

        const defaultAnchorBlockId = baseContext.uncoveredBlocks[0]!.blockId;
        let persistedAny = false;
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

        if (persistedAny) {
          events.emit('copilot:suggestion-persisted', {
            targetKind: 'node',
            targetId: nodeId,
          });
        }

        // Threshold-triggered summary, decoupled from any specific cap.
        // First fire to see uncovered ≥ threshold wins the lock; others
        // skip until completion. The summary call's signal is the cap's
        // controller — chapter teardown aborts in-flight summaries too.
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
        if (inFlightByCapRef.current[cap.id] === controller) {
          inFlightByCapRef.current[cap.id] = null;
        }
      }
    };

    const onEditorUpdate = (): void => {
      updateCount += 1;
      // Reset every enabled cap's timer. Each fires independently after
      // its own debounce — entity-candidate at 3s, element-patch at 12s,
      // etc. No shared timer, no cross-cap coupling.
      for (const cap of enabledCaps) {
        const existing = timers[cap.id];
        if (existing) clearTimeout(existing);
        const debounceMs = effectiveDebounceMs(cap, taskConfigs);
        timers[cap.id] = setTimeout(() => {
          void runFor(cap);
        }, debounceMs);
      }
    };

    editor.on('update', onEditorUpdate);

    return () => {
      log.info(
        `[useCopilot] cleanup nodeId=${nodeId} totalUpdates=${updateCount} totalFires=${fireCount}`,
      );
      editor.off('update', onEditorUpdate);
      for (const t of Object.values(timers)) {
        if (t) clearTimeout(t);
      }
      for (const c of Object.values(inFlightByCapRef.current)) {
        c?.abort();
      }
      inFlightByCapRef.current = {};
      lastFingerprintRef.current = {};
      summaryInFlightRef.current = false;
    };
  }, [
    editor,
    copilotEnabled,
    taskConfigsKey,
    projectId,
    nodeId,
    summariesEnabled,
    summarySectionSize,
    createCopilotSuggestion,
    // taskConfigs included only via taskConfigsKey above (stable JSON identity).
    taskConfigs,
  ]);
}

/**
 * Resolve a capability's effective debounce: user override if set, else the
 * capability's declared default. Floor at 250ms so a malformed setting
 * doesn't melt the CPU with a near-zero-debounce write loop.
 */
function effectiveDebounceMs(
  cap: CopilotCapability,
  configs: ReturnType<typeof useSettingsStore.getState>['copilotTaskConfigs'],
): number {
  const cfg = configs[cap.id as CopilotTaskId];
  const ms = cfg?.debounceMs ?? cap.defaultDebounceMs;
  return Math.max(250, ms);
}

/**
 * Cheap hash of (uncoveredBlock ids + their text). djb2 over each block's
 * id+text concatenated. Two fires on the same coverage state produce the
 * same string; any block change or addition produces a different one.
 */
function computeUncoveredFingerprint(blocks: { blockId: string; text: string }[]): string {
  let h = 5381;
  for (const b of blocks) {
    const s = b.blockId + '' + b.text;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h |= 0;
    }
  }
  return (h >>> 0).toString(36);
}
