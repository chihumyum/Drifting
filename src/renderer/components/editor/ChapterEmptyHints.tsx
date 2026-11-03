import type { Editor } from '@tiptap/core';
import { useEffect, useState } from 'react';
import { useEmptyStateHints } from '../../hooks/useEmptyStateHints';
import { EmptyStateHints } from '../ui/EmptyState';

/**
 * An empty chapter's paper, on the desktop: under where the first line goes,
 * the Markdown that starts a scene, a beat and a note, and the shortcuts for
 * finding things and for the timeline, written faintly like a watermark. The
 * first character typed takes it away; emptying the chapter brings it back.
 */
export function ChapterEmptyHints({ editor }: { editor: Editor }) {
  const hints = useEmptyStateHints();
  const [empty, setEmpty] = useState(() => editor.isEmpty);

  useEffect(() => {
    const update = () => setEmpty(editor.isEmpty);
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);

  if (!empty) return null;
  return (
    <div className="paper-empty-hints">
      <EmptyStateHints hints={hints.paper} />
    </div>
  );
}
