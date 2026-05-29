/**
 * CopilotEditorMount — bridges ChapterEditor (which has editor + projectId +
 * nodeId in scope) to useCopilot (which additionally requires a non-null
 * userId from auth). Returns null; its only purpose is to host the hook.
 *
 * The inner component pattern (CopilotMountInner) is what lets us call
 * useCopilot only after asserting userId and editor are non-null — useCopilot
 * uses useComment, which throws on empty userId, so it can't be
 * conditionally called from a component that may have userId === undefined.
 */
import type { Editor } from '@tiptap/core';
import { useAuthStore } from '../../store/auth';
import { useDataStore } from '../../store/data-store';
import { useSettingsStore } from '../../store/settings-store';
import { isDrift } from '../../domain/book-node';
import { useCopilot } from '../../hooks/useCopilot';
import { useTodoAutoParse } from '../../hooks/useTodoAutoParse';

interface CopilotEditorMountProps {
  editor: Editor | null;
  projectId: string;
  nodeId: string;
}

export function CopilotEditorMount({
  editor,
  projectId,
  nodeId,
}: CopilotEditorMountProps) {
  const userId = useAuthStore((s) => s.user?.id);
  // `.find` returns the node object itself (a stable reference until that node
  // changes), so this selector is safe — it won't churn renders the way a
  // freshly-built object would.
  const node = useDataStore((s) => s.bookNodes.find((n) => n.id === nodeId));
  const copilotInDrift = useSettingsStore((s) => s.copilotInDrift);

  if (!editor || !userId || !projectId || !nodeId) return null;
  // Drift editors are opt-in: skip the hook entirely (no debounced detect, no
  // suggestions) unless the user turned Copilot-in-drift on. Chapter editors
  // are unaffected.
  if (node && isDrift(node) && !copilotInDrift) return null;

  return (
    <CopilotMountInner
      editor={editor}
      projectId={projectId}
      nodeId={nodeId}
      userId={userId}
    />
  );
}

function CopilotMountInner({
  editor,
  projectId,
  nodeId,
  userId,
}: {
  editor: Editor;
  projectId: string;
  nodeId: string;
  userId: string;
}): null {
  useCopilot({ editor, projectId, nodeId, userId });
  useTodoAutoParse({ editor, projectId, nodeId, userId });
  return null;
}
