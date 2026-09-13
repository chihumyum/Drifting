import type { Extension, Editor } from '@tiptap/core';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';

import { getBlockFormatItems } from './block-format-items';
import SlashMenu from './slash-menu';

// Unique plugin key so the slash menu's @tiptap/suggestion plugin doesn't
// collide with other suggestion-based extensions (entity-mention picker, etc.).
export const SlashMenuPluginKey = new PluginKey('slashMenu$');

export interface SlashMenuExtraItem {
  id: string;
  title: string;
  run: (ctx: { editor: Editor }) => void;
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
        ...getBlockFormatItems().map((item) => ({
          id: item.id,
          title: item.title,
          run: () => item.run(ed),
        })),
        // Insert-type: caret-only (it replaces a non-empty selection), so it
        // stays in the slash menu and is excluded from the selection flyout.
        { id: 'hr', title: '分隔线', run: () => ed.chain().focus().setHorizontalRule().run() },
        ...(resolvedExtraItems ?? []).map((item) => ({
          id: item.id,
          title: item.title,
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
      let container: HTMLDivElement | null = null;
      let selected = 0;
      let items: Array<{ id: string; title: string; run?: () => void }> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let lastProps: any = null;
      let keyboardMode = false; // Track whether user is using keyboard navigation

      const renderList = (props: {
        items?: typeof items;
        command: (item: (typeof items)[number]) => void;
      }) => {
        lastProps = props;
        items = props.items || [];
        if (selected >= items.length) selected = 0;
        if (!container) {
          return;
        }
        container.innerHTML = '';
        const list = document.createElement('div');
        list.style.display = 'flex';
        list.style.flexDirection = 'column';
        list.style.background = '#fefdfb';
        list.style.border = '1px solid hsl(var(--accent-border))';
        list.style.borderRadius = '6px';
        list.style.boxShadow = '0 4px 16px rgba(139, 115, 85, 0.12)';
        // Scrollable list when items overflow available vertical space — the
        // positioner sets max-height dynamically based on the trigger's
        // distance to the viewport edge.
        list.style.overflowY = 'auto';
        list.style.overflowX = 'hidden';
        list.style.minWidth = '140px';
        list.style.maxWidth = '180px';
        list.style.fontFamily = 'var(--font-sans)';
        list.style.fontSize = '13px';
        let selectedBtn: HTMLButtonElement | null = null;
        items.forEach((item, idx) => {
          const btn = document.createElement('button');
          btn.textContent = item.title;
          btn.style.padding = '6px 12px';
          btn.style.textAlign = 'left';
          btn.style.border = 'none';
          const accentHsl =
            getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
          const accentColor = accentHsl ? `hsl(${accentHsl})` : '#b89968';
          btn.style.background = idx === selected ? accentColor : '#fefdfb';
          btn.style.color = idx === selected ? '#fefdfb' : '#5a4a3a';
          btn.style.cursor = 'pointer';
          btn.style.fontSize = '13px';
          btn.style.fontFamily = 'var(--font-sans)';
          btn.style.transition = 'all 0.15s ease';
          btn.style.flexShrink = '0';
          btn.onmouseenter = () => {
            // Only update selection on hover if not in keyboard mode
            if (container?.contains(btn) && !keyboardMode) {
              selected = idx;
              renderList(lastProps);
            }
          };
          btn.onmousemove = () => {
            // Exit keyboard mode when mouse moves
            if (container?.contains(btn) && keyboardMode) {
              keyboardMode = false;
              selected = idx;
              renderList(lastProps);
            }
          };
          btn.onmousedown = (e) => e.preventDefault();
          btn.onclick = () => { if (container?.contains(btn)) lastProps?.command(item); };
          if (idx === selected) selectedBtn = btn;
          list.appendChild(btn);
        });
        container.appendChild(list);
        // Keep the keyboard-selected item visible when navigating past the
        // visible window. `block: 'nearest'` avoids fighting page scroll.
        if (keyboardMode && selectedBtn) {
          (selectedBtn as HTMLButtonElement).scrollIntoView({ block: 'nearest' });
        }
      };

      const updatePosition = (clientRect?: () => DOMRect | null) => {
        const rect = clientRect?.();
        if (!rect || !container) {
          return;
        }
        container.style.position = 'fixed';
        container.style.zIndex = '9999';
        container.style.left = `${rect.left}px`;

        const MARGIN = 8;
        const viewportHeight = window.innerHeight;
        const roomBelow = viewportHeight - rect.bottom - MARGIN;
        const roomAbove = rect.top - MARGIN;
        const list = container.firstElementChild as HTMLDivElement | null;
        // Measure the menu's natural height; only fall back if not laid out yet.
        const naturalHeight = list?.scrollHeight ?? 220;

        // Flip up when the menu's actual height doesn't fit below the cursor
        // and there's more room above. Using measured height (not a fixed
        // threshold) is what gets a 9-item menu out of a 100px-from-bottom
        // cursor correctly.
        const fitsBelow = naturalHeight <= roomBelow;
        const shouldFlip = !fitsBelow && roomAbove > roomBelow;

        if (shouldFlip) {
          container.style.top = '';
          container.style.bottom = `${viewportHeight - rect.top + 2}px`;
          if (list) list.style.maxHeight = `${Math.max(roomAbove, 120)}px`;
        } else {
          container.style.bottom = '';
          container.style.top = `${rect.bottom + 2}px`;
          if (list) list.style.maxHeight = `${Math.max(roomBelow, 120)}px`;
        }
      };

      return {
        onStart: (props: { clientRect?: () => DOMRect | null }) => {
          container?.remove();
          selected = 0; keyboardMode = false;
          container = document.createElement('div');
          container.dataset.editorSuggestion = 'slash';
          document.body.appendChild(container);
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
          if (event.key === 'ArrowDown') {
            keyboardMode = true; // Enter keyboard mode
            selected = (selected + 1) % items.length;
            renderList(lastProps);
            return true;
          }
          if (event.key === 'ArrowUp') {
            keyboardMode = true; // Enter keyboard mode
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
          container?.remove(); container = null;
          items = []; lastProps = null; selected = 0; keyboardMode = false;
        },
      };
    },
    ...passthroughOverrides,
  }) as unknown as Extension;
}

export default createDefaultSlashMenu;
