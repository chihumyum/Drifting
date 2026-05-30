/**
 * useTodoAutoParse (Task 3) — keeps a comment-todo as a PROJECTION of a "TODO"
 * marker typed in the prose, so the right-sidebar TODO list and AI task
 * pipelines can consume it. Lifecycle is synced to the marker's block.
 *
 * Identity is the BLOCK, not the text: each marker block (stable block-id) maps
 * to at most one auto-parsed todo. The reconcile fires when the cursor leaves a
 * block or the editor blurs (a block-complete proxy, never per-keystroke), and
 * diffs the doc's marker blocks against existing projections:
 *
 *   • marker block with no projection (any status)  → CREATE
 *   • marker text edited                            → no-op (body is NOT resynced)
 *   • marker text removed, block still present      → DELETE (open only)
 *   • block deleted entirely                        → DELETE (open only)
 *   • duplicate open projections for one block      → collapse to the oldest
 *
 * CREATE is deferred until the marker's block is "complete": a block the cursor
 * still sits in is skipped, so it only projects once the cursor has moved to
 * another block or the editor lost focus (which sweeps every block). That keeps
 * a todo from spawning while the TODO line is still being typed. DELETE and
 * de-dup are not deferred — they run on the same reconcile.
 *
 * Two deliberate freezes:
 *   - The todo body is seeded once at creation and never re-synced, so a user's
 *     manual edits in the sidebar are never clobbered.
 *   - Resolved/converted todos are immutable: never re-deleted, never re-text'd,
 *     and they still block re-spawn (so checking a todo off keeps it gone).
 *
 * Load-race guard: in Yjs mode the doc is hydrated asynchronously after the
 * editor remounts, so there's a window where the doc reads empty. The
 * "block deleted" delete branch is gated behind `loadedRef`, which only latches
 * once a non-empty doc has been observed — otherwise switching chapters would
 * wipe the new chapter's todos before its content arrives. The "marker removed,
 * block still present" branch is inherently safe (it requires positively seeing
 * the block in the doc), so it needs no gate.
 *
 * Origin marker: authorKind 'copilot' + metadataJson {kind:'todo-autoparse'}.
 * source stays 'manual' so it renders as a normal anchored todo, NOT a
 * copilot accept/reject suggestion card (CommentRail keys that off source).
 */
import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import { isBlockType } from '../lib/extensions/block-id';
import { createPlainCommentDoc, type Comment } from '../domain/comment';
import { useComment } from '../usecase/useComment';
import { useDataStore } from '../store/data-store';
import { useSettingsStore } from '../store/settings-store';

const log = loglevel.getLogger('copilot:todo-parse');

const DEBOUNCE_MS = 1200;
// A block whose text starts with a TODO marker. Captures the trailing task
// text. Case-insensitive; accepts ':' / '：' / whitespace separators, and the
// Chinese 待办 marker. Anchored at start so mid-sentence "todo" isn't matched.
const TODO_RE = /^\s*(?:TODO|待办)[\s:：]+(.*)$/i;

interface TodoAutoparseMeta {
  kind: 'todo-autoparse';
  /** Stable block id — the sole identity key linking marker ↔ projection. */
  blockId: string;
  /** Normalized marker text at creation time. Stored for reference/debugging
   * only; NOT used for matching (identity is blockId). */
  text: string;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Block id of the block currently holding the selection head, or null. */
function activeBlockId(editor: Editor): string | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (isBlockType(node.type.name) && typeof node.attrs?.id === 'string') {
      return node.attrs.id as string;
    }
  }
  return null;
}

export interface UseTodoAutoParseInput {
  editor: Editor;
  projectId: string;
  nodeId: string;
  userId: string;
}

