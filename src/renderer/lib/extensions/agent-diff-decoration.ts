/**
 * Agent-edit diff decorations (#3, approve mode).
 *
 * In approve mode the agent's edit has already landed in the doc (soft-approval),
 * but we want the user to review the DIFF in place — not the applied final text —
 * before accepting. Rather than float a separate layer over the prose (which lags
 * the native scroll and double-renders), we draw the diff as real ProseMirror
 * decorations INSIDE the document, so it reflows and scrolls with the text:
 *   - insertions → inline green background over the new text
 *   - deletions  → a red, struck widget showing the removed text, at its old spot
 *   - new block  → the whole block's content tinted green
 *   - deleted block → a red struck block-level ghost after its surviving neighbour
 *
 * The plugin is dumb: it just holds a DecorationSet, replaced wholesale via a
 * `setMeta(AgentDiffPluginKey, set)` transaction (and mapped through edits in
 * between). useEntityEditor computes the set from the edit store for node editors.
 * Everything is defensively guarded — a bad position must never break the editor.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { diffTokens, type AgentBlockChange } from '../agent/block-diff';

export const AgentDiffPluginKey = new PluginKey<DecorationSet>('agentDiff');

/** Locate a top-level block by its stable id attr. */
function findBlock(doc: PMNode, blockId: string): { node: PMNode; pos: number } | null {
  let res: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (res) return false;
    if ((node.attrs as { id?: string } | undefined)?.id === blockId) {
      res = { node, pos };
      return false;
    }
    return undefined;
  });
  return res;
}

/** A block is char-level diffable only if it's pure text (inline atoms like
 *  @-mentions break a plain offset→position map, so those fall back to a tint). */
function isPureText(node: PMNode): boolean {
  let pure = true;
  node.forEach((child) => {
    if (!child.isText) pure = false;
  });
  return pure;
}

function delWidget(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'agent-diff-del';
  span.textContent = text;
  return span;
}

function deletedBlockWidget(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'agent-diff-deleted-block';
  div.textContent = text;
  return div;
}

/** Build the diff decorations for a doc from the pending block changes. */
export function buildAgentDiffDecorations(doc: PMNode, changes: AgentBlockChange[]): DecorationSet {
  const decos: Decoration[] = [];
  const docEnd = doc.content.size;
  for (const c of changes) {
    try {
      if (c.op === 'deleted') {
        let at = 0;
        if (c.afterPrevId) {
          const prev = findBlock(doc, c.afterPrevId);
          if (!prev) continue;
          at = prev.pos + prev.node.nodeSize;
        }
        at = Math.max(0, Math.min(docEnd, at));
        decos.push(
          Decoration.widget(at, () => deletedBlockWidget(c.oldText), { side: 1, key: `adel:${c.blockId}` }),
        );
        continue;
      }

      const block = findBlock(doc, c.blockId);
      if (!block) continue;
      const start = block.pos + 1;
      const end = block.pos + block.node.nodeSize - 1;

      if (c.op === 'new') {
        if (end > start) decos.push(Decoration.inline(start, end, { class: 'agent-diff-ins' }));
        continue;
      }

      // changed: char-level diff only when the live block still matches the
      // recorded new text AND is pure text; otherwise a safe whole-block tint.
      if (block.node.textContent !== c.newText || !isPureText(block.node)) {
        if (end > start) decos.push(Decoration.inline(start, end, { class: 'agent-diff-changed' }));
        continue;
      }
      const max = block.node.content.size;
      const clamp = (p: number): number => Math.max(start, Math.min(start + max, p));
      const segs = diffTokens(c.oldText, c.newText);
      let off = 0;
      for (const s of segs) {
        if (s.kind === 'equal') {
          off += s.text.length;
        } else if (s.kind === 'ins') {
          const from = clamp(start + off);
          const to = clamp(start + off + s.text.length);
          if (to > from) decos.push(Decoration.inline(from, to, { class: 'agent-diff-ins' }));
          off += s.text.length;
        } else {
          const at = clamp(start + off);
          decos.push(
            Decoration.widget(at, () => delWidget(s.text), { side: -1, key: `adel:${c.blockId}:${off}` }),
          );
        }
      }
    } catch {
      /* never let a bad position break the editor */
    }
  }
  return DecorationSet.create(doc, decos);
}

/** Holds the agent-diff DecorationSet; replaced wholesale via setMeta, mapped
 *  through edits otherwise. */
export const AgentDiffDecoration = Extension.create({
  name: 'agentDiffDecoration',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: AgentDiffPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(AgentDiffPluginKey) as DecorationSet | undefined;
            if (meta !== undefined) return meta;
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return AgentDiffPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
