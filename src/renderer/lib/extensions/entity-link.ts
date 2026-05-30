import { Mark, mergeAttributes } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

// Re-export from the canonical vocabulary so callers that already import
// EntityKind from this extension don't need to be rewired. New code should
// reach for `../../domain/entity-kinds` directly.
export type { EntityKind } from '../../domain/entity-kinds';
import type { EntityKind } from '../../domain/entity-kinds';

export interface EntityLinkRef {
  targetKind: EntityKind;
  targetId: string;
  targetBlockId: string | null;
}

// One detectable entity: name → { kind, id }. Both nodes (chapter titles) and
// elements participate; future kinds can be added by extending the union.
export interface AutoDetectTarget {
  kind: EntityKind;
  id: string;
}

export interface EntityLinkOptions {
  // Targets eligible for auto-detection, keyed by their display name.
  // Names are matched verbatim. The @-picker covers the more general flow.
  autoDetectTargets: Map<string, AutoDetectTarget>;
  autoDetectEnabled: boolean;
  HTMLAttributes?: Record<string, string>;
  onClick?: (ref: EntityLinkRef) => void;
}

// Mutable shared config so the plugin can react to live changes without
// re-creating the extension. The hook (`useEntityEditor`) updates these
// fields whenever settings or the entity list changes.
export const entityLinkConfig = {
  autoDetectTargets: new Map<string, AutoDetectTarget>(),
  autoDetectEnabled: true,
  // When false, clicks on entity-link marks are ignored (no navigation).
  // Visual styling is gated separately via the `data-entity-link-interactive`
  // attribute on <html> (see editor-preferences.ts and index.css).
  interactionEnabled: true,
  // Resolve whether a link's target entity still exists. Marks live inside
  // other documents' content JSON, so deleting an entity leaves dangling
  // links behind; clicking one would otherwise navigate to a phantom
  // "untitled" editor. The hook injects a store-backed implementation; the
  // permissive default keeps the extension usable in isolation/tests.
  targetExists: (_kind: EntityKind, _id: string): boolean => true,
};

export const EntityLinkPluginKey = new PluginKey('entityLink');

// Separate plugin that greys out "dangling" links — marks whose target entity
// has been deleted. Carried in its own DecorationSet so we can recompute it
// (a) on every doc change and (b) on demand when the known-entity set shifts
// (an element deleted while this doc is open). The hook fires the on-demand
// refresh by dispatching a transaction tagged with this key's meta.
export const EntityLinkDanglingPluginKey = new PluginKey<DecorationSet>(
  'entityLinkDangling',
);

const META_FLAG = 'entityLink';

const DANGLING_CLASS = 'entity-link--dangling';

