/**
 * Agent-edit prose decorations: the auto-reveal mask.
 *
 * An Agent edit lands in the live document before its reveal overlay plays, so
 * the changed blocks are masked inside the document until the overlay owns
 * them. The plugin is dumb: it just holds a DecorationSet, replaced wholesale
 * via a `setMeta(AgentDiffPluginKey, set)` transaction (and mapped through
 * edits in between). Everything is defensively guarded — a bad position must
 * never break the editor.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { AgentBlockChange } from '../agent/block-diff';

export const AgentDiffPluginKey = new PluginKey<DecorationSet>('agentDiff');

/**
 * A changed/new block already exists in live Yjs before its reveal. It must
 * stay masked in the real editor until the overlay owns it; otherwise the
 * author sees the completed text with a second typewriter pass on top.
 */
export function agentChangeUsesAutoRevealMask(change: AgentBlockChange): boolean {
  return !change.field && change.op !== 'deleted';
}

/**
 * Select every outstanding changed/new block, regardless of whether
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

/** Build the one decoration projection used by the live prose editor. */
export function buildAgentEditorDecorations(
  doc: PMNode,
  autoRevealBlockIds: readonly string[] | null | undefined,
): DecorationSet {
  return DecorationSet.create(doc, agentAutoRevealMaskDecorations(doc, autoRevealBlockIds));
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
