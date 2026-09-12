import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EntityKind } from '../../domain/entity-kinds';
import { extractOutlineFromDoc, serializeOutline, type OutlineItem } from '../../lib/outline';
import {
  getEditorSelectionSnapshot, hasEditorSelectionSnapshot, moveEditorSelectionToStart,
  restoreEditorSelectionSnapshot, saveEditorSelectionSnapshot,
} from '../../lib/editor-selection-memory';

export interface EditorPersistDerived {
  pmJson: string;
  outline: OutlineItem[];
  outlineJson: string;
}

export interface EditorSessionSource {
  projectId: string;
  sourceKind: EntityKind;
  sourceId: string;
}

interface SessionOptions {
  onPersist(editor: Editor, derived: EditorPersistDerived): void;
  selectionKey: string | null;
  autoFocus: boolean;
  isCommandActive: boolean;
}

export const EMPTY_EDITOR_SESSION_SNAPSHOT = { outline: [] as OutlineItem[], ready: false };
const PERSIST_DEBOUNCE_MS = 400;

/**
 * One canonical Tiptap instance + immutable source identity owns this binding.
 * The caller's YjsDocumentSession still owns CRDT durability. This owner only
 * derives/persists entity projections and retains the editor's selection.
 * Visibility never pauses persistence or replaces the editor/undo manager.
 */
export class EntityEditorSession {
  private options: SessionOptions | null = null;
  private attached = false;
  private initialized = false;
  private attachmentEpoch = 0;
  private initialViewPrepared = false;
  private presentationNeeded = false;
  private pendingPersist = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private selectionFrame = 0;
  private restoreFocusFrame = 0;
  private restoreFocusPending = false;
  private suppressSelectionSave = false;
  private outlineDoc: ProseMirrorNode | null = null;
  private derivedOutline: OutlineItem[] = [];
  private derivedOutlineJson = '[]';
  private publishedOutlineJson = '[]';
  private snapshot = EMPTY_EDITOR_SESSION_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  constructor(readonly editor: Editor, readonly source: Readonly<EditorSessionSource>) {}