export function useTodoAutoParse({
  editor,
  projectId,
  nodeId,
  userId,
}: UseTodoAutoParseInput): void {
  const { createComment, deleteComment } = useComment({ projectId, userId });
  const enabled = useSettingsStore((s) => s.copilotAutoTrigger);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latches true once a non-empty doc has been seen for this mount. Gates the
  // "block deleted" delete branch against the empty pre-hydration window.
  const loadedRef = useRef(false);
  // Last block the cursor was in, so selectionUpdate only reconciles on an
  // actual block change (not on every intra-block cursor move / keystroke).
  const lastActiveRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    loadedRef.current = false;
    lastActiveRef.current = null;

    const del = async (id: string): Promise<void> => {
      try {
        await deleteComment(id);
      } catch (err) {
        log.warn('[todo-parse] delete failed', err);
      }
    };

    const scan = async (ignoreActive: boolean): Promise<void> => {
      // The block the cursor is in is still being composed — skip projecting it
      // (a blur sweep passes ignoreActive so even that block gets swept).
      const active = ignoreActive ? null : activeBlockId(editor);

      // 1) Collect marker blocks (blockId → raw task text) and every block id
      //    currently in the doc (to tell "block deleted" from "marker removed").
      const markers = new Map<string, string>();
      const docBlockIds = new Set<string>();
      editor.state.doc.descendants((node) => {
        if (!isBlockType(node.type.name)) return;
        const id = node.attrs?.id as string | undefined;
        if (!id) return;
        docBlockIds.add(id);
        const m = TODO_RE.exec(node.textContent);
        if (!m) return;
        const raw = (m[1] ?? '').trim() || '（此处待办）';
        if (!markers.has(id)) markers.set(id, raw);
      });

      // Latch loaded-state once the doc carries real content. Stays latched for
      // the mount's life so a later "delete the last block" still reconciles.
      if (editor.state.doc.textContent.trim().length > 0) loadedRef.current = true;

      // 2) Index existing auto-parsed projections for this chapter by block id,
      //    across ALL statuses (so resolved todos still block re-spawn).
      const byBlock = new Map<string, Comment[]>();
      for (const c of useDataStore.getState().comments) {
        if (c.projectId !== projectId || c.targetId !== nodeId || c.kind !== 'todo') continue;
        if (!c.metadataJson) continue;
        let meta: Partial<TodoAutoparseMeta> | null = null;
        try {
          meta = JSON.parse(c.metadataJson) as Partial<TodoAutoparseMeta>;
        } catch {
          continue; // malformed metadata — ignore
        }
        if (meta?.kind !== 'todo-autoparse' || !meta.blockId) continue;
        const arr = byBlock.get(meta.blockId) ?? [];
        arr.push(c);
        byBlock.set(meta.blockId, arr);
      }

      // 3) CREATE: a marker block with no projection in any status, as long as
      //    the cursor has left it (the block is "done").
      for (const [blockId, raw] of markers) {
        if (byBlock.has(blockId)) continue;
        if (blockId === active) continue;
        const meta: TodoAutoparseMeta = {
          kind: 'todo-autoparse',
          blockId,
          text: normalize(raw),
        };
        try {
          await createComment({
            kind: 'todo',
            targetKind: 'node',
            targetId: nodeId,
            targetBlockId: blockId,
            bodyJson: createPlainCommentDoc(raw),
            authorKind: 'copilot',
            authorName: 'Copilot',
            source: 'manual',
            metadataJson: JSON.stringify(meta),
          });
        } catch (err) {
          log.warn('[todo-parse] create failed', err);
        }
      }

      // 4) DELETE / de-dup — OPEN projections only (resolved/converted frozen).
      for (const [blockId, comments] of byBlock) {
        const open = comments.filter((c) => c.status === 'open');
        if (open.length === 0) continue;

        if (markers.has(blockId)) {
          // Marker still here — keep the oldest, drop accidental duplicates
          // (self-heals todos accreted by the previous text-keyed dedup bug).
          const sorted = open.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          for (const dupe of sorted.slice(1)) await del(dupe.id);
          continue;
        }

        // No marker for this block. Either the marker text was removed (block
        // still present) or the whole block was deleted. The latter is only
        // trusted once the doc is confirmed loaded.
        if (docBlockIds.has(blockId) || loadedRef.current) {
          for (const c of open) await del(c.id);
        }
      }
    };

    const schedule = (ignoreActive: boolean): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void scan(ignoreActive), DEBOUNCE_MS);
    };

    // Reconcile when the cursor moves to a DIFFERENT block (the marker block is
    // "done"). Intra-block moves / keystrokes are ignored so we don't churn.
    const onSelection = (): void => {
      const next = activeBlockId(editor);
      if (next === lastActiveRef.current) return;
      lastActiveRef.current = next;
      schedule(false);
    };
    // Blur sweeps every block, including the one the cursor was just sitting in.
    const onBlur = (): void => schedule(true);

    editor.on('selectionUpdate', onSelection);
    editor.on('blur', onBlur);
    // Initial sweep so markers already in loaded prose project without a fresh
    // edit (skips only the block the cursor happens to land in).
    timerRef.current = setTimeout(() => void scan(false), DEBOUNCE_MS);

    return () => {
      editor.off('selectionUpdate', onSelection);
      editor.off('blur', onBlur);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, enabled, projectId, nodeId, createComment, deleteComment]);
}
