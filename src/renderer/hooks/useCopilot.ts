/**
 * useCopilot — generic capability runner (coverage-map + per-task debounce).
 *
 * Trigger model:
 *   - On every text-changing transaction, RESET each enabled capability's
 *     own debounce timer. Different caps can have different debounces
 *     (element-candidate ~3s; element-patch ~12s) — each runs on its own
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
import { useLayoutEffect } from 'react';
import { CopilotInvocationOwner } from '../lib/copilot/invocation-owner';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import { v7 as uuidv7 } from 'uuid';

const log = loglevel.getLogger('copilot:run');
log.setLevel(loglevel.levels.INFO);
import { AIError } from '../lib/ai/types';
import {
  capabilitiesForTrigger,
  getCopilotCapability,
  type CopilotCapability,
} from '../lib/copilot/capability';
import { copilotRuntime } from '../lib/copilot/runtime';
import {
  buildBaseBlockContext,
  buildSelectionBlockContext,
  selectionWarrantsSummaryRegen,
} from '../lib/copilot/base-block-context';
import { produceBlockSectionSummary } from '../lib/copilot/produce-block-section-summary';
import { locateTextInBlock } from '../domain/comment';
import { useComment } from '../usecase/useComment';
import { useSettingsStore, type CopilotTaskId } from '../store/settings-store';
import { useCopilotInlineStore } from '../store/copilot-inline-store';
import { events, type AiTaskEvent } from '../lib/events';
import { useDataStore } from '../store/data-store';

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
  const { createCopilotSuggestion } = useComment({ projectId, userId });
  const autoTrigger = useSettingsStore((s) => s.copilotAutoTrigger);
  const summariesEnabled = useSettingsStore((s) => s.copilotGenerateSummaries);
  const summarySectionSize = useSettingsStore((s) => s.copilotSummarySectionSize);
  const taskConfigs = useSettingsStore((s) => s.copilotTaskConfigs);
  // Stable string key over the configs map so useEffect can re-bind when a
  // single cap's enabled flag or debounce changes. JSON serialise once per
  // settings change — cheap and bullet-proof against Zustand identity
  // gotchas.
  const taskConfigsKey = JSON.stringify(taskConfigs);

  useLayoutEffect(() => {
    const owner = new CopilotInvocationOwner(() => !editor.isDestroyed && editor.isEditable);
    const lastFingerprint: Record<string, string> = {};
    const summaryKey = Symbol('chapter-summary');
    const startSummary = (blockIds: string[]) => {
      if (owner.has(summaryKey)) return;
      const invocation = owner.begin(summaryKey);
      if (!invocation) return;
      void produceBlockSectionSummary({ projectId, chapterId: nodeId, blockIds, editor, signal: invocation.signal })
        .catch(error => { if (invocation.isCurrent()) log.warn('[copilot] section summary failed', error); })
        .finally(invocation.finish);
    };
    const allCaps = capabilitiesForTrigger('editor-block-debounced');
    const enabledCaps = allCaps.filter((c) => taskConfigs[c.id as CopilotTaskId]?.enabled);
    // Auto debounce is gated by the auto-trigger switch. The manual path
    // (Cmd+Shift+I / context menu) is wired below regardless — it is never
    // gated, since the user asked for it.
    const autoEnabled = autoTrigger;

    log.info(
      `[useCopilot] mount nodeId=${nodeId} caps=[${enabledCaps.map((c) => `${c.id}@${effectiveDebounceMs(c, taskConfigs)}ms`).join(',')}] summaries=${summariesEnabled} sectionSize=${summarySectionSize}`,
    );

    // Per-cap timer. Map of capId → Timeout (or null when cleared).
    const timers: Record<string, ReturnType<typeof setTimeout> | null> = {};
    let updateCount = 0;
    let fireCount = 0;

    const runFor = async (
      cap: CopilotCapability,
      opts?: { force?: boolean; instruction?: string; selectionBlockIds?: string[] },
    ): Promise<void> => {
      fireCount += 1;
      const localFireId = fireCount;
      const forced = opts?.force === true;
      const selectionBlockIds = opts?.selectionBlockIds ?? [];
      const isSelectionRun = selectionBlockIds.length > 0;

      // Pause automatic fires while the inline-Copilot popover is open — the
      // user is actively steering Copilot there, so a background fire would
      // race it and muddy the shared coverage context. Manual fires are exempt.
      if (!forced && useCopilotInlineStore.getState().ctx) {
        log.debug(`[useCopilot] cap=${cap.id} fire #${localFireId} skip (inline popover open)`);
        return;
      }

      const invocation = owner.begin(cap.id);
      if (!invocation?.isCurrent()) return;
      let closeTask = () => {};
      try {
        // Selection-scoped run (Task 6): the capability sees exactly the
        // selected blocks + their segments. Otherwise the rolling coverage view.
        const baseContext = isSelectionRun
          ? buildSelectionBlockContext(editor, nodeId, selectionBlockIds)
          : await buildBaseBlockContext({ editor, chapterId: nodeId });
        if (!invocation.isCurrent()) return;
        if (!baseContext) {
          log.debug(`[useCopilot] cap=${cap.id} fire #${localFireId} skip (empty context)`);
          return;
        }

        const fingerprint = computeUncoveredFingerprint(baseContext.uncoveredBlocks);
        // Manual fires (Cmd+Shift+I / copilot menu) skip the dedup gate: the user is
        // explicitly re-running, often precisely because the debounced fire on
        // this same content wasn't satisfactory.
        if (!forced && lastFingerprint[cap.id] === fingerprint) {
          log.debug(`[useCopilot] cap=${cap.id} fire #${localFireId} skip (fingerprint unchanged)`);
          return;
        }

        log.info(
          `[useCopilot] cap=${cap.id} fire #${localFireId}${forced ? ' (manual)' : ''} dispatch chapter=${nodeId.slice(0, 8)} uncovered=${baseContext.uncoveredBlocks.length} priorSections=${baseContext.priorSections.length}`,
        );

        // Global notification feed. Background fires are silent until they produce
        // something (else the center floods on every debounce); a manual run
        // announces its whole arc (started → completed/failed).
        const taskId = `copilot:${cap.id}:${nodeId}:${uuidv7()}`;
        const chapterTitle =
          useDataStore.getState().bookNodes.find((n) => n.id === nodeId)?.title || 'This chapter';
        const taskTitle = `Copilot · ${cap.displayName}`;
        let ended = false;
        const finishTask = (state: 'completed' | 'failed' | 'stopped', extra: Partial<AiTaskEvent> = {}) => {
          if (ended) return;
          ended = true;
          events.emit('ai-task', { id: taskId, source: 'copilot', state, title: taskTitle,
            detail: chapterTitle, chapterId: nodeId, at: Date.now(), ...extra });
        };
        const stopped = () => { if (forced) finishTask('stopped'); };
        invocation.signal.addEventListener('abort', stopped, { once: true });
        closeTask = () => { invocation.signal.removeEventListener('abort', stopped); stopped(); };
        if (forced) {
          events.emit('ai-task', {
            id: taskId,
            source: 'copilot',
            state: 'started',
            title: taskTitle,
            detail: chapterTitle,
            chapterId: nodeId,
            at: Date.now(),
          });
        }

        let results: Awaited<ReturnType<typeof cap.detect>> = [];
        try {
          if (!invocation.isCurrent()) return;
          results = await cap.detect({
            runtime: copilotRuntime,
            editor,
            projectId,
            targetKind: 'node',
            targetId: nodeId,
            baseContext,
            userInstruction: opts?.instruction,
            signal: invocation.signal,
          });
          if (!invocation.isCurrent()) return;
          lastFingerprint[cap.id] = fingerprint;
        } catch (err) {
          if (!invocation.isCurrent()) return;
          if (err instanceof AIError && err.kind === 'aborted') return;
          if (err instanceof AIError && err.kind === 'auth') return;
          log.warn(`[copilot] capability "${cap.id}" detect failed`, err);
          if (forced) {
            finishTask('failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (!invocation.isCurrent()) return;

        const defaultAnchorBlockId = baseContext.uncoveredBlocks[0]!.blockId;
        let persistedCount = 0;
        for (const result of results) {
          if (!invocation.isCurrent()) break;
          try {
            // Enrich the bare evidence anchor into the unified shape (snapshot +
            // precise text anchor) so a copilot comment hover-highlights its
            // evidence phrase and can show "原文" like manual comments.
            const targetBlockId = result.overrideTargetBlockId ?? defaultAnchorBlockId;
            const evidenceText = (() => {
              try {
                return (JSON.parse(result.anchorJson) as { selectedText?: string }).selectedText ?? '';
              } catch {
                return '';
              }
            })();
            let blockText = '';
            editor.state.doc.descendants((node) => {
              if (blockText) return false;
              if ((node.attrs?.id as string | undefined) === targetBlockId) {
                blockText = node.textContent;
                return false;
              }
              return undefined;
            });
            const loc = evidenceText ? locateTextInBlock(blockText, evidenceText) : null;
            const enrichedAnchor = JSON.stringify({
              selectedText: evidenceText,
              createdAt: new Date().toISOString(),
              blockSnapshots: [{ blockId: targetBlockId, blockText }],
              ...(loc
                ? {
                    textAnchor: {
                      startBlockId: targetBlockId,
                      startOffset: loc.from,
                      endBlockId: targetBlockId,
                      endOffset: loc.to,
                      text: evidenceText,
                    },
                  }
                : {}),
            });
            await createCopilotSuggestion({
              targetKind: 'node',
              targetId: nodeId,
              targetBlockId,
              targetBlockIds: [targetBlockId],
              anchorJson: enrichedAnchor,
              metadata: result.metadata,
            });
            persistedCount++;
          } catch (err) {
            log.warn(`[copilot] persist "${cap.id}" suggestion failed`, err);
          }
        }

        if (persistedCount > 0) {
          events.emit('copilot:suggestion-persisted', {
            targetKind: 'node',
            targetId: nodeId,
          });
        }

        // Notify when a manual run finishes, or a background run actually
        // produced suggestions. Silent empty background fires stay silent.
        if (forced || persistedCount > 0) {
          finishTask(invocation.isCurrent() ? 'completed' : 'stopped', {
            detail: persistedCount > 0
              ? `${persistedCount} suggestions · ${chapterTitle}`
              : `No new suggestions · ${chapterTitle}`,
            count: persistedCount,
          });
        }

        if (!invocation.isCurrent()) return;
        if (isSelectionRun) {
          if (summariesEnabled && selectionBlockIds.length >= 2 && selectionWarrantsSummaryRegen(nodeId, selectionBlockIds)) {
            startSummary(selectionBlockIds);
          }
        } else if (summariesEnabled && baseContext.uncoveredBlocks.length >= summarySectionSize) {
          startSummary(baseContext.uncoveredBlocks.map(block => block.blockId));
        }
      } catch (error) {
        if (invocation.isCurrent()) log.warn('[copilot] invocation failed', error);
      } finally { closeTask(); invocation.finish(); }
    };

    const onEditorUpdate = (): void => {
      if (!owner.canStart()) return;
      updateCount += 1;
      // Reset every enabled cap's timer. Each fires independently after
      // its own debounce — element-candidate at 3s, element-patch at 12s,
      // etc. No shared timer, no cross-cap coupling.
      for (const cap of enabledCaps) {
        const existing = timers[cap.id];
        if (existing) clearTimeout(existing);
        const debounceMs = effectiveDebounceMs(cap, taskConfigs);
        timers[cap.id] = setTimeout(() => {
          timers[cap.id] = null;
          void runFor(cap);
        }, debounceMs);
      }
    };

    // Debounced auto-fire only when auto is on AND a cap is enabled for it.
    // The manual path below stays wired regardless, so Cmd+Shift+I can run a
    // per-task-disabled capability (or run at all while auto is off).
    if (autoEnabled && enabledCaps.length > 0) {
      editor.on('update', onEditorUpdate);
    } else {
      log.info(
        `[useCopilot] nodeId=${nodeId} auto idle (auto=${autoTrigger} caps=${enabledCaps.length}) — manual still armed`,
      );
    }

    // Manual run: user pressed Cmd+Shift+I / picked a capability from the copilot
    // menu. Force a fire (skip dedup) regardless of the per-task enabled flag.
    // Always wired — manual triggers are never gated by the auto switch;
    // nodeId match scopes the event to this editor's chapter.
    const onManualRun = ({
      nodeId: target,
      capId,
      instruction,
      selectionBlockIds,
    }: {
      nodeId: string;
      capId: string;
      instruction?: string;
      selectionBlockIds?: string[];
    }): void => {
      if (target !== nodeId) return;
      const cap = getCopilotCapability(capId);
      if (!cap) {
        log.warn(`[useCopilot] manual-run for unknown capability "${capId}"`);
        return;
      }
      void runFor(cap, { force: true, instruction, selectionBlockIds });
    };
    events.on('copilot:manual-run', onManualRun);

    const stopOwner = () => {
      for (const [id, timer] of Object.entries(timers)) {
        if (timer) clearTimeout(timer);
        timers[id] = null;
      }
      owner.dispose();
    };
    const stopIfReadonly = () => { if (!editor.isEditable) stopOwner(); };
    editor.on('update', stopIfReadonly); editor.on('destroy', stopOwner);

    return () => {
      log.info(
        `[useCopilot] cleanup nodeId=${nodeId} totalUpdates=${updateCount} totalFires=${fireCount}`,
      );
      editor.off('update', onEditorUpdate);
      events.off('copilot:manual-run', onManualRun);
      editor.off('update', stopIfReadonly); editor.off('destroy', stopOwner);
      stopOwner();
    };
  }, [
    editor,
    autoTrigger,
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
