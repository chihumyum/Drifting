import type { Extension, Editor } from '@tiptap/core';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';

import type { BrushIconName } from '../../components/ui/BrushIcon';
import { createSuggestionMenu } from '../editor-suggestion-menu';
import { getBlockFormatItems } from './block-format-items';
import SlashMenu from './slash-menu';

// Unique plugin key so the slash menu's @tiptap/suggestion plugin doesn't
// collide with other suggestion-based extensions (entity-mention picker, etc.).
export const SlashMenuPluginKey = new PluginKey('slashMenu$');

export interface SlashMenuExtraItem {
  id: string;
  title: string;
  /** Every row of the menu leads with its icon. */
  icon: BrushIconName;
  run: (ctx: { editor: Editor }) => void;
}

// The block formats, drawn as the selection bar draws them.
const BLOCK_FORMAT_ICONS: Record<string, BrushIconName> = {
  paragraph: 'fmt-paragraph',
  h1: 'fmt-h1',
  h2: 'fmt-h2',
  h3: 'fmt-h3',
  blockquote: 'fmt-quote',
};

interface SlashRow {
  id: string;
  title: string;
  icon: BrushIconName;
  /** The block formats first, then what is inserted, parted by a hairline. */
  group: 'format' | 'insert';
  run?: () => void;
}

export interface CreateDefaultSlashMenuOverrides {
  // Extra items appended to the default item list. Filtered by the same query
  // as the defaults. Use for caller-specific actions like /patch.
  extraItems?: SlashMenuExtraItem[] | (() => SlashMenuExtraItem[] | undefined);
  // Mirror SuggestionOptions overrides loosely as any to stay framework-agnostic in the package
  // Consumers can pass items/command/render/allow and any other options supported by SlashMenu
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Factory to create a SlashMenu extension configured with sensible defaults.
 * Callers can override any option by passing an overrides object.
 */
export function createDefaultSlashMenu(overrides: CreateDefaultSlashMenuOverrides = {}): Extension {
  const { extraItems, ...passthroughOverrides } = overrides;
  return (SlashMenu as unknown as Extension).configure({
    pluginKey: SlashMenuPluginKey,
    char: '/',
    startOfLine: false,
    allowSpaces: false,
    decorationClass: 'tiptap-slash-decoration',
    items: ({ query, editor: ed }: Parameters<NonNullable<SuggestionOptions['items']>>[0]) => {
      const resolvedExtraItems = typeof extraItems === 'function' ? extraItems() : extraItems;
      const all = [
        // Block-type transforms shared with the right-click「格式」flyout (see
        // block-format-items.ts). Bind each to this editor instance.
        ...getBlockFormatItems().map((item): SlashRow => ({
          id: item.id,
          title: item.title,
          icon: BLOCK_FORMAT_ICONS[item.id] ?? 'fmt-paragraph',
          group: 'format',
          run: () => item.run(ed),
        })),
        // Insert-type: caret-only (it replaces a non-empty selection), so it
        // stays in the slash menu and is excluded from the selection flyout.
        { id: 'hr', title: '分隔线', icon: 'minus', group: 'insert', run: () => ed.chain().focus().setHorizontalRule().run() } satisfies SlashRow,
        ...(resolvedExtraItems ?? []).map((item): SlashRow => ({
          id: item.id,
          title: item.title,
          icon: item.icon,
          group: 'insert',
          run: () => item.run({ editor: ed }),
        })),
      ];
      const q = String(query ?? '')
        .trim()
        .toLowerCase();
      return q ? all.filter((i) => i.title.toLowerCase().includes(q)) : all;
    },
    command: ({
      editor: ed,
      range,
      props,
    }: Parameters<NonNullable<SuggestionOptions['command']>>[0]) => {
      ed.chain().focus().deleteRange(range).run();
      props?.run?.();
    },
    render: () => {
      let menu: ReturnType<typeof createSuggestionMenu> | null = null;
      let selected = 0;
      let items: SlashRow[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let lastProps: any = null;
      let keyboardMode = false; // Track whether user is using keyboard navigation

      const renderList = (props: { items?: SlashRow[]; command: (item: SlashRow) => void }) => {
        lastProps = props;
        items = props.items || [];
        if (selected >= items.length) selected = 0;
        if (!menu) return;
        menu.render(
          items.map((item) => ({ label: item.title, icon: item.icon, group: item.group })),
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
        );
        menu.select(selected, keyboardMode);
      };

      const updatePosition = (clientRect?: () => DOMRect | null) => {
        const rect = clientRect?.();
        if (rect && menu) menu.place(rect);
      };

      return {
        onStart: (props: { clientRect?: () => DOMRect | null }) => {
          menu?.root.remove();
          selected = 0; keyboardMode = false;
          menu = createSuggestionMenu('slash', '/');
          document.body.appendChild(menu.root);
          // @ts-expect-error - props type is broad
          renderList(props);
          updatePosition(props.clientRect);
        },
        onUpdate: (props: { clientRect?: () => DOMRect | null }) => {
          // @ts-expect-error - props type is broad
          renderList(props);
          updatePosition(props.clientRect);
        },
        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
          if (event.key === 'Escape') {
            return true;
          }
          if (!items?.length) {
            return false;
          }
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
          menu?.root.remove(); menu = null;
          items = []; lastProps = null; selected = 0; keyboardMode = false;
        },
      };
    },
    ...passthroughOverrides,
  }) as unknown as Extension;
}

export default createDefaultSlashMenu;
