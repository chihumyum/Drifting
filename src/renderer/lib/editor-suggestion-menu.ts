import { kindMarkShape } from '../components/ui/kind-mark';
import type { BrushIconName } from '../components/ui/BrushIcon';

/**
 * The menu the editor's `/` and `@` suggestions open at the caret. It is the
 * shared menu (`.menu-surface`): rounded, its rim the resting glass line,
 * every row an icon and a label, groups parted by a hairline, the row the
 * arrow keys are on carrying the still ring (`is-current`). Built with the DOM
 * because the suggestion plugin renders outside React.
 */
export interface SuggestionMenuRow {
  label: string;
  /** A brush icon, or the kind mark of the entity the row inserts. */
  icon: BrushIconName | { kind: 'chapter' | 'element'; seed: string };
  /** Muted text at the row's far end (the kind of a mentioned entity). */
  trail?: string;
  /** Rows of a new group are parted from the previous ones by a hairline. */
  group: string;
}

function iconElement(icon: SuggestionMenuRow['icon']): HTMLElement {
  if (typeof icon === 'string') {
    const glyph = document.createElement('i');
    glyph.className = `brush-icon brush-icon--${icon}`;
    glyph.style.setProperty('--brush-icon-size', '16px');
    glyph.setAttribute('aria-hidden', 'true');
    return glyph;
  }
  const mark = document.createElement('span');
  mark.className = `kind-mark kind-mark--${icon.kind}`;
  mark.setAttribute('aria-hidden', 'true');
  const sand = document.createElement('i');
  sand.className = `sand sand--${kindMarkShape(icon.kind, icon.seed)}`;
  mark.appendChild(sand);
  return mark;
}

export function createSuggestionMenu(kind: 'slash' | 'mention', label: string) {
  const root = document.createElement('div');
  root.className = 'menu-surface editor-suggestion-menu';
  root.dataset.editorSuggestion = kind;
  root.setAttribute('role', 'listbox');
  root.setAttribute('aria-label', label);
  let buttons: HTMLButtonElement[] = [];

  return {
    root,
    /** Rebuild the rows; `onPick` runs a row, `onPoint` follows the pointer. */
    render(
      rows: SuggestionMenuRow[],
      handlers: { onPick: (index: number) => void; onPoint: (index: number, moved: boolean) => void },
      empty?: string,
    ) {
      root.replaceChildren();
      buttons = [];
      if (rows.length === 0 && empty) {
        const note = document.createElement('div');
        note.className = 'menu-surface__empty';
        note.textContent = empty;
        root.appendChild(note);
        return;
      }
      rows.forEach((row, index) => {
        if (index > 0 && rows[index - 1].group !== row.group) {
          const rule = document.createElement('div');
          rule.className = 'menu-surface__divider';
          root.appendChild(rule);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu-surface__item';
        button.setAttribute('role', 'option');
        const text = document.createElement('span');
        text.textContent = row.label;
        button.append(iconElement(row.icon), text);
        if (row.trail) {
          const trail = document.createElement('span');
          trail.className = 'menu-surface__trail';
          trail.textContent = row.trail;
          button.appendChild(trail);
        }
        // Keep the caret in the editor: the press never takes focus.
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = () => handlers.onPick(index);
        button.onmouseenter = () => handlers.onPoint(index, false);
        button.onmousemove = () => handlers.onPoint(index, true);
        buttons.push(button);
        root.appendChild(button);
      });
    },
    /** Mark the row the keyboard (or the pointer) is on; scroll it into view for the keys. */
    select(index: number, reveal: boolean) {
      buttons.forEach((button, i) => {
        const current = i === index;
        button.classList.toggle('is-current', current);
        button.setAttribute('aria-selected', String(current));
      });
      if (reveal) buttons[index]?.scrollIntoView({ block: 'nearest' });
    },
    /**
     * Below the caret, or above it when the menu's own height does not fit
     * below and there is more room above; scrolls inside what room it has.
     */
    place(rect: DOMRect) {
      const margin = 8;
      const viewportHeight = window.innerHeight;
      const roomBelow = viewportHeight - rect.bottom - margin;
      const roomAbove = rect.top - margin;
      root.style.position = 'fixed';
      root.style.zIndex = 'var(--z-context-menu)';
      root.style.left = `${Math.min(rect.left, window.innerWidth - root.offsetWidth - margin)}px`;
      const flip = root.scrollHeight > roomBelow && roomAbove > roomBelow;
      if (flip) {
        root.style.top = '';
        root.style.bottom = `${viewportHeight - rect.top + 2}px`;
        root.style.maxHeight = `${Math.max(roomAbove, 120)}px`;
      } else {
        root.style.bottom = '';
        root.style.top = `${rect.bottom + 2}px`;
        root.style.maxHeight = `${Math.max(roomBelow, 120)}px`;
      }
    },
  };
}