// Walk the doc and decorate every entity-link span whose target no longer
// exists. The CSS for DANGLING_CLASS strips the link styling so the text reads
// as plain prose (clicks are already swallowed by the handleClick guard).
function computeDanglingDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const mark of node.marks) {
      if (mark.type.name !== 'entityLink') continue;
      const targetId = mark.attrs.targetId as string | null;
      if (!targetId) continue;
      const targetKind = (mark.attrs.targetKind as EntityKind) ?? 'element';
      if (entityLinkConfig.targetExists(targetKind, targetId)) continue;
      decorations.push(
        Decoration.inline(pos, pos + node.text.length, { class: DANGLING_CLASS }),
      );
      break; // one decoration per text node is enough
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const EntityLink = Mark.create<EntityLinkOptions>({
  name: 'entityLink',
  // Don't extend the mark across new typing past its boundary.
  inclusive: false,
  // Don't merge adjacent marks unless attrs match exactly.
  excludes: '',

  addOptions() {
    return {
      autoDetectTargets: new Map(),
      autoDetectEnabled: true,
      HTMLAttributes: {},
      onClick: undefined,
    };
  },

  onCreate() {
    entityLinkConfig.autoDetectTargets = this.options.autoDetectTargets;
    entityLinkConfig.autoDetectEnabled = this.options.autoDetectEnabled;
  },

  addAttributes() {
    return {
      targetKind: {
        default: 'element',
        parseHTML: (el) => (el.getAttribute('data-target-kind') as EntityKind) ?? 'element',
        renderHTML: (attrs) => ({ 'data-target-kind': attrs.targetKind }),
      },
      targetId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-target-id'),
        renderHTML: (attrs) =>
          attrs.targetId ? { 'data-target-id': attrs.targetId } : {},
      },
      targetBlockId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-target-block-id'),
        renderHTML: (attrs) =>
          attrs.targetBlockId ? { 'data-target-block-id': attrs.targetBlockId } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-target-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const targetKind = HTMLAttributes['data-target-kind'] ?? 'element';
    const deepLink = HTMLAttributes['data-target-block-id'] ? ' entity-link--deep' : '';
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes ?? {}, HTMLAttributes, {
        class: `entity-link entity-link--${targetKind}${deepLink}`,
        style: 'cursor: pointer;',
      }),
      0,
    ];
  },

  addProseMirrorPlugins() {
    const markType = this.type;
    const onClick = this.options.onClick;

    return [
      new Plugin({
        key: EntityLinkPluginKey,

        // Auto-detect entity-name matches (both element names and chapter
        // titles) in newly-typed text and attach an entityLink mark.
        // The picker covers manual / non-name-based mentions.
        appendTransaction(transactions, _oldState, newState) {
          if (!entityLinkConfig.autoDetectEnabled) return null;
          if (entityLinkConfig.autoDetectTargets.size === 0) return null;
          if (!transactions.some((t) => t.docChanged)) return null;
          // Undo/redo transactions can carry mapped ranges that no longer fit
          // the post-history document. Auto-detect is only for fresh typing, so
          // stay out of the history plugin's replay path entirely.
          if (transactions.some((t) => isHistoryTransaction(t))) return null;
          // Skip our own auto-detect transactions to avoid recursion.
          if (transactions.some((t) => t.getMeta(META_FLAG))) return null;

          const tr = newState.tr;
          let modified = false;

          // Widest registered name — used to expand the search window so a
          // multi-transaction insert (e.g. CJK IME inserts "米拉" + "·" +
          // "蓝" as three separate transactions, each with a 1-2 char
          // modified range) still finds the full name. Without padding, no
          // single transaction's modified range fits the whole name and the
          // mark is never added; only a wholesale doc reload (which is one
          // big transaction) recovers it — that's why refresh "fixes" it.
          let maxNameLength = 0;
          entityLinkConfig.autoDetectTargets.forEach((_target, name) => {
            if (name.length > maxNameLength) maxNameLength = name.length;
          });
          const searchPadding = Math.max(0, maxNameLength - 1);

          transactions.forEach((transaction) => {
            if (!transaction.docChanged) return;

            transaction.steps.forEach((_step, stepIdx) => {
              const stepMap = transaction.mapping.maps[stepIdx];
              if (!stepMap) return;

              stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                if (newStart === newEnd) return;
                const docSize = newState.doc.content.size;
                const from = Math.max(0, Math.min(newStart, docSize));
                const to = Math.max(from, Math.min(newEnd, docSize));
                if (from === to) return;

                newState.doc.nodesBetween(from, to, (node, nodePos) => {
                  if (!node.isText || !node.text) return;

                  const text = node.text;
                  const nodeStart = nodePos;
                  const nodeEnd = nodePos + text.length;
                  const rangeStart = Math.max(nodeStart, from);
                  const rangeEnd = Math.min(nodeEnd, to);
                  if (rangeStart >= rangeEnd) return;

                  // Expand the substring we scan by `searchPadding` chars on
                  // each side, clamped to the text node's own bounds. This
                  // lets the regex catch names that straddle the modified
                  // range (because the user just inserted a middle char).
                  // The dedup check below (`existing` mark scan) prevents
                  // re-marking text that's already linked, so re-scanning
                  // unchanged neighbors is safe.
                  const searchStartRel = Math.max(0, rangeStart - nodeStart - searchPadding);
                  const searchEndRel = Math.min(
                    text.length,
                    rangeEnd - nodeStart + searchPadding,
                  );
                  const searchAbsStart = nodeStart + searchStartRel;
                  const relevantText = text.substring(searchStartRel, searchEndRel);

                  entityLinkConfig.autoDetectTargets.forEach((target, name) => {
                    if (!name) return;
                    const regex = new RegExp(escapeRegExp(name), 'g');
                    let match: RegExpExecArray | null;
                    while ((match = regex.exec(relevantText)) !== null) {
                      const matchStart = searchAbsStart + match.index;
                      const matchEnd = matchStart + name.length;

                      // Skip if this position already carries an entityLink
                      // mark pointing at the same target.
                      const existing = node.marks.find(
                        (m) =>
                          m.type === markType &&
                          m.attrs.targetKind === target.kind &&
                          m.attrs.targetId === target.id,
                      );
                      if (existing) continue;

                      tr.addMark(
                        matchStart,
                        matchEnd,
                        markType.create({
                          targetKind: target.kind,
                          targetId: target.id,
                          targetBlockId: null,
                        }),
                      );
                      modified = true;
                    }
                  });
                });
              });
            });
          });

          if (!modified) return null;
          tr.setMeta(META_FLAG, true);
          tr.setMeta('addToHistory', false);
          return tr;
        },

        props: {
          handleClick(_view, _pos, event) {
            if (!onClick) return false;
            if (!entityLinkConfig.interactionEnabled) return false;
            const target = event.target as HTMLElement | null;
            if (!target?.classList.contains('entity-link')) return false;

            const targetKind = (target.getAttribute('data-target-kind') as EntityKind) ?? 'element';
            const targetId = target.getAttribute('data-target-id');
            if (!targetId) return false;
            // Dangling link: the target entity was deleted. Swallow the click
            // so we don't navigate to a phantom "untitled" editor, but report
            // it handled so the click doesn't also place the caret mid-word.
            if (!entityLinkConfig.targetExists(targetKind, targetId)) return true;
            const targetBlockId = target.getAttribute('data-target-block-id');

            onClick({ targetKind, targetId, targetBlockId });
            return true;
          },
        },
      }),

      // Dangling-link decorations. Kept in plugin state so we only re-walk the
      // doc when it changes or when the hook forces a refresh (entity deleted
      // while this doc is open) via a meta-tagged transaction.
      new Plugin<DecorationSet>({
        key: EntityLinkDanglingPluginKey,
        state: {
          init: (_config, state) => computeDanglingDecorations(state.doc),
          apply(tr, value) {
            if (tr.docChanged || tr.getMeta(EntityLinkDanglingPluginKey)) {
              return computeDanglingDecorations(tr.doc);
            }
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return EntityLinkDanglingPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
