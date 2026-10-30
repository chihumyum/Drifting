import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

import { useDataStore } from '../store/data-store';
import { getPlatformRuntime } from '../platform/runtime';
import { hasLinkedTodo, taskItemAtSelection } from './note-todo-links';

/** Quiet time after typing before the bar comes back. */
const SETTLE_MS = 600;
const GAP = 8;
const MARGIN = 8;

/**
 * Checklist and table actions for the line the caret rests on. The bar
 * floats above that line (below it near the top of the window), portaled to
 * the body with `position: fixed`, so the note never reflows. It shows only
 * while the editor has focus and hides while the author types.
 */
export function NoteFloatingBar({
  editor,
  onPromote,
  onUnlink,
}: {
  editor: Editor;
  onPromote: () => void;
  onUnlink: () => void;
}) {
  const { t } = useTranslation();
  const context = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      if (!current || current.isDestroyed || !current.isFocused) return null;
      const task = taskItemAtSelection(current);
      const inTable = current.isActive('table');
      if (!task && !inTable) return null;
      return {
        head: current.state.selection.head,
        task: task
          ? { todoId: (task.node.attrs.todoId ?? null) as string | null, empty: !task.node.textContent.trim() }
          : null,
        inTable,
      };
    },
  });
  // A link to a TODO this device lacks (still syncing, or gone) acts as a
  // plain checkbox, which can be made a TODO again.
  const linked = useDataStore((data) => (context?.task ? hasLinkedTodo(context.task.todoId, data.comments) : false));

  const [typing, setTyping] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      // Only the author's typing hides the bar: not its own actions, TODO
      // link writes (kept out of undo history) or changes from sync.
      if (
        !transaction.docChanged ||
        transaction.getMeta('noteFloatingBar') ||
        transaction.getMeta('addToHistory') === false ||
        (transaction.getMeta('y-sync$') as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin
      ) {
        return;
      }
      setTyping(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTyping(false), SETTLE_MS);
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  const barRef = useRef<HTMLDivElement | null>(null);
  const visible = context !== null && !typing;
  const head = context?.head ?? null;
  // Placed on the DOM node directly: the bar measures itself against the
  // caret before it is shown.
  useLayoutEffect(() => {
    if (!visible || head === null) return undefined;
    const place = () => {
      const bar = barRef.current;
      if (!bar || editor.isDestroyed) return;
      let caret: { left: number; top: number; bottom: number };
      try {
        caret = editor.view.coordsAtPos(Math.min(head, editor.state.doc.content.size));
      } catch {
        return;
      }
      const { width, height } = bar.getBoundingClientRect();
      const above = caret.top - GAP - height;
      const top = above >= MARGIN ? above : caret.bottom + GAP;
      const left = Math.min(Math.max(MARGIN, caret.left - 16), window.innerWidth - width - MARGIN);
      bar.style.left = `${left}px`;
      bar.style.top = `${top}px`;
      bar.style.visibility = 'visible';
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [editor, head, visible, context?.inTable, context?.task, linked]);

  if (!visible || !context) return null;
  // Desktop: the prose selection bar's glass long pill (EditorSelectionBar),
  // each action one of its short pills, glass only under the pointer. The
  // paused mobile shell keeps its paper bar.
  const glass = !getPlatformRuntime().isMobileShell;
  const table = (label: string, command: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) =>
    button(label, () => command(editor.chain().focus().setMeta('noteFloatingBar', true)).run());
  const button = (label: string, onClick: () => void, disabled = false) => (
    <button
      key={label}
      type="button"
      className={glass ? 'editor-selection-bar__item glass glass--small' : undefined}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
  return createPortal(
    <div
      ref={barRef}
      className={glass ? 'note-floating-bar--glass editor-selection-bar glass glass--rest glass--surface' : 'note-floating-bar'}
      role="toolbar"
      aria-label={t(context.task ? 'materialEditor.todo.toolbar' : 'materialEditor.table.toolbar')}
      style={{ visibility: 'hidden', left: 0, top: 0 }}
    >
      {context.task &&
        (linked ? (
          <>
            <span className="note-floating-bar__status">{t('materialEditor.todo.linked')}</span>
            {button(t('materialEditor.todo.unlink'), onUnlink)}
          </>
        ) : (
          button(t('materialEditor.todo.promote'), onPromote, context.task.empty)
        ))}
      {context.task && context.inTable && (
        <span className={glass ? 'editor-selection-bar__sep' : 'note-floating-bar__divider'} aria-hidden />
      )}
      {context.inTable && (
        <>
          {table(t('materialEditor.table.addRow'), (chain) => chain.addRowAfter())}
          {table(t('materialEditor.table.addColumn'), (chain) => chain.addColumnAfter())}
          {table(t('materialEditor.table.deleteRow'), (chain) => chain.deleteRow())}
          {table(t('materialEditor.table.deleteColumn'), (chain) => chain.deleteColumn())}
          {table(t('materialEditor.table.headerRow'), (chain) => chain.toggleHeaderRow())}
          {table(t('materialEditor.table.deleteTable'), (chain) => chain.deleteTable())}
        </>
      )}
    </div>,
    document.body,
  );
}
