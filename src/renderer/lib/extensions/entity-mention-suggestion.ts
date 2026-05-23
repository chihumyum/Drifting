import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
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
}

// Variants returned by the items() function so the keyboard handler and the
// render layer can react uniformly. `create-element` is a virtual item that
// resolves into a fresh element at command time.
export type MentionPickerItem =
  | { variant: 'entity'; entity: MentionableEntity }
  | { variant: 'create-element'; name: string };

export interface EntityMentionSuggestionOptions {
  // Source of truth for the entity list. Called on every keystroke; should be
  // cheap (the picker filters in-memory).
  getEntities: () => MentionableEntity[];
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
    const extension = this;
    return [
      Suggestion<MentionPickerItem>({
        editor: this.editor,
        pluginKey: this.options.pluginKey ?? EntityMentionPluginKey,
        char: '@',
        startOfLine: false,
        allowSpaces: false,
        decorationTag: 'span',
        decorationClass: 'entity-mention-suggestion',
        items: ({ query }) => {
          const entities = extension.options.getEntities();
          const q = query.trim().toLowerCase();
          const filtered = q
            ? entities.filter((e) => e.name.toLowerCase().includes(q))
            : entities;
          const sorted = filtered.slice().sort((a, b) => {
            // Elements first, then nodes — element mentions are the dominant
            // case during chapter writing.
            if (a.kind !== b.kind) return a.kind === 'element' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          const items: MentionPickerItem[] = sorted
            .slice(0, MAX_RESULTS)
            .map((entity) => ({ variant: 'entity', entity }));
          if (
            q &&
            extension.options.onCreateElement &&
            !entities.some((e) => e.kind === 'element' && e.name.toLowerCase() === q)
          ) {
            items.push({ variant: 'create-element', name: query.trim() });
          }
          return items;
        },
        command: async ({ editor, range, props }) => {
          const item = props as MentionPickerItem;
          let resolved:
            | { kind: EntityKind; id: string; name: string }
            | null = null;

          if (item.variant === 'entity') {
            resolved = item.entity;
          } else if (item.variant === 'create-element' && extension.options.onCreateElement) {
            const created = await extension.options.onCreateElement(item.name);
            if (created) {
              resolved = { kind: 'element', id: created.id, name: created.name };
            }
          }

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
                      origin: 'manual',
                    },
                  },
                ],
              },
              { type: 'text', text: ' ' },
            ])
            .run();
        },
        render: () => {
          let container: HTMLDivElement | null = null;
          let items: MentionPickerItem[] = [];
          let selected = 0;
          let keyboardMode = false;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let lastProps: any = null;

          const labelFor = (item: MentionPickerItem): { tag: string; text: string } => {
            if (item.variant === 'create-element') {
              return { tag: '新建', text: `创建元素「${item.name}」` };
            }
            return {
              tag: item.entity.kind === 'element' ? '元素' : '章节',
              text: item.entity.name,
            };
          };

          const renderList = (props: {
            items?: MentionPickerItem[];
            command: (item: MentionPickerItem) => void;
          }) => {
            lastProps = props;
            items = props.items ?? [];
            if (!container) return;
            container.innerHTML = '';

            const list = document.createElement('div');
            // Tracked across the forEach below; typed broadly so TS doesn't
            // narrow it to never after the initializer.
            let selectedBtn = null as HTMLButtonElement | null;
            list.style.display = 'flex';
            list.style.flexDirection = 'column';
            list.style.background = '#fefdfb';
            list.style.border = '1px solid hsl(var(--accent-border))';
            list.style.borderRadius = '6px';
            list.style.boxShadow = '0 4px 16px rgba(139, 115, 85, 0.12)';
            // max-height is set dynamically by updatePosition based on
            // available room above / below the trigger.
            list.style.overflowY = 'auto';
            list.style.overflowX = 'hidden';
            list.style.minWidth = '220px';
            list.style.maxWidth = '320px';
            list.style.fontFamily = 'Georgia, "Times New Roman", "Songti SC", SimSun, serif';
            list.style.fontSize = '13px';

            if (items.length === 0) {
              const empty = document.createElement('div');
              empty.textContent = '没有匹配的实体';
              empty.style.padding = '8px 12px';
              empty.style.color = '#9b8a78';
              list.appendChild(empty);
              container.appendChild(list);
              return;
            }

            const accentHsl = getComputedStyle(document.documentElement)
              .getPropertyValue('--accent')
              .trim();
            const accentColor = accentHsl ? `hsl(${accentHsl})` : '#b89968';

            items.forEach((item, idx) => {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.style.display = 'flex';
              btn.style.alignItems = 'center';
              btn.style.gap = '8px';
              btn.style.padding = '6px 12px';
              btn.style.textAlign = 'left';
              btn.style.border = 'none';
              btn.style.background = idx === selected ? accentColor : '#fefdfb';
              btn.style.color = idx === selected ? '#fefdfb' : '#5a4a3a';
              btn.style.cursor = 'pointer';
              btn.style.fontSize = '13px';
              btn.style.fontFamily =
                'Georgia, "Times New Roman", "Songti SC", SimSun, serif';
              btn.style.transition = 'all 0.15s ease';

              const { tag, text } = labelFor(item);
              const chip = document.createElement('span');
              chip.textContent = tag;
              chip.style.fontSize = '10px';
              chip.style.padding = '2px 6px';
              chip.style.borderRadius = '3px';
              chip.style.background = idx === selected ? 'rgba(255,255,255,0.2)' : '#f1ead9';
              chip.style.color = idx === selected ? '#fefdfb' : '#8b7355';
              chip.style.flexShrink = '0';

              const label = document.createElement('span');
              label.textContent = text;
              label.style.flex = '1';
              label.style.overflow = 'hidden';
              label.style.textOverflow = 'ellipsis';
              label.style.whiteSpace = 'nowrap';

              btn.appendChild(chip);
              btn.appendChild(label);

              btn.onmouseenter = () => {
                if (!keyboardMode) {
                  selected = idx;
                  renderList(lastProps);
                }
              };
              btn.onmousemove = () => {
                if (keyboardMode) {
                  keyboardMode = false;
                  selected = idx;
                  renderList(lastProps);
                }
              };
              btn.onmousedown = (e) => e.preventDefault();
              btn.onclick = () => lastProps?.command(items[idx]);
              if (idx === selected) selectedBtn = btn;
              list.appendChild(btn);
            });

            container.appendChild(list);
            if (keyboardMode && selectedBtn) {
              selectedBtn.scrollIntoView({ block: 'nearest' });
            }
          };

          const updatePosition = (clientRect?: () => DOMRect | null) => {
            const rect = clientRect?.();
            if (!rect || !container) return;
            container.style.position = 'fixed';
            container.style.zIndex = '9999';
            container.style.left = `${rect.left}px`;
            const FLIP_THRESHOLD = 200;
            const MARGIN = 8;
            const viewportHeight = window.innerHeight;
            const roomBelow = viewportHeight - rect.bottom - MARGIN;
            const roomAbove = rect.top - MARGIN;
            const list = container.firstElementChild as HTMLDivElement | null;
            if (roomBelow < FLIP_THRESHOLD && roomAbove > roomBelow) {
              container.style.top = '';
              container.style.bottom = `${viewportHeight - rect.top + 2}px`;
              if (list) list.style.maxHeight = `${roomAbove}px`;
            } else {
              container.style.bottom = '';
              container.style.top = `${rect.bottom + 2}px`;
              if (list) list.style.maxHeight = `${Math.max(roomBelow, 160)}px`;
            }
          };

          return {
            onStart: (props) => {
              container = document.createElement('div');
              document.body.appendChild(container);
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
              if (event.key === 'ArrowDown') {
                keyboardMode = true;
                selected = (selected + 1) % items.length;
                renderList(lastProps);
                return true;
              }
              if (event.key === 'ArrowUp') {
                keyboardMode = true;
                selected = (selected - 1 + items.length) % items.length;
                renderList(lastProps);
                return true;
              }
              if (event.key === 'Enter') {
                lastProps?.command(items[selected]);
                return true;
              }
              return false;
            },
            onExit: () => {
              container?.remove();
              container = null;
            },
          };
        },
      }),
    ];
  },
});
