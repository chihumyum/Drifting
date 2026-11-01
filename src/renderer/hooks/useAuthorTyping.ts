import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

import { getActiveEditor, subscribeActiveEditor } from '../lib/active-editor';

/**
 * True while the author is typing in the active editor, until `settleMs`
 * after the last keystroke. Only the author's own edits count: not
 * selection moves, writes kept out of undo history, or changes from sync.
 */
export function useAuthorTyping(settleMs: number): boolean {
  const [editor, setEditor] = useState<Editor | null>(() => getActiveEditor());
  const [typing, setTyping] = useState(false);

  useEffect(() => subscribeActiveEditor(setEditor), []);

  useEffect(() => {
    if (!editor) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (
        !transaction.docChanged ||
        transaction.getMeta('addToHistory') === false ||
        (transaction.getMeta('y-sync$') as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin
      ) {
        return;
      }
      setTyping(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTyping(false), settleMs);
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      if (timer) clearTimeout(timer);
      setTyping(false);
    };
  }, [editor, settleMs]);

  return typing;
}
