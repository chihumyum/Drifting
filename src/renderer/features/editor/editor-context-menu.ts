import type { Editor } from '@tiptap/core';
import { getBlockFormatItems, getInlineFormatItems, type BlockFormatItem } from '../../lib/slash-menu/block-format-items';

const MENU_CLASS = 'editor-comment-menu';
const activeMenuSlot: { owner: EditorContextMenu | null } = { owner: null };

export interface EditorContextMenuOptions {
  clientX: number;
  clientY: number;
  onAddComment?: () => void;
  onAddPatch?: () => void;
  onCopilot?: () => void;
  labels: { format: string; addComment: string; addPatch: string; copilot: string };
}

function positionFlyout(menu: HTMLElement, row: HTMLElement, flyout: HTMLElement): void {
  const margin = 6;
  const menuRect = menu.getBoundingClientRect(); const rowRect = row.getBoundingClientRect();
  const width = flyout.offsetWidth || 140; const height = flyout.offsetHeight || 160;
  let left = menuRect.right + 2;
  if (left + width > window.innerWidth - margin) left = menuRect.left - width - 2;
  let top = rowRect.top - margin;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - height);
  flyout.style.left = `${Math.max(margin, left)}px`; flyout.style.top = `${top}px`;
}

/** One canonical editor owns its transient menu. Hidden/inactive owners are idle. */
export class EditorContextMenu {
  private enabled = false;
  private disposed = false;
  private menu: HTMLDivElement | null = null;
  private hideTimer: number | null = null;

  constructor(readonly editor: Editor) {}

  isEnabled(): boolean { return this.enabled && !this.disposed && !this.editor.isDestroyed && this.editor.isEditable; }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!this.isEnabled()) this.close();
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
  private onOutsideMouseDown = (event: MouseEvent): void => {
    if (!this.menu?.contains(event.target as Node)) this.close();
  };
  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); this.close(); }
  };

  close = (): void => {
    this.cancelHide();
    if (!this.menu) return;
    this.menu.remove(); this.menu = null;
    document.removeEventListener('mousedown', this.onOutsideMouseDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.editor.off('update', this.close);
    this.editor.off('selectionUpdate', this.close);
    this.editor.off('destroy', this.close);
    if (activeMenuSlot.owner === this) activeMenuSlot.owner = null;
  };

  dispose(): void {
    this.disposed = true; this.enabled = false; this.close();
  }

  open(options: EditorContextMenuOptions): boolean {
    if (!this.isEnabled()) return false;
    activeMenuSlot.owner?.close();
    const menu = document.createElement('div');
    menu.className = `${MENU_CLASS} menu-surface menu-surface--compact`;
    menu.setAttribute('role', 'menu'); menu.style.position = 'fixed';
    menu.style.left = `${options.clientX}px`; menu.style.top = `${options.clientY}px`;
    this.menu = menu; activeMenuSlot.owner = this;

    const invoke = (action: () => void): void => {
      // Detached/replaced buttons and queued events cannot act on an old editor.
      if (this.menu !== menu || activeMenuSlot.owner !== this || !this.isEnabled()) return;
      this.close(); action();
    };
    const button = (label: string): HTMLButtonElement => {
      const element = document.createElement('button'); element.type = 'button';
      element.className = 'menu-surface__item'; element.setAttribute('role', 'menuitem');
      element.textContent = label;
      element.addEventListener('mousedown', event => event.preventDefault());
      return element;
    };
    const format = button(options.labels.format); format.classList.add('has-flyout');
    const chevron = document.createElement('span'); chevron.className = 'editor-comment-menu__chevron'; chevron.textContent = '›';
    format.appendChild(chevron);
    const flyout = document.createElement('div');
    flyout.className = `${MENU_CLASS} menu-surface menu-surface--compact editor-comment-menu__flyout`;
    flyout.setAttribute('role', 'menu'); flyout.style.position = 'fixed'; flyout.style.display = 'none';
    const addFormats = (items: BlockFormatItem[]): void => {
      for (const item of items) {
        const element = button(item.title);
        if (item.isActive?.(this.editor)) element.classList.add('is-active');
        element.addEventListener('click', () => invoke(() => item.run(this.editor)));
        flyout.appendChild(element);
      }
    };
    addFormats(getBlockFormatItems());
    const separator = document.createElement('div');
    separator.className = 'menu-surface__separator editor-comment-menu__sep'; separator.setAttribute('role', 'separator');
    flyout.appendChild(separator); addFormats(getInlineFormatItems());
    const show = (): void => {
      if (this.menu !== menu || !this.isEnabled()) return;
      this.cancelHide(); flyout.style.display = 'flex'; positionFlyout(menu, format, flyout);
    };
    const scheduleHide = (): void => {
      if (this.menu !== menu) return;
      this.cancelHide();
      this.hideTimer = window.setTimeout(() => {
        this.hideTimer = null;
        if (this.menu === menu) flyout.style.display = 'none';
      }, 140);
    };
    format.addEventListener('mouseenter', show); format.addEventListener('mouseleave', scheduleHide);
    flyout.addEventListener('mouseenter', () => this.cancelHide()); flyout.addEventListener('mouseleave', scheduleHide);
    menu.append(format, flyout);
    for (const [label, action] of [
      [options.labels.addComment, options.onAddComment], [options.labels.addPatch, options.onAddPatch], [options.labels.copilot, options.onCopilot],
    ] as const) {
      if (!action) continue;
      const element = button(label); element.addEventListener('click', () => invoke(action)); menu.appendChild(element);
    }

    document.body.appendChild(menu);
    // contextmenu is a separate event from mousedown; no delayed registration
    // is needed. Every close path removes these exact listeners synchronously.
    document.addEventListener('mousedown', this.onOutsideMouseDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.editor.on('update', this.close);
    this.editor.on('selectionUpdate', this.close);
    this.editor.on('destroy', this.close);
    return true;
  }
}
