/**
 * Agent-edit prose decorations (#3, approve diff + auto-reveal mask).
 *
 * In approve mode the agent's edit has already landed in the doc (write-first inline review),
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

function deletedBlockWidget(text: string, blockId: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'agent-diff-deleted-block';
  // Tag with the deleted block's id so the floating ✓/✗ control (AgentEditAnimator)
  // can anchor to this in-place ghost directly, instead of guessing via the
  // surviving predecessor (which fails for a first-block deletion).
  div.dataset.agentDeletedBlock = blockId;
  div.textContent = text;
  return div;
}

/** Build the diff decorations for a doc from the pending block changes. */
function agentDiffDecorations(doc: PMNode, changes: AgentBlockChange[]): Decoration[] {
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
          Decoration.widget(at, () => deletedBlockWidget(c.oldText, c.blockId), {
            side: 1,
            key: `adel:${c.blockId}`,
          }),
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
  return decos;
}

/**
 * A changed/new auto-mode block already exists in live Yjs before its reveal.
 * It must stay masked in the real editor until the overlay owns it; otherwise
 * the author sees the completed text with a second typewriter pass on top.
 */
export function agentChangeUsesAutoRevealMask(change: AgentBlockChange): boolean {
  return !change.field && change.mode === 'auto' && change.op !== 'deleted';
}

/**
 * Select every outstanding auto-mode changed/new block, regardless of whether
 * it belongs to an existing file or an Added first-open projection. While an
 * Added editor is still waiting for stable ids, `maskAllText` hides every
 * textual top-level block so there is no unmasked first paint.
 */
export function planAgentAutoRevealMask(
  changes: readonly AgentBlockChange[],
  maskAllText = false,
  guardedBlockIds: readonly string[] = [],
): string[] | null | undefined {
  if (maskAllText) return null;
  const blockIds = [
    ...new Set(
      [
        ...guardedBlockIds,
        ...changes
          .filter(agentChangeUsesAutoRevealMask)
          .map((change) => change.blockId),
      ].filter(Boolean),
    ),
  ];
  return blockIds.length > 0 ? blockIds : undefined;
}

/**
 * `null` means stable ids have not materialized yet, so every textual top-level
 * block is masked; an array masks only those outstanding ids. Node decorations
 * are the canonical way to do this inside contenteditable — ProseMirror would
 * strip ad-hoc DOM classes during reconciliation.
 */
function agentAutoRevealMaskDecorations(
  doc: PMNode,
  blockIds: readonly string[] | null | undefined,
): Decoration[] {
  if (blockIds === undefined) return [];
  const ids = blockIds === null ? null : new Set(blockIds);
  const decos: Decoration[] = [];
  doc.forEach((node, offset) => {
    const blockId = (node.attrs as { id?: string | null } | undefined)?.id ?? null;
    if (!node.textContent.trim()) return;
    if (ids && (!blockId || !ids.has(blockId))) return;
    decos.push(
      Decoration.node(
        offset,
        offset + node.nodeSize,
        { class: 'agent-auto-reveal-pending' },
        { agentAutoRevealMask: true, blockId },
      ),
    );
  });
  return decos;
}

export function buildAgentDiffDecorations(
  doc: PMNode,
  changes: AgentBlockChange[],
): DecorationSet {
  return DecorationSet.create(doc, agentDiffDecorations(doc, changes));
}

/** Build the one decoration projection used by the live prose editor. */
export function buildAgentEditorDecorations(
  doc: PMNode,
  approveChanges: AgentBlockChange[],
  autoRevealBlockIds: readonly string[] | null | undefined,
): DecorationSet {
  return DecorationSet.create(doc, [
    ...agentDiffDecorations(doc, approveChanges),
    ...agentAutoRevealMaskDecorations(doc, autoRevealBlockIds),
  ]);
}

/** Holds the unified Agent prose DecorationSet; replaced wholesale via setMeta,
 *  mapped through edits otherwise. */
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
