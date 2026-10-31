import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { createOwnedSuggestion, type EditorSuggestionGate } from '../editor-suggestion-interaction';
import { createSuggestionMenu, type SuggestionMenuRow } from '../editor-suggestion-menu';
import type { EntityKind } from './entity-link';

// Distinct from the slash-menu's pluginKey so the two suggestion plugins can
// coexist on the same editor.
export const EntityMentionPluginKey = new PluginKey('entityMention$');

// A mentionable entity surfaced in the picker. Patches aren't surfaced in the
// picker today; their identity is created from the chapter side, not chosen
// from a flat list.
export interface MentionableEntity {
  kind: EntityKind; // 'node' | 'element'
  id: string;
  name: string;
  // Optional aliases — only elements carry these today, but typed at this
  // level so the picker can match against them uniformly. The picker expands
  // each alias into its own row so the user can pick the exact form they
  // want inserted (mirrors inline auto-detect, which also marks aliases).
  aliases?: string[];
}

// Variants returned by the items() function so the keyboard handler and the
// render layer can react uniformly. `create-element` is a virtual item that
// resolves into a fresh element at command time.
//
// `displayText` is what gets inserted into the document — for an alias row
// it's the alias string, not the canonical name. Keeps the picker consistent
// with inline auto-detect (which preserves whatever surface form the user
// typed).
export type MentionPickerItem =
  | { variant: 'entity'; entity: MentionableEntity; displayText: string }
  | { variant: 'create-element'; name: string };

export interface EntityMentionSuggestionOptions {
  // Source of truth for the entity list. Called on every keystroke; should be
  // cheap (the picker filters in-memory).
  getEntities: () => MentionableEntity[];
  gate?: EditorSuggestionGate;
  // If provided, the picker offers a "+ create element 「query」" affordance
  // when the query is non-empty and doesn't exactly match an existing element
  // by name.
  onCreateElement?: (name: string) => Promise<{ id: string; name: string } | null>;
  // Optional pluginKey override.
  pluginKey?: SuggestionOptions['pluginKey'];
}

const MAX_RESULTS = 30;

