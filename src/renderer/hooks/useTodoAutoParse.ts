/**
 * useTodoAutoParse (Task 3) — projects "TODO" markers typed in the prose into
 * comment-todos bound to their block, so the right-sidebar TODO list and AI
 * task pipelines can consume them.
 *
 * Model: a comment-todo is a PROJECTION of a prose TODO marker. A debounced
 * scan (block-complete proxy, not per-keystroke) finds marker blocks and
 * creates a todo for any not already projected. Dedup is by (blockId +
 * normalized text) across ALL statuses — so resolving a todo stops it from
 * re-spawning. There is deliberately NO "forbid re-parse" flag (dropped per
 * spec): deleting the marker text is how you remove a projection; deleting the
 * comment while the marker still exists simply re-projects on the next scan.
 *
 * Creation is non-destructive only — we never auto-delete comments (todos may
 * have been edited / linked), so this can't clobber user work.
 *
 * Origin marker: authorKind 'copilot' + metadataJson {kind:'todo-autoparse'}.
 * source stays 'manual' so it renders as a normal anchored todo, NOT a
 * copilot accept/reject suggestion card (CommentRail keys that off source).
 */
import { useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import loglevel from 'loglevel';
import { isBlockType } from '../lib/extensions/block-id';
import { createPlainCommentDoc } from '../domain/comment';
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
  blockId: string;
  /** Normalized marker text — the dedup key alongside blockId. */
  text: string;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
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
  const { createComment } = useComment({ projectId, userId });
  const enabled = useSettingsStore((s) => s.copilotEnabled);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const scan = async (): Promise<void> => {
      // Collect current TODO markers in the doc.
      const markers: { blockId: string; raw: string; norm: string }[] = [];
      editor.state.doc.descendants((node) => {
        if (!isBlockType(node.type.name)) return;
        const id = node.attrs?.id as string | undefined;
        if (!id) return;
        const m = TODO_RE.exec(node.textContent);
        if (!m) return;
        const raw = (m[1] ?? '').trim() || '（此处待办）';
        markers.push({ blockId: id, raw, norm: normalize(raw) });
      });
      if (markers.length === 0) return;

      // Dedup set: existing auto-parsed todos for this chapter (any status).
      const seen = new Set<string>();
      for (const c of useDataStore.getState().comments) {
        if (c.projectId !== projectId || c.targetId !== nodeId || c.kind !== 'todo') continue;
        if (!c.metadataJson) continue;
        try {
          const meta = JSON.parse(c.metadataJson) as Partial<TodoAutoparseMeta>;
          if (meta.kind === 'todo-autoparse' && meta.blockId && typeof meta.text === 'string') {
            seen.add(`${meta.blockId}::${meta.text}`);
          }
        } catch {
          /* ignore malformed metadata */
        }
      }

      for (const mk of markers) {
        const key = `${mk.blockId}::${mk.norm}`;
        if (seen.has(key)) continue;
        seen.add(key); // in-batch dedup
        const meta: TodoAutoparseMeta = {
          kind: 'todo-autoparse',
          blockId: mk.blockId,
          text: mk.norm,
        };
        try {
          await createComment({
            kind: 'todo',
            targetKind: 'node',
            targetId: nodeId,
            targetBlockId: mk.blockId,
            bodyJson: createPlainCommentDoc(mk.raw),
            authorKind: 'copilot',
            authorName: 'Copilot',
            source: 'manual',
            metadataJson: JSON.stringify(meta),
          });
        } catch (err) {
          log.warn('[todo-parse] create failed', err);
        }
      }
    };

    const onUpdate = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void scan();
      }, DEBOUNCE_MS);
    };

    editor.on('update', onUpdate);
    // Scan once on mount too, so markers in already-loaded prose project even
    // without a fresh edit.
    timerRef.current = setTimeout(() => void scan(), DEBOUNCE_MS);

    return () => {
      editor.off('update', onUpdate);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, enabled, projectId, nodeId, createComment]);
}
