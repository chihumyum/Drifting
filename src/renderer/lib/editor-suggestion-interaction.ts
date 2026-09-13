import type { Editor, Range } from '@tiptap/core';
import Suggestion, { exitSuggestion, findSuggestionMatch, SuggestionPluginKey, type SuggestionOptions } from '@tiptap/suggestion';

/** One hook's canonical, visible command editor; does not own prose or focus. */
export class EditorSuggestionGate {
  private editor: Editor | null = null;
  private readonly listeners = new Set<() => void>();

  allows(editor: Editor): boolean { return this.editor === editor; }
  setEditor(editor: Editor | null): void {
    if (this.editor === editor) return;
    this.editor = editor;
    for (const listener of [...this.listeners]) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

type CommandArgs<Item> = Parameters<NonNullable<SuggestionOptions<Item>['command']>>[0];
type OwnedSuggestionOptions<Item> = Omit<SuggestionOptions<Item>, 'command'> & {
  gate?: EditorSuggestionGate;
  command?: (args: CommandArgs<Item>, stillCurrent: () => boolean) => void | Promise<void>;
};

/** Bound to the actual ProseMirror plugin view and its destroy lifecycle. */
export function createOwnedSuggestion<Item>(options: OwnedSuggestionOptions<Item>) {
  const { editor, gate, command, ...rest } = options;
  const pluginKey = options.pluginKey ?? SuggestionPluginKey;
  let disposed = false; let commandVersion = 0;
  let pendingGuard: (() => boolean) | null = null;
  let pendingRange: Range | null = null;
  const clearPending = () => { pendingGuard = null; pendingRange = null; };
  const invalidateCommand = () => { commandVersion++; clearPending(); };
  const available = () => !disposed && !editor.isDestroyed && editor.isEditable && editor.view.hasFocus() && (!gate || gate.allows(editor));
  const dismiss = () => {
    if (!disposed && !editor.isDestroyed && pluginKey.getState(editor.state)?.active) exitSuggestion(editor.view, pluginKey);
  };
  const invalidate = () => { invalidateCommand(); dismiss(); };
  const match = options.findSuggestionMatch ?? findSuggestionMatch;
  const plugin = Suggestion<Item>({
    ...rest, editor, pluginKey,
    // A hidden retained editor must not scan its current text block or build
    // suggestion items on remote/metadata transactions.
    findSuggestionMatch: args => available() ? match(args) : null,
    allow: args => available() && (options.allow?.(args) ?? true),
    command: args => {
      const state = pluginKey.getState(editor.state) as { active: boolean; range: Range } | undefined;
      if (!available() || !state?.active || state.range.from !== args.range.from || state.range.to !== args.range.to) return;
      invalidateCommand();
      const version = commandVersion;
      const { anchor, head } = editor.state.selection;
      const expectedText = editor.state.doc.textBetween(args.range.from, args.range.to, '\n', '\0');
      const parent = editor.state.doc.resolve(args.range.from).parent;
      const parentType = parent.type.name; const blockId = parent.attrs.id;
      // Keep only the bounded trigger text and scalar positions. Creating an
      // entity may add link marks to this query before its promise resolves;
      // that is safe, but a moved/replaced trigger or cursor is not.
      // Claim this invocation once and close its UI before asynchronous work.
      // An already-created element remains durable if its insertion is canceled.
      dismiss();
      const stillCurrent = () => {
        if (version !== commandVersion || !available() || editor.state.selection.anchor !== anchor || editor.state.selection.head !== head || args.range.to > editor.state.doc.content.size) return false;
        const currentParent = editor.state.doc.resolve(args.range.from).parent;
        return currentParent.type.name === parentType && currentParent.attrs.id === blockId && editor.state.doc.textBetween(args.range.from, args.range.to, '\n', '\0') === expectedText;
      };
      pendingGuard = stillCurrent;
      pendingRange = { ...args.range };
      try {
        const result = command?.(args, stillCurrent);
        if (result) return result.finally(() => { if (pendingGuard === stillCurrent) clearPending(); });
        if (pendingGuard === stillCurrent) clearPending();
      } catch (error) { clearPending(); throw error; }
    },
  });
  const stateField = plugin.spec.state!;
  const applyState = stateField.apply;
  stateField.apply = (transaction, value, oldState, newState) => {
    if (pendingRange && transaction.docChanged) {
      // Final text/positions can be identical after replacement. Inspect every
      // step before the view update, including appended transactions, so a
      // replacement cannot revive an old request. Mark-only maps stay empty.
      let { from, to } = pendingRange;
      for (const map of transaction.mapping.maps) {
        let touched = false;
        map.forEach((start, end) => {
          if ((start < to && end > from) || (start === end && start >= from && start <= to)) touched = true;
        });
        if (touched) { invalidateCommand(); break; }
        from = map.map(from, 1); to = map.map(to, -1);
      }
      if (pendingRange) pendingRange = { from, to };
    }
    const enabled = available();
    const next = applyState(transaction, value, oldState, newState);
    if (!enabled && !transaction.getMeta(pluginKey)?.exit) {
      // Returning no match while hidden avoids scanning prose, but Tiptap also
      // clears its dismissed range on that path. Keep only the mapped range so
      // blur/metadata transactions cannot reopen a dismissed trigger on return.
      const dismissed = value.active ? value.range : value.dismissedRange;
      if (dismissed) return { ...next, dismissedRange: {
        from: transaction.mapping.map(dismissed.from),
        to: transaction.mapping.map(dismissed.to),
      } };
    }
    return next;
  };
  const createView = plugin.spec.view;
  plugin.spec.view = view => {
    disposed = false;
    const inner = createView?.(view);
    const unsubscribe = gate?.subscribe(invalidate);
    view.dom.addEventListener('blur', invalidate);
    return {
      update(currentView, previousState) {
        // Once the context changes, undoing back to identical text must not
        // revive an old asynchronous action. This check runs only while pending.
        if (pendingGuard && !pendingGuard()) invalidateCommand();
        inner?.update?.(currentView, previousState);
      },
      destroy() {
        disposed = true; invalidateCommand();
        unsubscribe?.(); view.dom.removeEventListener('blur', invalidate);
        inner?.destroy?.();
      },
    };
  };
  const handleKeyDown = plugin.props.handleKeyDown;
  plugin.props.handleKeyDown = function(view, event) {
    if (event.key === 'Escape' || event.key === 'Esc') invalidateCommand();
    return handleKeyDown?.call(this, view, event) ?? false;
  };
  return plugin;
}
