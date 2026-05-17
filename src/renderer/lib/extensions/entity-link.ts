import { Mark, mergeAttributes } from '@tiptap/core';
import { isHistoryTransaction } from '@tiptap/pm/history';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export type EntityKind = 'node' | 'element' | 'patch' | 'category' | 'storyline';
export type LinkOrigin = 'manual' | 'auto' | 'ai';

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
};

export const EntityLinkPluginKey = new PluginKey('entityLink');

const META_FLAG = 'entityLink';

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
      origin: {
        default: 'manual',
        parseHTML: (el) => (el.getAttribute('data-origin') as LinkOrigin) ?? 'manual',
        renderHTML: (attrs) => ({ 'data-origin': attrs.origin ?? 'manual' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-target-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const targetKind = HTMLAttributes['data-target-kind'] ?? 'element';
    const origin = HTMLAttributes['data-origin'] ?? 'manual';
    const deepLink = HTMLAttributes['data-target-block-id'] ? ' entity-link--deep' : '';
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes ?? {}, HTMLAttributes, {
        class: `entity-link entity-link--${targetKind} entity-link--${origin}${deepLink}`,
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
        // titles) in newly-typed text and attach an entityLink mark with
        // origin='auto'. The picker covers manual / non-name-based mentions.
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

                  const relevantText = text.substring(
                    rangeStart - nodeStart,
                    rangeEnd - nodeStart,
                  );

                  entityLinkConfig.autoDetectTargets.forEach((target, name) => {
                    if (!name) return;
                    const regex = new RegExp(escapeRegExp(name), 'g');
                    let match: RegExpExecArray | null;
                    while ((match = regex.exec(relevantText)) !== null) {
                      const matchStart = rangeStart + match.index;
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
                          origin: 'auto',
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
            const target = event.target as HTMLElement | null;
            if (!target?.classList.contains('entity-link')) return false;

            const targetKind = (target.getAttribute('data-target-kind') as EntityKind) ?? 'element';
            const targetId = target.getAttribute('data-target-id');
            if (!targetId) return false;
            const targetBlockId = target.getAttribute('data-target-block-id');

            onClick({ targetKind, targetId, targetBlockId });
            return true;
          },
        },
      }),
    ];
  },
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