  // A retiring owner keeps its own last callback. A new source cannot retarget
  // an old timeout or cleanup by overwriting a shared latest-callback ref.
  updateOptions(options: SessionOptions): void {
    this.options = options;
    this.scheduleRestoreFocus();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  needsPresentation = () => this.presentationNeeded;

  private readOutline(): void {
    if (this.outlineDoc === this.editor.state.doc) return;
    this.derivedOutline = extractOutlineFromDoc(this.editor.state.doc);
    this.derivedOutlineJson = serializeOutline(this.derivedOutline);
    this.outlineDoc = this.editor.state.doc;
  }

  private publishOutline(force = false): void {
    if (!this.presentationNeeded || !this.attached || !this.initialViewPrepared || this.editor.isDestroyed) return;
    this.readOutline();
    if (!force && this.snapshot.ready && this.derivedOutlineJson === this.publishedOutlineJson) return;
    this.publishedOutlineJson = this.derivedOutlineJson;
    this.snapshot = { outline: this.derivedOutline, ready: true };
    for (const listener of this.listeners) listener();
  }

  setPresentationNeeded(needed: boolean): void {
    if (this.presentationNeeded === needed) return;
    this.presentationNeeded = needed;
    // Called in a layout effect. Prepare the latest outline before the incoming
    // surface can report ready; a hidden session publishes no outline changes.
    if (needed) this.publishOutline(true);
    this.scheduleRestoreFocus();
  }

  private scheduleRestoreFocus(): void {
    if (!this.attached || !this.presentationNeeded || !this.options?.isCommandActive || !this.restoreFocusPending || this.editor.isDestroyed) {
      if (this.restoreFocusFrame) cancelAnimationFrame(this.restoreFocusFrame);
      this.restoreFocusFrame = 0;
      return;
    }
    if (this.restoreFocusFrame) return;
    const epoch = this.attachmentEpoch;
    this.restoreFocusFrame = requestAnimationFrame(() => {
      if (!this.attached || this.attachmentEpoch !== epoch) return;
      this.restoreFocusFrame = 0;
      if (!this.presentationNeeded || !this.options?.isCommandActive || this.editor.isDestroyed) return;
      this.restoreFocusPending = false;
      // An editor already focused by the user needs no restoration focus.
      if (this.editor.isFocused) return;
      this.editor.view.dispatch(this.editor.state.tr.scrollIntoView().setMeta('addToHistory', false));
      // The raw view focus is synchronous; Tiptap's focus command schedules a
      // second frame which would escape this session's cancellation boundary.
      this.editor.view.focus();
    });
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private persist(): void {
    if (!this.options || this.editor.isDestroyed) return;
    this.readOutline();
    const derived = {
      pmJson: JSON.stringify(this.editor.getJSON()),
      outline: this.derivedOutline,
      outlineJson: this.derivedOutlineJson,
    };
    this.pendingPersist = false;
    this.publishOutline();
    try {
      this.options.onPersist(this.editor, derived);
    } catch (error) {
      this.pendingPersist = true;
      throw error;
    }
  }

  private onUpdate = (): void => {
    if (!this.attached || this.editor.isDestroyed) return;
    this.pendingPersist = true;
    this.cancelTimer();
    this.timer = setTimeout(() => { this.timer = null; this.persist(); }, PERSIST_DEBOUNCE_MS);
    this.saveSelection();
  };
  private onSelectionUpdate = (): void => { this.saveSelection(); };
  private onBlur = (): void => { this.flush(); this.saveSelection(true); };
  private onDestroy = (): void => { this.detach(); };

  private saveSelection(force = false): void {
    const key = this.options?.selectionKey;
    if (!key || this.editor.isDestroyed || this.suppressSelectionSave) return;
    if (!force && !this.editor.isFocused && !hasEditorSelectionSnapshot(key)) return;
    saveEditorSelectionSnapshot(key, this.editor, true);
  }

  flush = (): void => {
    this.cancelTimer();
    if (this.pendingPersist) this.persist();
  };
  saveNow = (): void => {
    if (!this.attached) return;
    this.cancelTimer();
    this.persist();
  };

  attach(): () => void {
    if (this.attached) throw new Error('Editor session already attached');
    if (this.editor.isDestroyed || !this.options) return () => undefined;
    this.attached = true;
    const epoch = ++this.attachmentEpoch;
    this.editor.on('update', this.onUpdate);
    this.editor.on('selectionUpdate', this.onSelectionUpdate);
    this.editor.on('blur', this.onBlur);
    this.editor.on('destroy', this.onDestroy);
    if (!this.initialized) {
      this.initialized = true;
      const key = this.options.selectionKey;
      const selection = getEditorSelectionSnapshot(key);
      if (selection) {
        this.restoreFocusPending = restoreEditorSelectionSnapshot(key, this.editor) && selection.focusOnRestore;
      } else if (!this.options.autoFocus) {
        this.suppressSelectionSave = true;
        moveEditorSelectionToStart(this.editor);
        this.editor.commands.blur();
        this.selectionFrame = requestAnimationFrame(() => {
          this.selectionFrame = 0;
          this.suppressSelectionSave = false;
        });
      }
    }
    this.scheduleRestoreFocus();
    // Tiptap's BlockId view queues initial ID normalization during editor
    // construction. Prepare afterwards, still before revealing the surface,
    // so JSON headings never publish fallback anchors for one frame.
    queueMicrotask(() => {
      if (!this.attached || this.attachmentEpoch !== epoch) return;
      this.initialViewPrepared = true;
      this.publishOutline(true);
    });
    return () => this.detach();
  }

  detach(): void {
    if (!this.attached) return;
    try {
      this.flush();
      this.saveSelection();
    } finally {
      this.attached = false;
      this.attachmentEpoch += 1;
      this.cancelTimer();
      if (this.selectionFrame) cancelAnimationFrame(this.selectionFrame);
      this.selectionFrame = 0;
      if (this.restoreFocusFrame) cancelAnimationFrame(this.restoreFocusFrame);
      this.restoreFocusFrame = 0;
      this.suppressSelectionSave = false;
      this.editor.off('update', this.onUpdate);
      this.editor.off('selectionUpdate', this.onSelectionUpdate);
      this.editor.off('blur', this.onBlur);
      this.editor.off('destroy', this.onDestroy);
    }
  }
}