export const EntityMentionSuggestion = Extension.create<EntityMentionSuggestionOptions>({
  name: 'entityMentionSuggestion',

  addOptions() {
    return {
      getEntities: () => [],
      onCreateElement: undefined,
      pluginKey: undefined,
    };
  },

  addProseMirrorPlugins() {
    const { editor: extensionEditor, options } = this;
    return [
      createOwnedSuggestion<MentionPickerItem>({
        gate: options.gate,
        editor: extensionEditor,
        pluginKey: options.pluginKey ?? EntityMentionPluginKey,
        char: '@',
        startOfLine: false,
        allowSpaces: false,
        decorationTag: 'span',
        decorationClass: 'entity-mention-suggestion',
        items: ({ query }) => {
          const entities = options.getEntities();
          const q = query.trim().toLowerCase();
          // Expand each entity into one row per surface form (name + each
          // alias). Filtering then runs against the surface form itself, so
          // typing an alias surfaces just that alias row — and the inserted
          // text matches what the user actually searched for.
          type Candidate = { displayText: string; entity: MentionableEntity };
          const candidates: Candidate[] = [];
          for (const entity of entities) {
            if (entity.name) candidates.push({ displayText: entity.name, entity });
            for (const alias of entity.aliases ?? []) {
              if (alias) candidates.push({ displayText: alias, entity });
            }
          }
          const filtered = q
            ? candidates.filter((c) => c.displayText.toLowerCase().includes(q))
            : candidates;
          const sorted = filtered.slice().sort((a, b) => {
            // Elements first, then nodes — element mentions are the dominant
            // case during chapter writing.
            if (a.entity.kind !== b.entity.kind) {
              return a.entity.kind === 'element' ? -1 : 1;
            }
            return a.displayText.localeCompare(b.displayText);
          });
          const items: MentionPickerItem[] = sorted
            .slice(0, MAX_RESULTS)
            .map((c) => ({ variant: 'entity', entity: c.entity, displayText: c.displayText }));
          // Suppress the "+ create element" affordance if the query already
          // matches an existing element's name OR any of its aliases — the
          // user almost certainly meant the existing one.
          const matchesExistingElement = entities.some(
            (e) =>
              e.kind === 'element' &&
              (e.name.toLowerCase() === q || (e.aliases ?? []).some((a) => a.toLowerCase() === q)),
          );
          if (q && options.onCreateElement && !matchesExistingElement) {
            items.push({ variant: 'create-element', name: query.trim() });
          }
          return items;
        },
        command: async ({ editor, range, props }, stillCurrent) => {
          const item = props as MentionPickerItem;
          let resolved: { kind: EntityKind; id: string; name: string } | null = null;

          if (item.variant === 'entity') {
            // Use the picked surface form (alias or canonical name) as the
            // inserted text — matches what the user searched for and stays
            // consistent with inline auto-detect's alias handling.
            resolved = {
              kind: item.entity.kind,
              id: item.entity.id,
              name: item.displayText,
            };
          } else if (item.variant === 'create-element' && options.onCreateElement) {
            const created = await options.onCreateElement(item.name);
            if (created) {
              resolved = { kind: 'element', id: created.id, name: created.name };
            }
          }

          if (!stillCurrent()) return;

          if (!resolved) {
            // Cancel cleanly: just remove the @-trigger text so the editor
            // doesn't end up with a literal "@query" stuck in the buffer.
            editor.chain().focus().deleteRange(range).run();
            return;
          }

          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent([
              {
                type: 'text',
                text: resolved.name,
                marks: [
                  {
                    type: 'entityLink',
                    attrs: {
                      targetKind: resolved.kind,
                      targetId: resolved.id,
                      targetBlockId: null,
                    },
                  },
                ],
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: () => {
          let menu: ReturnType<typeof createSuggestionMenu> | null = null;
          let items: MentionPickerItem[] = [];
          let selected = 0;
          let keyboardMode = false;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let lastProps: any = null;

          // An entity leads with its own kind mark and names its kind at the
          // far end; creating an element comes last, under a hairline.
          const rowFor = (item: MentionPickerItem): SuggestionMenuRow => {
            if (item.variant === 'create-element') {
              return { label: `创建要素「${item.name}」`, icon: 'plus', group: 'create' };
            }
            const element = item.entity.kind === 'element';
            return {
              label: item.displayText,
              icon: { kind: element ? 'element' : 'chapter', seed: item.entity.id },
              trail: element ? '要素' : '章节',
              group: 'entities',
            };
          };

          const renderList = (props: {
            items?: MentionPickerItem[];
            command: (item: MentionPickerItem) => void;
          }) => {
            lastProps = props;
            items = props.items ?? [];
            if (!menu) return;
            menu.render(
              items.map(rowFor),
              {
                onPick: (index) => lastProps?.command(items[index]),
                onPoint: (index, moved) => {
                  // The pointer takes over from the keys only once it moves.
                  if (keyboardMode && !moved) return;
                  keyboardMode = false;
                  selected = index;
                  menu?.select(selected, false);
                },
              },
              '没有匹配的实体',
            );
            menu.select(selected, keyboardMode);
          };

          const updatePosition = (clientRect?: () => DOMRect | null) => {
            const rect = clientRect?.();
            if (rect && menu) menu.place(rect);
          };

          return {
            onStart: (props) => {
              menu?.root.remove();
              menu = createSuggestionMenu('mention', '@');
              document.body.appendChild(menu.root);
              selected = 0;
              keyboardMode = false;
              renderList(props as Parameters<typeof renderList>[0]);
              updatePosition(props.clientRect ?? undefined);
            },
            onUpdate: (props) => {
              // Reset selection when query changes drastically (different item count)
              const newCount = (props.items as MentionPickerItem[] | undefined)?.length ?? 0;
              if (selected >= newCount) selected = 0;
              renderList(props as Parameters<typeof renderList>[0]);
              updatePosition(props.clientRect ?? undefined);
            },
            onKeyDown: ({ event }) => {
              if (event.key === 'Escape') return true;
              if (!items.length) return false;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                keyboardMode = true;
                const step = event.key === 'ArrowDown' ? 1 : -1;
                selected = (selected + step + items.length) % items.length;
                menu?.select(selected, true);
                return true;
              }
              if (event.key === 'Enter') {
                lastProps?.command(items[selected]);
                return true;
              }
              return false;
            },
            onExit: () => {
              menu?.root.remove();
              menu = null;
              items = []; lastProps = null; selected = 0; keyboardMode = false;
            },
          };
        },
      }),
    ];
  },
});
