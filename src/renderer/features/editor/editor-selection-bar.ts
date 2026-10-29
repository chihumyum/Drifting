import type { Editor } from '@tiptap/core';
import { getBlockFormatItems, getInlineFormatItems, type BlockFormatItem } from '../../lib/slash-menu/block-format-items';

// Kept as the root class so other surfaces (the touch shell's selection chip)
// can tell a bar is showing.
const BAR_CLASS = 'editor-comment-menu';
const activeBarSlot: { owner: EditorSelectionBar | null } = { owner: null };
// The bar waits for the selection to settle (a drag finished, a Shift+arrow
// run paused) before floating in.
const SETTLE_MS = 180;
const GAP = 8;
const MARGIN = 6;

export interface SelectionRect { left: number; top: number; right: number; bottom: number }

export interface EditorSelectionBarOptions {
  /** The selected text on screen; the bar floats above it (below when there is no room). */
  rect?: SelectionRect;
  onAddComment?: () => void;
  onAddPatch?: () => void;
  onCopilot?: () => void;
  labels: { format: string; addComment: string; addPatch: string; copilot: string };
}

/** The live DOM selection's box inside `editor`, falling back to ProseMirror coordinates. */
export function selectionRectOf(editor: Editor): SelectionRect {
  const { view } = editor;
  const domSelection = window.getSelection();
  if (domSelection && domSelection.rangeCount > 0 && view.dom.contains(domSelection.anchorNode)) {
    const box = domSelection.getRangeAt(0).getBoundingClientRect();
    if (box.width > 0 || box.height > 0) return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  }
  const { from, to } = view.state.selection;
  const start = view.coordsAtPos(from); const end = view.coordsAtPos(to);
  return { left: Math.min(start.left, end.left), top: Math.min(start.top, end.top),
    right: Math.max(start.right, end.right), bottom: Math.max(start.bottom, end.bottom) };
}

function place(bar: HTMLElement, rect: SelectionRect): 'above' | 'below' {
  const width = bar.offsetWidth; const height = bar.offsetHeight;
  const centre = (rect.left + rect.right) / 2;
  const left = Math.min(Math.max(MARGIN, centre - width / 2), window.innerWidth - MARGIN - width);
  const above = rect.top - GAP - height >= MARGIN;
  bar.style.left = `${Math.max(MARGIN, left)}px`;
  bar.style.top = `${above ? rect.top - GAP - height : rect.bottom + GAP}px`;
  return above ? 'above' : 'below';
}

/**
 * The editing actions for a text selection, as one horizontal bar floating
 * over the selected text: 「格式」 (whose block and inline formats unfold as a
 * second row beside the bar), add comment, new patch and Copilot. It appears
 * by itself once a selection settles; right-clicking is left to the system's
 * own menu. One canonical editor owns its bar; hidden/inactive owners are idle.
 */
export class EditorSelectionBar {
  private enabled = false;
  private disposed = false;
  private bar: HTMLDivElement | null = null;
  private hideTimer: number | null = null;
  private settleTimer: number | null = null;
  private pointerDown = false;

  /** `resolve` supplies the actions for the current selection, or null when there are none. */
  constructor(readonly editor: Editor, private readonly resolve?: () => EditorSelectionBarOptions | null) {}

  isEnabled(): boolean { return this.enabled && !this.disposed && !this.editor.isDestroyed && this.editor.isEditable; }
  setEnabled(enabled: boolean): void {
    const wasWatching = this.enabled && this.resolve;
    this.enabled = enabled;
    const watching = this.isEnabled() && this.resolve;
    if (watching && !wasWatching) this.watch();
    if (!watching && wasWatching) this.unwatch();
    if (!this.isEnabled()) this.close();
  }

  // ── Showing by itself once the selection settles ──────────────────────
  private onPointerDown = (): void => { this.pointerDown = true; this.cancelSettle(); };
  private onPointerUp = (): void => {
    if (!this.pointerDown) return;
    this.pointerDown = false; this.scheduleSettle();
  };
  private onSelection = (): void => { this.scheduleSettle(); };
  private watch(): void {
    this.editor.view.dom.addEventListener('mousedown', this.onPointerDown);
    window.addEventListener('mouseup', this.onPointerUp);
    this.editor.on('selectionUpdate', this.onSelection);
  }
  private unwatch(): void {
    this.cancelSettle(); this.pointerDown = false;
    if (!this.editor.isDestroyed) this.editor.view.dom.removeEventListener('mousedown', this.onPointerDown);
    window.removeEventListener('mouseup', this.onPointerUp);
    this.editor.off('selectionUpdate', this.onSelection);
  }
  private cancelSettle(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
  private scheduleSettle(): void {
    this.cancelSettle();
    if (this.pointerDown || this.editor.state.selection.empty) return;
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.pointerDown || this.bar || !this.isEnabled() || !this.editor.view.hasFocus()) return;
      const options = this.resolve?.();
      if (options) this.open(options);
    }, SETTLE_MS);
  }

  // ── The bar ───────────────────────────────────────────────────────────
  private cancelHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
  private onOutsideMouseDown = (event: MouseEvent): void => {
    if (!this.bar?.contains(event.target as Node)) this.close();
  };
  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); this.close(); }
  };

  close = (): void => {
    this.cancelHide();
    if (!this.bar) return;
    this.bar.remove(); this.bar = null;
    document.removeEventListener('mousedown', this.onOutsideMouseDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.editor.off('update', this.close);
    this.editor.off('selectionUpdate', this.close);
    this.editor.off('blur', this.close);
    this.editor.off('destroy', this.close);
    if (activeBarSlot.owner === this) activeBarSlot.owner = null;
  };

  dispose(): void {
    if (this.enabled && this.resolve) this.unwatch();
    this.disposed = true; this.enabled = false; this.close();
  }

  open(options: EditorSelectionBarOptions): boolean {
    if (!this.isEnabled() || this.editor.state.selection.empty) return false;
    activeBarSlot.owner?.close();
    const bar = document.createElement('div');
    bar.className = `${BAR_CLASS} editor-selection-bar`;
    bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-orientation', 'horizontal');
    this.bar = bar; activeBarSlot.owner = this;

    const invoke = (action: () => void): void => {
      // Detached/replaced buttons and queued events cannot act on an old editor.
      if (this.bar !== bar || activeBarSlot.owner !== this || !this.isEnabled()) return;
      this.close(); action();
    };
    const button = (label: string): HTMLButtonElement => {
      const element = document.createElement('button'); element.type = 'button';
      element.className = 'editor-selection-bar__item glass glass--surface';
      element.textContent = label;
      // Keep the selection: pressing a button must not move the caret.
      element.addEventListener('mousedown', event => event.preventDefault());
      return element;
    };
    const format = button(options.labels.format); format.classList.add('has-flyout');
    format.setAttribute('aria-haspopup', 'true');
    // The same brush chevron as BrushIcon renders, built by hand outside React.
    const chevron = document.createElement('i'); chevron.setAttribute('aria-hidden', 'true');
    chevron.className = 'brush-icon brush-icon--chevron-down is-inline editor-comment-menu__chevron';
    chevron.style.setProperty('--brush-icon-size', '8px');
    format.appendChild(chevron);
    const formats = document.createElement('div');
    formats.className = `${BAR_CLASS} editor-selection-bar editor-selection-bar__formats`;
    formats.setAttribute('role', 'toolbar'); formats.style.display = 'none';
    const addFormats = (items: BlockFormatItem[]): void => {
      for (const item of items) {
        const element = button(item.title);
        if (item.isActive?.(this.editor)) element.classList.add('is-active');
        element.addEventListener('click', () => invoke(() => item.run(this.editor)));
        formats.appendChild(element);
      }
    };
    addFormats(getBlockFormatItems());
    const separator = document.createElement('span');
    separator.className = 'editor-selection-bar__sep'; separator.setAttribute('aria-hidden', 'true');
    formats.appendChild(separator); addFormats(getInlineFormatItems());
    let side: 'above' | 'below' = 'above';
    const show = (): void => {
      if (this.bar !== bar || !this.isEnabled()) return;
      this.cancelHide(); formats.style.display = 'flex';
      // The formats unfold as a second row on the far side of the bar.
      const box = bar.getBoundingClientRect();
      const width = formats.offsetWidth; const height = formats.offsetHeight;
      const left = Math.min(Math.max(MARGIN, box.left), window.innerWidth - MARGIN - width);
      formats.style.left = `${left}px`;
      formats.style.top = `${side === 'above' ? box.top - 4 - height : box.bottom + 4}px`;
    };
    const scheduleHide = (): void => {
      if (this.bar !== bar) return;
      this.cancelHide();
      this.hideTimer = window.setTimeout(() => {
        this.hideTimer = null;
        if (this.bar === bar) formats.style.display = 'none';
      }, 140);
    };
    format.addEventListener('mouseenter', show); format.addEventListener('mouseleave', scheduleHide);
    format.addEventListener('click', show);
    formats.addEventListener('mouseenter', () => this.cancelHide()); formats.addEventListener('mouseleave', scheduleHide);
    bar.append(format, formats);
    for (const [label, action] of [
      [options.labels.addComment, options.onAddComment], [options.labels.addPatch, options.onAddPatch], [options.labels.copilot, options.onCopilot],
    ] as const) {
      if (!action) continue;
      const element = button(label); element.addEventListener('click', () => invoke(action)); bar.appendChild(element);
    }

    document.body.appendChild(bar);
    side = place(bar, options.rect ?? selectionRectOf(this.editor));
    // Every close path removes these exact listeners synchronously.
    document.addEventListener('mousedown', this.onOutsideMouseDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.editor.on('update', this.close);
    this.editor.on('selectionUpdate', this.close);
    this.editor.on('blur', this.close);
    this.editor.on('destroy', this.close);
    return true;
  }
}
